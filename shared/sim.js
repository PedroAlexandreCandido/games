import { vec, add, sub, scale, dot, length, normalize, rotate, clamp } from './vec.js';
import { buildArena } from './arena.js';
import { POWERUPS, rollPowerup, multipliers } from './powerups.js';
import { HOCKEY, hockeyZone, clampMallet } from './hockey.js';

export const MODES = ['pong', 'hockey'];

export const CONFIG = {
  ballRadius: 9,
  ballSpeed: 430,
  maxBallSpeed: 950,
  speedUpPerHit: 1.04,
  maxBounceAngle: Math.PI / 3,
  paddleLength: 110,
  paddleThickness: 12,
  paddleInset: 22,
  paddleSpeed: 520,
  countdown: 3,
  serveDelay: 1.2,
  stallTimeout: 12,
  powerupRadius: 20,
  powerupLifetime: 12,
  powerupSpawnMin: 5,
  powerupSpawnMax: 10,
  maxPowerups: 3,
  powerupSpawnArea: 0.35, // fraction of the arena's inradius around the centre
};

// Authoritative game simulation. It has no DOM or clock dependencies so the
// server can run the same code: call setInput() per seat, step() with a fixed
// dt, then read snapshot() and drainEvents().
//
// mode 'pong': paddles slide along their goal side. mode 'hockey': round
// mallets move freely in a zone in front of a smaller goal, and the puck
// bounces off them like a real puck.
export class Game {
  constructor({ seats, lives = 5, mode = 'pong', rng = Math.random }) {
    if (seats.length < 2 || seats.length > 4) throw new Error('A game needs 2 to 4 seats');
    if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
    this.rng = rng;
    this.mode = mode;
    this.hockey = mode === 'hockey';
    this.ballRadius = this.hockey ? HOCKEY.puckRadius : CONFIG.ballRadius;
    this.arena = buildArena(seats.length);
    this.maxLives = lives;
    this.time = 0;
    this.phase = 'countdown'; // countdown → playing ⇄ serve → over
    this.timer = CONFIG.countdown;
    this.winner = null;
    this.events = [];
    this.players = seats.map((seat, i) => this.#createPlayer(seat, i, lives));
    this.ball = { pos: vec(), dir: vec(1, 0), speed: CONFIG.ballSpeed, shotMul: 1, lastHitter: null, live: false };
    this.powerups = [];
    this.nextPowerupId = 1;
    this.spawnTimer = this.#spawnDelay();
    this.sinceHit = 0;
  }

  // pong: -1, 0 or 1 along your side. hockey: { x, y } to move that way
  // (length up to 1), or { tx, ty } to head for that point, optionally at a
  // fraction `speed` of full speed.
  setInput(seat, input) {
    const p = this.players[seat];
    if (!this.hockey) {
      p.input = clamp(Math.round(Number(input) || 0), -1, 1);
      return;
    }
    const num = (v) => (Number.isFinite(v) ? v : 0);
    input = typeof input === 'object' && input ? input : {};
    if ('tx' in input) {
      p.input = { target: vec(num(input.tx), num(input.ty)), speed: clamp(num(input.speed ?? 1), 0, 1) };
    } else {
      const dir = vec(num(input.x), num(input.y));
      p.input = { dir: length(dir) > 1 ? normalize(dir) : dir };
    }
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }

  step(dt) {
    if (this.phase === 'over') return;
    this.time += dt;
    if (this.hockey) this.#moveMallets(dt);
    else this.#movePaddles(dt);
    if (this.phase === 'countdown' || this.phase === 'serve') {
      this.timer -= dt;
      if (this.timer <= 0) this.#serve();
    }
    if (this.phase !== 'countdown') this.#updatePowerups(dt);
    if (this.phase === 'playing') this.#moveBall(dt);
  }

  snapshot() {
    const { ball } = this;
    return {
      time: this.time,
      phase: this.phase,
      timer: this.timer,
      winner: this.winner,
      maxLives: this.maxLives,
      ball: { x: ball.pos.x, y: ball.pos.y, r: this.ballRadius, shotMul: ball.shotMul, lastHitter: ball.lastHitter, live: ball.live },
      players: this.players.map((p) => {
        const { side } = p;
        const c = this.hockey ? p.pos : add(side.a, add(scale(side.t, p.s), scale(side.n, CONFIG.paddleInset)));
        const effects = {};
        for (const [type, until] of Object.entries(p.effects)) {
          if (until > this.time) effects[type] = until - this.time;
        }
        return {
          seat: p.seat, name: p.name, isBot: p.isBot, difficulty: p.difficulty,
          lives: p.lives, alive: p.alive,
          x: c.x, y: c.y, tx: side.t.x, ty: side.t.y, nx: side.n.x, ny: side.n.y,
          ...(this.hockey ? { r: p.radius } : { len: p.len }), effects,
        };
      }),
      powerups: this.powerups.map((pu) => ({ id: pu.id, type: pu.type, x: pu.pos.x, y: pu.pos.y, age: pu.age, life: pu.life })),
    };
  }

  #createPlayer(seat, index, lives) {
    const { sides } = this.arena;
    const i = sides.findIndex((s) => s.seat === index);
    const isGoal = (s) => s.kind === 'goal';
    const cornerGap = CONFIG.paddleInset + CONFIG.paddleThickness;
    const zone = this.hockey ? hockeyZone(this.arena, index) : null;
    return {
      seat: index,
      name: seat.name,
      isBot: Boolean(seat.isBot),
      difficulty: seat.difficulty ?? null,
      lives,
      alive: true,
      side: sides[i],
      // Paddles stay out of corners shared with another goal so neighbours never overlap.
      startGap: isGoal(sides[(i + sides.length - 1) % sides.length]) ? cornerGap : 0,
      endGap: isGoal(sides[(i + 1) % sides.length]) ? cornerGap : 0,
      s: sides[i].length / 2,
      len: CONFIG.paddleLength,
      input: this.hockey ? { dir: vec() } : 0,
      effects: {},
      ...(zone && {
        zone,
        pos: add(zone.center, scale(zone.side.n, zone.minR + (zone.maxR - zone.minR) * 0.4)),
        vel: vec(),
        radius: HOCKEY.malletRadius,
        lastHit: -1,
      }),
    };
  }

  #moveMallets(dt) {
    for (const p of this.players) {
      if (!p.alive) continue;
      const m = multipliers(p.effects, this.time);
      p.radius += (HOCKEY.malletRadius * m.size - p.radius) * Math.min(1, dt * 10);
      const top = HOCKEY.malletSpeed * m.speed;
      let step = vec();
      if (p.input.target) {
        const delta = sub(p.input.target, p.pos);
        const dist = length(delta);
        // Arrive at the target without overshooting it.
        if (dist > 0) step = scale(delta, Math.min(1, (top * p.input.speed * dt) / dist));
      } else {
        step = scale(p.input.dir, top * dt);
      }
      const pos = clampMallet(this.arena, p.zone, add(p.pos, step), p.radius);
      p.vel = scale(sub(pos, p.pos), 1 / dt);
      p.pos = pos;
    }
  }

  #movePaddles(dt) {
    for (const p of this.players) {
      if (!p.alive) continue;
      const m = multipliers(p.effects, this.time);
      p.len += (CONFIG.paddleLength * m.size - p.len) * Math.min(1, dt * 10);
      p.s += p.input * CONFIG.paddleSpeed * m.speed * dt;
      p.s = clamp(p.s, p.startGap + p.len / 2, p.side.length - p.endGap - p.len / 2);
    }
  }

  #moveBall(dt) {
    const b = this.ball;
    if (this.hockey) b.speed = Math.max(HOCKEY.puckMinSpeed, b.speed * (1 - HOCKEY.friction * dt));
    const steps = Math.max(1, Math.ceil((b.speed * b.shotMul * dt) / (this.ballRadius * 0.5)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      b.pos = add(b.pos, scale(b.dir, b.speed * b.shotMul * h));
      if (this.hockey ? this.#collideHockey() : this.#collide()) return;
    }
    this.sinceHit += dt;
    if (this.sinceHit > CONFIG.stallTimeout) {
      this.events.push({ type: 'stall' });
      this.#startServe();
    }
  }

  // Returns true when a goal ended the rally.
  #collide() {
    const b = this.ball;
    const r = CONFIG.ballRadius;
    const face = CONFIG.paddleInset + CONFIG.paddleThickness / 2;
    const back = CONFIG.paddleInset - CONFIG.paddleThickness / 2;

    for (const p of this.players) {
      if (!p.alive) continue;
      const { side } = p;
      if (dot(b.dir, side.n) >= 0) continue;
      const rel = sub(b.pos, side.a);
      const u = dot(rel, side.t);
      const v = dot(rel, side.n);
      if (v - r > face || v < back) continue;
      if (Math.abs(u - p.s) > p.len / 2 + r) continue;
      this.#hitPaddle(p, u);
      b.pos = add(side.a, add(scale(side.t, u), scale(side.n, face + r)));
      return false;
    }

    for (const side of this.arena.sides) {
      if (side.kind === 'goal' && this.players[side.seat].alive) continue;
      const v = dot(sub(b.pos, side.a), side.n);
      const dn = dot(b.dir, side.n);
      if (v < r && dn < 0) {
        b.dir = sub(b.dir, scale(side.n, 2 * dn));
        b.pos = add(b.pos, scale(side.n, r - v));
        this.events.push({ type: 'wall', x: b.pos.x, y: b.pos.y });
      }
    }

    for (const p of this.players) {
      if (!p.alive) continue;
      if (dot(sub(b.pos, p.side.a), p.side.n) < -r) {
        this.#score(p);
        return true;
      }
    }

    this.#touchPowerups();
    return false;
  }

  #collideHockey() {
    const b = this.ball;
    const r = this.ballRadius;

    for (const p of this.players) {
      if (!p.alive) continue;
      const d = sub(b.pos, p.pos);
      const dist = length(d);
      if (dist >= r + p.radius) continue;
      const n = dist > 1e-6 ? scale(d, 1 / dist) : p.zone.side.n;
      b.pos = add(p.pos, scale(n, r + p.radius));
      // Bounce off the mallet in its own moving frame, so a swing adds speed.
      const v = scale(b.dir, b.speed);
      const vn = dot(sub(v, p.vel), n);
      if (vn < 0) this.#hitMallet(p, sub(v, scale(n, (1 + HOCKEY.restitution) * vn)));
    }

    for (const side of this.arena.sides) {
      const rel = sub(b.pos, side.a);
      const v = dot(rel, side.n);
      const goal = side.kind === 'goal' && this.players[side.seat].alive ? this.players[side.seat].zone.mouth : null;
      if (goal) {
        const u = dot(rel, side.t);
        if (u > goal.from && u < goal.to) {
          // In the mouth: only the posts at either end can stop it.
          for (const at of [goal.from, goal.to]) this.#bounceOffPoint(add(side.a, scale(side.t, at)), r);
          if (v < -r) {
            this.#score(this.players[side.seat]);
            return true;
          }
          continue;
        }
      }
      const dn = dot(b.dir, side.n);
      if (v < r && dn < 0) {
        b.dir = sub(b.dir, scale(side.n, 2 * dn));
        b.pos = add(b.pos, scale(side.n, r - v));
        this.events.push({ type: 'wall', x: b.pos.x, y: b.pos.y });
      }
    }

    this.#touchPowerups();
    return false;
  }

  #bounceOffPoint(point, r) {
    const b = this.ball;
    const d = sub(b.pos, point);
    const dist = length(d);
    if (dist >= r || dist < 1e-6) return;
    const n = scale(d, 1 / dist);
    const dn = dot(b.dir, n);
    if (dn < 0) b.dir = sub(b.dir, scale(n, 2 * dn));
    b.pos = add(point, scale(n, r));
    this.events.push({ type: 'wall', x: b.pos.x, y: b.pos.y });
  }

  #hitMallet(p, velocity) {
    const b = this.ball;
    const m = multipliers(p.effects, this.time);
    b.speed = clamp(length(velocity), HOCKEY.puckSpeed, HOCKEY.puckMaxSpeed);
    b.dir = normalize(velocity);
    b.shotMul = m.shot;
    b.lastHitter = p.seat;
    this.sinceHit = 0;
    // A mallet pushing the puck along touches it every tick; show one hit.
    if (this.time - p.lastHit > 0.15) this.events.push({ type: 'hit', seat: p.seat, shot: m.shot, x: b.pos.x, y: b.pos.y });
    p.lastHit = this.time;
  }

  #touchPowerups() {
    const b = this.ball;
    if (b.lastHitter === null) return;
    for (const pu of this.powerups) {
      if (length(sub(b.pos, pu.pos)) < this.ballRadius + CONFIG.powerupRadius) {
        this.#collect(pu, this.players[b.lastHitter]);
        break;
      }
    }
  }

  #hitPaddle(p, u) {
    const b = this.ball;
    const { side } = p;
    const m = multipliers(p.effects, this.time);
    // Where the ball lands on the paddle sets the bounce angle, like classic pong.
    const offset = clamp((u - p.s) / (p.len / 2), -1, 1);
    const angle = offset * CONFIG.maxBounceAngle;
    b.dir = add(scale(side.n, Math.cos(angle)), scale(side.t, Math.sin(angle)));
    b.speed = Math.min(CONFIG.maxBallSpeed, b.speed * CONFIG.speedUpPerHit);
    b.shotMul = m.shot;
    b.lastHitter = p.seat;
    this.sinceHit = 0;
    this.events.push({ type: 'hit', seat: p.seat, shot: m.shot, x: b.pos.x, y: b.pos.y });
  }

  #score(p) {
    const b = this.ball;
    p.lives -= 1;
    this.events.push({ type: 'goal', seat: p.seat, x: b.pos.x, y: b.pos.y });
    if (p.lives <= 0) {
      p.alive = false;
      p.effects = {};
      this.events.push({ type: 'eliminated', seat: p.seat });
    }
    const alive = this.players.filter((q) => q.alive);
    if (alive.length <= 1) {
      this.phase = 'over';
      this.winner = alive[0]?.seat ?? null;
      b.live = false;
      this.events.push({ type: 'win', seat: this.winner });
    } else {
      this.#startServe();
    }
  }

  #startServe() {
    const b = this.ball;
    this.phase = 'serve';
    this.timer = CONFIG.serveDelay;
    b.live = false;
    b.pos = vec();
    b.lastHitter = null;
    b.shotMul = 1;
  }

  #serve() {
    const b = this.ball;
    const alive = this.players.filter((p) => p.alive);
    const target = alive[Math.floor(this.rng() * alive.length)];
    b.dir = rotate(scale(target.side.n, -1), (this.rng() * 2 - 1) * 0.4);
    b.pos = vec();
    b.speed = this.hockey ? HOCKEY.puckSpeed : CONFIG.ballSpeed;
    b.shotMul = 1;
    b.lastHitter = null;
    b.live = true;
    this.phase = 'playing';
    this.sinceHit = 0;
  }

  #collect(pu, by) {
    const def = POWERUPS[pu.type];
    const targets = def.negative ? this.players.filter((p) => p.alive && p !== by) : [by];
    for (const t of targets) t.effects[pu.type] = this.time + def.duration;
    this.powerups = this.powerups.filter((x) => x !== pu);
    this.events.push({
      type: 'pickup', powerup: pu.type, by: by.seat, targets: targets.map((t) => t.seat), x: pu.pos.x, y: pu.pos.y,
    });
  }

  #updatePowerups(dt) {
    for (const pu of this.powerups) pu.age += dt;
    for (const pu of this.powerups.filter((x) => x.age >= x.life)) {
      this.events.push({ type: 'expire', powerup: pu.type, x: pu.pos.x, y: pu.pos.y });
    }
    this.powerups = this.powerups.filter((x) => x.age < x.life);

    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = this.#spawnDelay();
    if (this.powerups.length >= CONFIG.maxPowerups) return;
    const pos = this.#spawnPosition();
    if (!pos) return;
    const pu = { id: this.nextPowerupId++, type: rollPowerup(this.rng), pos, age: 0, life: CONFIG.powerupLifetime };
    this.powerups.push(pu);
    this.events.push({ type: 'spawn', powerup: pu.type, x: pos.x, y: pos.y });
  }

  #spawnDelay() {
    return CONFIG.powerupSpawnMin + this.rng() * (CONFIG.powerupSpawnMax - CONFIG.powerupSpawnMin);
  }

  #spawnPosition() {
    const radius = this.arena.inradius * CONFIG.powerupSpawnArea;
    for (let attempt = 0; attempt < 12; attempt++) {
      const pos = rotate(vec(Math.sqrt(this.rng()) * radius, 0), this.rng() * Math.PI * 2);
      const clear = this.powerups.every((pu) => length(sub(pu.pos, pos)) > CONFIG.powerupRadius * 3);
      if (clear) return pos;
    }
    return null;
  }
}
