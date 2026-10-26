import { vec, add, sub, scale, dot, length, normalize } from './vec.js';
import { CONFIG } from './sim.js';

// reaction: seconds between re-reading the ball. error: random aim offset as a
// fraction of half the paddle (above 1 can miss). bounces: wall bounces it can
// see ahead. Air hockey also uses speed (share of full mallet speed), lead
// (seconds it predicts the puck ahead) and miss (aim offset in world units).
export const BOT_LEVELS = {
  easy: { reaction: 0.4, error: 1.3, bounces: 0, speed: 0.55, lead: 0, miss: 40 },
  medium: { reaction: 0.22, error: 0.8, bounces: 1, speed: 0.8, lead: 0.08, miss: 20 },
  hard: { reaction: 0.1, error: 0.45, bounces: 3, speed: 1, lead: 0.15, miss: 8 },
};

const levelFor = (difficulty) => (Object.hasOwn(BOT_LEVELS, difficulty) ? BOT_LEVELS[difficulty] : BOT_LEVELS.medium);

export const createBot = (mode, seat, difficulty, rng) =>
  mode === 'hockey' ? new HockeyBot(seat, difficulty, rng) : new Bot(seat, difficulty, rng);

export class Bot {
  constructor(seat, difficulty = 'medium', rng = Math.random) {
    this.seat = seat;
    this.level = levelFor(difficulty);
    this.rng = rng;
    this.think = 0;
    this.target = null;
  }

  // Returns the paddle input (-1, 0 or 1) for this tick.
  update(game, dt) {
    const p = game.players[this.seat];
    if (!p.alive) return 0;
    this.think -= dt;
    if (this.think <= 0) {
      this.think = this.level.reaction * (0.7 + 0.6 * this.rng());
      const hit = predict(game, p, this.level.bounces);
      this.target = hit === null
        ? p.side.length / 2
        : hit + (this.rng() * 2 - 1) * this.level.error * (p.len / 2);
    }
    const diff = this.target - p.s;
    return Math.abs(diff) < p.len * 0.08 ? 0 : Math.sign(diff);
  }
}

// Traces the ball forward through wall bounces. Returns where along the
// player's side it will arrive, or null if it heads somewhere else first.
function predict(game, player, maxBounces) {
  const b = game.ball;
  if (!b.live) return null;
  const r = CONFIG.ballRadius;
  let pos = b.pos;
  let dir = b.dir;
  for (let bounce = 0; bounce <= maxBounces; bounce++) {
    let best = null;
    for (const side of game.arena.sides) {
      const dn = dot(dir, side.n);
      if (dn >= 0) continue;
      const owner = side.kind === 'goal' ? game.players[side.seat] : null;
      const isWall = !owner || !owner.alive;
      const offset = isWall ? r : CONFIG.paddleInset + CONFIG.paddleThickness / 2 + r;
      const t = Math.max(0, (offset - dot(sub(pos, side.a), side.n)) / dn);
      if (!best || t < best.t) best = { t, side, isWall, owner };
    }
    if (!best) return null;
    const hit = add(pos, scale(dir, best.t));
    if (best.owner === player) return dot(sub(hit, best.side.a), best.side.t);
    if (!best.isWall) return null;
    pos = hit;
    dir = sub(dir, scale(best.side.n, 2 * dot(dir, best.side.n)));
  }
  return null;
}

// Guards the crease while the puck is away, and when it comes into reach
// lines up behind it to shoot at a rival's goal. It reads the puck only every `reaction` seconds
// and guesses its path in between, so slower bots chase stale positions.
export class HockeyBot {
  constructor(seat, difficulty = 'medium', rng = Math.random) {
    this.seat = seat;
    this.level = levelFor(difficulty);
    this.rng = rng;
    this.think = 0;
    this.seen = null;
    this.aim = vec();
    this.goal = vec();
  }

  // Returns the mallet input for this tick: a point to head for.
  update(game, dt) {
    const p = game.players[this.seat];
    const { level } = this;
    if (!p.alive) return { x: 0, y: 0 };
    this.think -= dt;
    if (this.seen) this.seen.age += dt;
    if (this.think <= 0) {
      this.think = level.reaction * (0.7 + 0.6 * this.rng());
      const b = game.ball;
      this.seen = b.live ? { pos: b.pos, vel: scale(b.dir, b.speed * b.shotMul), age: 0 } : null;
      this.aim = scale(vec(this.rng() * 2 - 1, this.rng() * 2 - 1), level.miss);
      const rivals = game.players.filter((q) => q.alive && q !== p);
      this.goal = rivals.length ? rivals[Math.floor(this.rng() * rivals.length)].zone.center : vec();
    }

    const { zone } = p;
    const guard = (towards) => add(zone.center, scale(normalize(sub(towards, zone.center)), zone.minR + (zone.maxR - zone.minR) * 0.2));
    if (!this.seen) return this.#to(guard(vec()));

    const puck = add(this.seen.pos, scale(this.seen.vel, this.seen.age + level.lead));
    const away = normalize(sub(puck, zone.center));
    if (length(sub(puck, zone.center)) > zone.maxR + p.radius + 30) return this.#to(guard(puck));

    // Shoot at a rival's goal, unless that means hitting it back towards our own.
    let shot = normalize(sub(this.goal, puck));
    if (dot(shot, away) < -0.2) shot = away;
    // Lined up behind the puck: drive through it. Otherwise get there first.
    const toPuck = sub(puck, p.pos);
    const ahead = dot(toPuck, shot);
    const sideways = Math.abs(toPuck.x * shot.y - toPuck.y * shot.x);
    const reach = p.radius + game.ballRadius;
    const target = ahead > 0 && sideways < reach * 0.6
      ? add(puck, scale(shot, reach))
      : sub(puck, scale(shot, reach + 8));
    return this.#to(add(target, this.aim));
  }

  #to(point) {
    return { tx: point.x, ty: point.y, speed: this.level.speed };
  }
}
