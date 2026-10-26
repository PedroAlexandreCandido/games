import { vec, add, sub, scale, dot, length, normalize } from './vec.js';
import { CONFIG } from './sim.js';
import { SOCCER } from './soccer.js';

// reaction: seconds between re-reading the ball. error: random aim offset as a
// fraction of half the paddle (above 1 can miss). bounces: wall bounces it can
// see ahead. Air hockey also uses speed (share of full mallet speed), lead
// (seconds it predicts the puck ahead) and miss (aim offset in world units).
// Soccer adds perfect (chance of a perfectly timed shot) and range (how close
// to goal it shoots from).
export const BOT_LEVELS = {
  easy: { reaction: 0.4, error: 1.3, bounces: 0, speed: 0.55, lead: 0, miss: 40, perfect: 0.05, range: 260 },
  medium: { reaction: 0.22, error: 0.8, bounces: 1, speed: 0.8, lead: 0.08, miss: 20, perfect: 0.2, range: 320 },
  hard: { reaction: 0.1, error: 0.45, bounces: 3, speed: 1, lead: 0.15, miss: 8, perfect: 0.4, range: 400 },
};

const levelFor = (difficulty) => (Object.hasOwn(BOT_LEVELS, difficulty) ? BOT_LEVELS[difficulty] : BOT_LEVELS.medium);

export function createBot(mode, seat, difficulty, rng) {
  if (mode === 'hockey') return new HockeyBot(seat, difficulty, rng);
  if (mode === 'soccer') return new SoccerBot(seat, difficulty, rng);
  return new Bot(seat, difficulty, rng);
}

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
    if (best.side === player.side) return dot(sub(hit, best.side.a), best.side.t);
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
      const rivals = game.players.filter((q) => q.alive && q.team !== p.team);
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

// Chases a loose ball when it's nearest or the ball is on its side of the
// field, otherwise guards its goal. Against a dribbler it blocks the line to
// its goal and closes in. With the ball it runs at a rival's goal
// and charges a shot, sometimes timing it perfectly.
export class SoccerBot {
  constructor(seat, difficulty = 'medium', rng = Math.random) {
    this.seat = seat;
    this.level = levelFor(difficulty);
    this.rng = rng;
    this.think = 0;
    this.seen = null;
    this.aim = vec();
    this.goal = vec();
    this.held = null; // seconds spent charging the current kick
    this.holdFor = 0;
  }

  update(game, dt) {
    const p = game.players[this.seat];
    const { level } = this;
    if (!p.alive) return { x: 0, y: 0 };
    const b = game.ball;
    this.think -= dt;
    if (this.seen) this.seen.age += dt;
    if (this.think <= 0) {
      this.think = level.reaction * (0.7 + 0.6 * this.rng());
      this.seen = b.live ? { pos: b.pos, vel: scale(b.dir, b.speed * b.shotMul), age: 0 } : null;
      this.aim = scale(vec(this.rng() * 2 - 1, this.rng() * 2 - 1), level.miss * 2);
      if (b.owner !== this.seat) {
        const rivals = game.players.filter((q) => q.alive && q.team !== p.team);
        this.goal = rivals.length ? rivals[Math.floor(this.rng() * rivals.length)].goal.center : vec();
      }
    }

    if (b.owner === this.seat) return this.#attack(game, p, dt);
    if (this.held !== null) {
      // Lost the ball mid-charge: let go.
      this.held = null;
      return { x: 0, y: 0, charge: false, held: 0 };
    }
    if (!this.seen) return this.#to(add(p.goal.center, scale(p.side.n, SOCCER.serveDistance)));

    // The ball's path is a straight line that slows down; a short lead is enough.
    const ball = b.owner === null ? add(this.seen.pos, scale(this.seen.vel, Math.min(0.4, this.seen.age + level.lead))) : b.pos;
    const mine = length(sub(ball, p.goal.center));
    const toBall = normalize(sub(ball, p.goal.center));
    const guard = SOCCER.creaseRadius + p.radius + 40;
    if (b.owner !== null && game.players[b.owner].team === p.team) {
      // A teammate has it: run ahead towards the goal they're attacking, off to one side.
      const ahead = add(ball, scale(normalize(sub(this.goal, ball)), 180));
      return this.#to(add(ahead, scale(vec(-toBall.y, toBall.x), p.slot ? 120 : -120)));
    }
    if (b.owner !== null) {
      // Someone is dribbling: stand on the line from them to our goal and close in.
      return this.#to(add(p.goal.center, scale(toBall, Math.max(guard, mine - 70))));
    }
    const nearest = game.players
      .filter((q) => q.alive)
      .every((q) => q === p || length(sub(q.pos, ball)) >= length(sub(p.pos, ball)) - 20);
    const onMySide = game.players.every((q) => !q.alive || q.team === p.team || length(sub(ball, q.goal.center)) >= mine);
    if (nearest || onMySide) return this.#to(ball);
    return this.#to(add(p.goal.center, scale(toBall, guard)));
  }

  #attack(game, p, dt) {
    const { level } = this;
    const target = add(this.goal, this.aim);
    const dist = length(sub(target, p.pos));
    const out = game.ball.ownedFor > SOCCER.dribbleTime - SOCCER.riseTime * 1.4;
    // A rival closing in: get a shot or pass away before the tackle.
    const pressed = game.players.some((q) => q.alive && q.team !== p.team && length(sub(q.pos, p.pos)) < p.radius + q.radius + 50);
    if (this.held === null && (dist < level.range || out || pressed)) {
      this.held = 0;
      // Usually a hold that matches the distance; sometimes the perfect release.
      this.holdFor = this.rng() < level.perfect
        ? SOCCER.riseTime
        : SOCCER.riseTime * Math.min(0.9, 0.35 + dist / 900 + (this.rng() - 0.5) * 0.2);
    }
    const move = this.#to(target);
    if (this.held === null) return move;
    this.held += dt;
    if (this.held < this.holdFor) return { ...move, charge: true };
    const held = this.held;
    this.held = null;
    return { ...move, charge: false, held: held * 1000 };
  }

  #to(point) {
    return { tx: point.x, ty: point.y, speed: this.level.speed };
  }
}
