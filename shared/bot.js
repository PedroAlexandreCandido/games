import { vec, add, sub, scale, dot, length, normalize, rotate, clamp } from './vec.js';
import { CONFIG } from './sim.js';
import { SOCCER, clampPlayer } from './soccer.js';
import { clampMallet } from './hockey.js';

// reaction: seconds between re-reading the ball. error: random aim offset as a
// fraction of half the paddle (above 1 can miss). bounces: wall bounces it can
// see ahead. Air hockey also uses speed (share of full mallet speed), lead
// (seconds it predicts the puck ahead) and miss (aim offset in world units).
// Soccer adds perfect (chance of a perfectly timed shot) and range (how close
// to goal it shoots from). In team games pass is the chance a pressed or
// distant player passes to an open teammate instead of shooting, and defend
// makes whoever isn't going for the ball hang back by the goal.
export const BOT_LEVELS = {
  easy: { reaction: 0.4, error: 1.3, bounces: 0, speed: 0.55, lead: 0, miss: 40, perfect: 0.05, range: 260, pass: 0.3, defend: false },
  medium: { reaction: 0.22, error: 0.8, bounces: 1, speed: 0.8, lead: 0.08, miss: 20, perfect: 0.2, range: 320, pass: 0.6, defend: false },
  hard: { reaction: 0.1, error: 0.45, bounces: 3, speed: 1, lead: 0.15, miss: 8, perfect: 0.4, range: 400, pass: 0.8, defend: true },
};

// Teammates keep at least this far apart unless one of them is on the ball.
const SPACING = { hockey: 110, soccer: 170 };
// The teammate going for the ball only hands that job over once the other is
// clearly closer, so the two don't keep swapping.
const ROLE_SWAP = 60;
const chasers = new WeakMap(); // game -> Map(team -> seat going for the ball)

function teammate(game, p) {
  return game.players.find((q) => q !== p && q.alive && q.team === p.team) ?? null;
}

// Whether p is the one on its team who goes for the ball at `ball`. Every
// bot on the team reads and updates the same choice, so they agree.
function isChaser(game, p, mate, ball) {
  let teams = chasers.get(game);
  if (!teams) chasers.set(game, (teams = new Map()));
  const dist = (q) => length(sub(q.pos, ball));
  let seat = teams.get(p.team);
  if (seat !== p.seat && seat !== mate.seat) seat = dist(p) <= dist(mate) ? p.seat : mate.seat;
  const [current, other] = seat === p.seat ? [p, mate] : [mate, p];
  if (dist(other) < dist(current) - ROLE_SWAP) seat = other.seat;
  teams.set(p.team, seat);
  return seat === p.seat;
}

// Moves `point` away from the teammate until they're `gap` apart. fit()
// returns the nearest spot the player may stand; when straight away from the
// teammate runs into a wall or crease, it steps round them sideways instead.
function keepApart(point, mate, gap, fit) {
  const d = sub(point, mate.pos);
  const dist = length(d);
  if (dist >= gap) return fit(point);
  const away = dist > 1e-6 ? scale(d, 1 / dist) : vec(1, 0);
  let best = null;
  for (const dir of [away, vec(-away.y, away.x), vec(away.y, -away.x)]) {
    const spot = fit(add(mate.pos, scale(dir, gap)));
    const room = length(sub(spot, mate.pos));
    if (room >= gap * 0.9) return spot;
    if (!best || room > best.room) best = { spot, room };
  }
  return best.spot;
}

// +1 or -1: which side of the line from `from` towards `to` the teammate is on.
function mateSide(from, to, mate) {
  const dir = sub(to, from);
  const m = sub(mate.pos, from);
  return dir.x * m.y - dir.y * m.x >= 0 ? 1 : -1;
}

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
    const band = zone.maxR - zone.minR;
    const guard = (towards, depth = 0.2) => add(zone.center, scale(normalize(sub(towards, zone.center)), zone.minR + band * depth));
    if (!this.seen) return this.#to(guard(vec()));

    const puck = add(this.seen.pos, scale(this.seen.vel, this.seen.age + level.lead));
    const away = normalize(sub(puck, zone.center));
    const mate = teammate(game, p);
    if (mate && !isChaser(game, p, mate, puck)) {
      // The teammate takes the puck. Hard bots sit deep between it and the
      // goal; the rest cover the wing on the far side from the teammate.
      const spot = level.defend
        ? guard(puck, 0.05)
        : add(zone.center, scale(rotate(away, -mateSide(zone.center, puck, mate) * 0.8), zone.minR + band * 0.35));
      return this.#to(keepApart(spot, mate, SPACING.hockey, (q) => clampMallet(game.arena, zone, q, p.radius)));
    }
    // Out of reach: wait for it, further forward when a teammate is covering behind.
    if (length(sub(puck, zone.center)) > zone.maxR + p.radius + 30) return this.#to(guard(puck, mate ? 0.55 : 0.2));

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
// and charges a shot, sometimes timing it perfectly. In a team only one of the
// pair goes for the ball; the other stays apart from it, supporting the attack
// or, on hard, hanging back to defend, and the one on the ball passes to it
// when it's better placed.
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
    this.passTo = null; // the teammate the current kick is meant for
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
    const mate = teammate(game, p);
    const ours = b.owner !== null && game.players[b.owner].team === p.team;
    if (mate && (ours || !isChaser(game, p, mate, ball))) return this.#support(game, p, mate, ball, ours);
    if (b.owner !== null) {
      // Someone is dribbling: stand on the line from them to our goal and close in.
      return this.#to(add(p.goal.center, scale(toBall, Math.max(guard, mine - 70))));
    }
    const nearest = game.players
      .filter((q) => q.alive)
      .every((q) => q === p || length(sub(q.pos, ball)) >= length(sub(p.pos, ball)) - 20);
    const onMySide = game.players.every((q) => !q.alive || q.team === p.team || length(sub(ball, q.goal.center)) >= mine);
    // In a team the one going for the ball always does; the teammate covers.
    if (mate || nearest || onMySide) return this.#to(ball);
    return this.#to(add(p.goal.center, scale(toBall, guard)));
  }

  // Off the ball in a team: keep away from the teammate. With the ball on our
  // side, get into space ahead of it; otherwise cover the goal, close in
  // behind the play, or on hard, hang back and defend.
  #support(game, p, mate, ball, ours) {
    const home = p.goal.center;
    const toBall = normalize(sub(ball, home));
    const fromHome = length(sub(ball, home));
    const guard = SOCCER.creaseRadius + p.radius + 40;
    const across = mateSide(home, ball, mate);
    let spot;
    if (this.level.defend) {
      // Stay between the ball and our goal, a little further up when we have it.
      spot = add(home, scale(toBall, clamp(fromHome * (ours ? 0.45 : 0.35), guard, ours ? 320 : 240)));
    } else if (ours) {
      // Run ahead towards the goal we're attacking, on the other side from the teammate.
      const forward = normalize(sub(this.goal, ball));
      spot = add(add(ball, scale(forward, 200)), scale(vec(-forward.y, forward.x), -across * 140));
    } else {
      // Sit goal-side of the ball, off to the far side, ready for a loose ball.
      spot = add(add(ball, scale(toBall, -150)), scale(vec(-toBall.y, toBall.x), -across * 130));
      if (length(sub(spot, home)) < guard) spot = add(home, scale(toBall, guard));
    }
    const creases = game.players.filter((q) => q.alive).map((q) => q.goal.center);
    return this.#to(keepApart(spot, mate, SPACING.soccer, (q) => clampPlayer(game.arena, creases, q, p.radius + 10)));
  }

  #attack(game, p, dt) {
    const { level } = this;
    const dist = length(sub(add(this.goal, this.aim), p.pos));
    const out = game.ball.ownedFor > SOCCER.dribbleTime - SOCCER.riseTime * 1.4;
    // A rival closing in: get a shot or pass away before the tackle.
    const pressed = game.players.some((q) => q.alive && q.team !== p.team && length(sub(q.pos, p.pos)) < p.radius + q.radius + 50);
    if (this.held === null && (dist < level.range || out || pressed)) {
      this.held = 0;
      const mate = dist < level.range * 0.7 ? null : this.#openMate(game, p, dist);
      if (mate && this.rng() < level.pass) {
        // A pass: just enough to reach them, so it can be trapped.
        this.passTo = mate.seat;
        const gap = length(sub(mate.pos, p.pos));
        this.holdFor = SOCCER.riseTime * clamp((gap - 200) / 900, 0.05, 0.45);
      } else {
        this.passTo = null;
        // Usually a hold that matches the distance; sometimes the perfect release.
        this.holdFor = this.rng() < level.perfect
          ? SOCCER.riseTime
          : SOCCER.riseTime * Math.min(0.9, 0.35 + dist / 900 + (this.rng() - 0.5) * 0.2);
      }
    }
    // Face where the kick is going: the teammate, a little ahead of them, or the goal.
    const mate = this.passTo !== null ? game.players[this.passTo] : null;
    const target = mate?.alive
      ? add(mate.pos, scale(normalize(sub(this.goal, mate.pos)), 40))
      : add(this.goal, this.aim);
    const move = this.#to(target);
    if (this.held === null) return move;
    this.held += dt;
    if (this.held < this.holdFor) return { ...move, charge: true };
    const held = this.held;
    this.held = null;
    this.passTo = null;
    return { ...move, charge: false, held: held * 1000 };
  }

  // A teammate worth passing to: nearer the goal than us, not too close or
  // far, and with no rival near the line between us.
  #openMate(game, p, dist) {
    const mate = teammate(game, p);
    if (!mate) return null;
    const gap = length(sub(mate.pos, p.pos));
    if (gap < 120 || gap > 600 || length(sub(this.goal, mate.pos)) > dist - 60) return null;
    const line = sub(mate.pos, p.pos);
    const blocked = game.players.some((q) => {
      if (!q.alive || q.team === p.team) return false;
      const along = clamp(dot(sub(q.pos, p.pos), line) / (gap * gap), 0, 1);
      return length(sub(q.pos, add(p.pos, scale(line, along)))) < q.radius + SOCCER.ballRadius + 25;
    });
    return blocked ? null : mate;
  }

  #to(point) {
    return { tx: point.x, ty: point.y, speed: this.level.speed };
  }
}
