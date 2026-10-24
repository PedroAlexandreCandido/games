import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Auth, AuthError, hashPassword, parseAdmins, SESSION_COOKIE } from '../server/auth.js';
import { createApp } from '../server/app.js';

const admins = parseAdmins(`pedro:${hashPassword('correct horse')},ana:${hashPassword('battery staple')}`);

test('ADMIN_USERS entries parse into accounts', () => {
  assert.deepEqual([...admins.keys()], ['pedro', 'ana']);
  assert.throws(() => parseAdmins('no-colon-here'));
});

test('login issues a session token that verifies until it expires', () => {
  const auth = new Auth({ admins, secret: 'k' });
  assert.throws(() => auth.login('pedro', 'wrong'), AuthError);
  assert.throws(() => auth.login('nobody', 'correct horse'), AuthError);
  const now = Date.now();
  const token = auth.login('pedro', 'correct horse', 'ip', now);
  assert.equal(auth.verify(token, now), 'pedro');
  assert.equal(auth.verify(token, now + 8 * 24 * 3600 * 1000), null, 'expired');
  assert.equal(new Auth({ admins, secret: 'other' }).verify(token, now), null, 'other secret');
  const [body, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ u: 'ana', exp: 9e9 })).toString('base64url');
  assert.equal(auth.verify(`${forged}.${mac}`), null, 'tampered body');
  assert.equal(auth.verify(`${body}.${mac}x`), null, 'tampered mac');
});

test('sessions end when the account is removed', () => {
  const token = new Auth({ admins, secret: 'k' }).login('ana', 'battery staple');
  const fewer = new Map([...admins].filter(([name]) => name !== 'ana'));
  assert.equal(new Auth({ admins: fewer, secret: 'k' }).verify(token), null);
});

test('repeated failures lock out that caller for a while', () => {
  const auth = new Auth({ admins });
  const now = Date.now();
  for (let i = 0; i < 10; i++) assert.throws(() => auth.login('pedro', 'nope', 'ip1', now));
  assert.throws(() => auth.login('pedro', 'correct horse', 'ip1', now), /Too many/);
  assert.ok(auth.login('pedro', 'correct horse', 'ip2', now), 'other callers unaffected');
  assert.ok(auth.login('pedro', 'correct horse', 'ip1', now + 16 * 60 * 1000), 'lockout ends');
});

test('over HTTP: log in, then the WebSocket knows the admin; other origins are refused', async () => {
  const { server } = createApp({ admins, sessionSecret: 'k' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const hello = (headers) => new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/ws`, { headers });
    ws.onmessage = (e) => {
      resolve(JSON.parse(e.data));
      ws.close();
    };
    ws.onclose = (e) => resolve({ closed: e.code });
    ws.onerror = () => {};
    setTimeout(() => reject(new Error('no hello')), 2000);
  });

  try {
    const bad = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'pedro', password: 'x' }),
    });
    assert.equal(bad.status, 401);

    const form = await fetch(`${base}/api/login`, { method: 'POST', body: 'username=pedro&password=correct+horse' });
    assert.equal(form.status, 415, 'form posts are refused');

    const res = await fetch(`${base}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'pedro', password: 'correct horse' }),
    });
    assert.equal(res.status, 200);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, new RegExp(`^${SESSION_COOKIE}=.+HttpOnly; SameSite=Lax`));
    const session = cookie.split(';')[0];

    const me = await (await fetch(`${base}/api/me`, { headers: { cookie: session } })).json();
    assert.deepEqual(me, { user: 'pedro', loginRequired: true });

    assert.deepEqual(await hello({ cookie: session }), { t: 'hello', user: 'pedro', loginRequired: true });
    assert.deepEqual(await hello({}), { t: 'hello', user: null, loginRequired: true });
    assert.deepEqual(await hello({ cookie: session, origin: 'https://evil.example' }), { closed: 1008 });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
