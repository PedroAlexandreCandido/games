import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const SESSION_COOKIE = 'pong_session';
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const KEY_LENGTH = 32;

export class AuthError extends Error {}

// Stored form: scrypt$<salt hex>$<hash hex>
export function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  return `scrypt$${salt}$${scryptSync(String(password), salt, KEY_LENGTH).toString('hex')}`;
}

function verifyPassword(password, stored) {
  const [scheme, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt' || !salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(String(password), salt, KEY_LENGTH);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

// ADMIN_USERS: comma-separated "username:scrypt$salt$hash" entries, as printed
// by `npm run hash-password`.
export function parseAdmins(spec) {
  const admins = new Map();
  for (const entry of String(spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const at = entry.indexOf(':');
    if (at < 1) throw new Error(`Bad ADMIN_USERS entry: "${entry.slice(0, 20)}…"`);
    admins.set(entry.slice(0, at), entry.slice(at + 1));
  }
  return admins;
}

export function parseCookies(header) {
  const cookies = {};
  for (const part of String(header ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0) cookies[part.slice(0, eq).trim()] = decodeURIComponent(part.slice(eq + 1).trim());
  }
  return cookies;
}

// Admin accounts plus stateless sessions: a session is a signed, expiring
// token naming the user, kept in an HttpOnly cookie.
export class Auth {
  constructor({ admins = new Map(), secret = null } = {}) {
    this.admins = admins;
    this.secret = secret ?? randomBytes(32).toString('hex');
    this.attempts = new Map(); // client key → { count, resetAt }
    this.dummyHash = hashPassword('not-a-real-password');
  }

  // With no admin accounts configured, anyone may create rooms.
  get enabled() {
    return this.admins.size > 0;
  }

  // Returns a session token or throws AuthError. `key` identifies the caller
  // (their IP) for rate limiting.
  login(username, password, key = 'unknown', now = Date.now()) {
    const slot = this.attempts.get(key);
    if (slot && slot.resetAt > now && slot.count >= MAX_ATTEMPTS) {
      throw new AuthError('Too many attempts. Try again in a few minutes.');
    }
    const stored = this.admins.get(String(username));
    // Hash even for unknown users so response time doesn't reveal valid names.
    const ok = verifyPassword(password, stored ?? this.dummyHash) && stored !== undefined;
    if (!ok) {
      const fresh = !slot || slot.resetAt <= now;
      this.attempts.set(key, { count: fresh ? 1 : slot.count + 1, resetAt: fresh ? now + ATTEMPT_WINDOW_MS : slot.resetAt });
      throw new AuthError('Wrong username or password.');
    }
    this.attempts.delete(key);
    return this.#sign({ u: String(username), exp: Math.floor(now / 1000) + SESSION_SECONDS });
  }

  // The username in a valid, unexpired token for an account that still exists.
  verify(token, now = Date.now()) {
    const [body, mac] = String(token ?? '').split('.');
    if (!body || !mac) return null;
    const expected = Buffer.from(this.#mac(body));
    const given = Buffer.from(mac);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    try {
      const { u, exp } = JSON.parse(Buffer.from(body, 'base64url').toString());
      return exp * 1000 > now && this.admins.has(u) ? u : null;
    } catch {
      return null;
    }
  }

  userFromCookieHeader(header) {
    return this.verify(parseCookies(header)[SESSION_COOKIE]);
  }

  sessionCookie(token, secure) {
    return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? '; Secure' : ''}`;
  }

  clearedCookie(secure) {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
  }

  #sign(payload) {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${this.#mac(body)}`;
  }

  #mac(body) {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
