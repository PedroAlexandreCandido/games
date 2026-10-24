import { add, sub, scale, dot } from './vec.js';
import { CONFIG } from './sim.js';

// reaction: seconds between re-reading the ball. error: random aim offset as a
// fraction of half the paddle (above 1 can miss). bounces: wall bounces it can
// see ahead.
export const BOT_LEVELS = {
  easy: { reaction: 0.4, error: 1.3, bounces: 0 },
  medium: { reaction: 0.22, error: 0.8, bounces: 1 },
  hard: { reaction: 0.1, error: 0.45, bounces: 3 },
};

export class Bot {
  constructor(seat, difficulty = 'medium', rng = Math.random) {
    this.seat = seat;
    this.level = Object.hasOwn(BOT_LEVELS, difficulty) ? BOT_LEVELS[difficulty] : BOT_LEVELS.medium;
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
