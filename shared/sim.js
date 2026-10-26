import { vec, add, sub, scale, dot, length, normalize, rotate, clamp } from './vec.js';
import { buildArena } from './arena.js';
import { POWERUPS, rollPowerup, multipliers } from './powerups.js';
import { HOCKEY, hockeyZone, clampMallet } from './hockey.js';
import { SOCCER, soccerGoal, clampPlayer, kickSpeed } from './soccer.js';

export const MODES = ['pong', 'hockey', 'soccer'];

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
// bounces off them like a real puck. mode 'soccer': round players run
// anywhere outside the goal creases, dribble the ball and kick it with a
// charged shot.
//
// teams: 4 seats play 2 vs 2 on the 2-player field. Seats 0 and 2 defend goal
// 0, seats 1 and 3 goal 1; teammates share lives. A player's `team` is the
// goal they defend, which is just their seat outside team games, so
// players[side.seat] is always someone defending that side.
export class Game {
  constructor({ seats, lives = 5, mode = 'pong', teams = false, rng = Math.random }) {
    if (seats.length < 2 || seats.length > 4) throw new Error('A game needs 2 to 4 seats');
    if (!MODES.includes(mode)) throw new Error(`Unknown mode: ${mode}`);
    if (teams && seats.length !== 4) throw new Error('Team games need 4 seats');
    this.teams = teams;
    this.rng = rng;
    this.mode = mode;
    this.hockey = mode === 'hockey';
    this.soccer = mode === 'soccer';
    this.ballRadius = { pong: CONFIG.ballRadius, hockey: HOCKEY.puckRadius, soccer: SOCCER.ballRadius }[mode];
    this.arena = buildArena(teams ? 2 : seats.length);
    this.maxLives = lives;
    this.time = 0;
    this.phase = 'countdown'; // countdown → playing ⇄ serve → over
    this.timer = CONFIG.countdown;
    this.winner = null;
    this.events = [];
    this.players = seats.map((seat, i) => this.#createPlayer(seat, i, lives));
    // owner, ownedFor and super are soccer only: who is dribbling it and for how
    // long, and whether it was kicked with perfect timing.
    this.ball = {
      pos: vec(), dir: vec(1, 0), speed: CONFIG.ballSpeed, shotMul: 1, lastHitter: null, live: false, owner: null, ownedFor: 0, super: false,
    };
    this.powerups = [];
    this.nextPowerupId = 1;
    this.spawnTimer = this.#spawnDelay();
    this.sinceHit = 0;
  }

  // pong: -1, 0 or 1 along your side. hockey and soccer: { x, y } to move
  // that way (length up to 1), or { tx, ty } to head for that point, optionally
  // at a fraction `speed` of full speed. soccer also takes { charge: true } when
  // kick is pressed and { charge: false, held } on release, held being how
  // long the player held it in ms.
  setInput(seat, input) {
    const p = this.players[seat];
    if (this.mode === 'pong') {
      p.input = clamp(Math.round(Number(input) || 0), -1, 1);
      return;
    }
    const num = (v) => (Number.isFinite(v) ? v : 0);
    input = typeof input === 'object' && input ? input : {};
    if ('tx' in input) {
      p.input = { target: vec(num(input.tx), num(input.ty)), speed: clamp(num(input.speed ?? 1), 0, 1) };
    } else if (!this.soccer || 'x' in input) {
      // In soccer, a kick message on its own leaves movement as it was.
      const dir = vec(num(input.x), num(input.y));
      p.input = { dir: length(dir) > 1 ? normalize(dir) : dir };
    }
    if (this.soccer && typeof input.charge === 'boolean') this.#charge(p, input.charge, input.held);
  }

  #charge(p, on, held) {
    if (on) {
      p.chargeStart ??= this.time;
      return;
    }
    if (p.chargeStart === null) return;
    const measured = this.time - p.chargeStart;
    // Network jitter would spoil a perfectly timed release, so trust the
    // player's own measurement, within a little of what the server saw.
    p.pendingKick = Number.isFinite(held) ? clamp(held / 1000, 0, measured + 0.3) : measured;
    p.chargeStart = null;
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
    else if (this.soccer) this.#moveFootballers(dt);
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
      teams: this.teams,
      winner: this.winner,
      maxLives: this.maxLives,
      ball: {
        x: ball.pos.x, y: ball.pos.y, r: this.ballRadius, shotMul: ball.shotMul, lastHitter: ball.lastHitter, live: ball.live,
        ...(this.soccer && { owner: ball.owner, dribble: ball.ownedFor / SOCCER.dribbleTime, super: ball.super }),
      },
      players: this.players.map((p) => {
        const { side } = p;
        const c = p.pos ?? add(side.a, add(scale(side.t, p.s), scale(side.n, CONFIG.paddleInset)));
        const effects = {};
        for (const [type, until] of Object.entries(p.effects)) {
          if (until > this.time) effects[type] = until - this.time;
        }
        return {
          seat: p.seat, team: p.team, name: p.name, isBot: p.isBot, difficulty: p.difficulty,
          lives: p.lives, alive: p.alive,
          x: c.x, y: c.y, tx: side.t.x, ty: side.t.y, nx: side.n.x, ny: side.n.y,
          ...(p.pos ? { r: p.radius } : { len: p.len }), effects,
          ...(this.soccer && {
            fx: p.facing.x, fy: p.facing.y,
            charge: p.chargeStart === null ? null : this.time - p.chargeStart,
            stunned: p.stunUntil > this.time,
          }),
        };
      }),
      powerups: this.powerups.map((pu) => ({ id: pu.id, type: pu.type, x: pu.pos.x, y: pu.pos.y, age: pu.age, life: pu.life })),
    };
  }

  #createPlayer(seat, index, lives) {
    const { sides } = this.arena;
    const team = this.teams ? index % 2 : index;
    // Teammates' place on their side: 0 for the first, 1 for the second, null when alone.
    const slot = this.teams ? Math.floor(index / 2) : null;
    const i = sides.findIndex((s) => s.seat === team);
    const isGoal = (s) => s.kind === 'goal';
    const cornerGap = CONFIG.paddleInset + CONFIG.paddleThickness;
    const half = sides[i].length / 2;
    const zone = this.hockey ? hockeyZone(this.arena, team) : null;
    const player = {
      seat: index,
      team,
      slot,
      name: seat.name,
      isBot: Boolean(seat.isBot),
      difficulty: seat.difficulty ?? null,
      lives,
      alive: true,
      side: sides[i],
      // Paddles stay out of corners shared with another goal so neighbours
      // never overlap. Teammates each keep to their own half of the side.
      startGap: slot === 1 ? half : isGoal(sides[(i + sides.length - 1) % sides.length]) ? cornerGap : 0,
      endGap: slot === 0 ? half : isGoal(sides[(i + 1) % sides.length]) ? cornerGap : 0,
      s: slot === null ? half : half * (slot === 0 ? 0.5 : 1.5),
      len: CONFIG.paddleLength,
      input: this.mode === 'pong' ? 0 : { dir: vec() },
      effects: {},
      ...(zone && {
        zone,
        pos: add(zone.center, rotate(scale(zone.side.n, zone.minR + (zone.maxR - zone.minR) * 0.4), slot === null ? 0 : slot ? 0.6 : -0.6)),
        vel: vec(),
        radius: HOCKEY.malletRadius,
        lastHit: -1,
      }),
      ...(this.soccer && {
        goal: soccerGoal(sides[i]),
        vel: vec(),
        radius: SOCCER.playerRadius,
        facing: sides[i].n,
        chargeStart: null,
        pendingKick: null,
        noBallUntil: 0,
        stunUntil: 0,
        knock: vec(),
        lastHit: -1,
      }),
    };
    if (this.soccer) player.pos = this.#kickOffSpot(player);
    return player;
  }

  // Teammates line up side by side.
  #kickOffSpot(p) {
    const spot = add(soccerGoal(p.side).center, scale(p.side.n, SOCCER.serveDistance));
    return p.slot === null ? spot : add(spot, scale(p.side.t, p.slot ? 110 : -110));
  }

  #rivals(a, b) {
    return a.team !== b.team;
  }

  // Live goals' centres: nobody may stand in their creases.
  #creases() {
    return this.players.filter((p) => p.alive).map((p) => p.goal.center);
  }

  #moveFootballers(dt) {
    const creases = this.#creases();
    const alive = this.players.filter((p) => p.alive);
    for (const p of alive) {
      const m = multipliers(p.effects, this.time);
      p.radius += (SOCCER.playerRadius * m.size - p.radius) * Math.min(1, dt * 10);
      const carrying = this.ball.owner === p.seat;
      const top = SOCCER.playerSpeed * m.speed * (carrying ? SOCCER.dribbleSpeedMul : 1);
      let step = vec();
      if (p.stunUntil <= this.time) {
        if (p.input.target) {
          const delta = sub(p.input.target, p.pos);
          const dist = length(delta);
          if (dist > 0) step = scale(delta, Math.min(1, (top * p.input.speed * dt) / dist));
        } else {
          step = scale(p.input.dir, top * dt);
        }
        // The ball sits in front of you, the way you're heading.
        if (length(step) > 1e-3) p.facing = normalize(step);
      }
      // A super shot's knockback fades out quickly.
      step = add(step, scale(p.knock, dt));
      p.knock = scale(p.knock, Math.exp(-5 * dt));
      const pos = clampPlayer(this.arena, creases, add(p.pos, step), p.radius);
      p.vel = scale(sub(pos, p.pos), 1 / dt);
      p.pos = pos;
    }

    // Players shove each other apart.
    this.#separate(alive, (p, pos) => clampPlayer(this.arena, creases, pos, p.radius));

    for (const p of alive) {
      if (p.pendingKick === null) continue;
      if (this.ball.owner === p.seat && this.phase === 'playing') this.#kick(p, p.pendingKick);
      p.pendingKick = null;
    }
  }

  #kick(p, held) {
    const b = this.ball;
    const m = multipliers(p.effects, this.time);
    const { speed, perfect, level } = kickSpeed(held);
    b.owner = null;
    b.dir = p.facing;
    b.speed = Math.min(SOCCER.maxBallSpeed / m.shot, speed);
    b.shotMul = m.shot;
    b.super = perfect;
    b.lastHitter = p.seat;
    b.pos = add(p.pos, scale(p.facing, p.radius + this.ballRadius + 1));
    p.noBallUntil = this.time + 0.3;
    this.sinceHit = 0;
    this.events.push({ type: 'kick', seat: p.seat, level, perfect, shot: m.shot, x: b.pos.x, y: b.pos.y });
  }

  // Lets the ball go, rolling on the way it was heading.
  #loseBall(p, speed) {
    const b = this.ball;
    b.owner = null;
    b.dir = p.facing;
    b.speed = speed;
    b.shotMul = 1;
    p.noBallUntil = this.time + SOCCER.regainDelay;
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
    // Teammates share a zone, so their mallets bump into each other.
    this.#separate(this.players.filter((p) => p.alive), (p, pos) => clampMallet(this.arena, p.zone, pos, p.radius));
  }

  // Pushes overlapping round players apart, then lets `place` keep each one where it may stand.
  #separate(list, place) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        const d = sub(b.pos, a.pos);
        const dist = length(d);
        const overlap = a.radius + b.radius - dist;
        if (overlap <= 0) continue;
        const n = dist > 1e-6 ? scale(d, 1 / dist) : vec(1, 0);
        a.pos = place(a, sub(a.pos, scale(n, overlap / 2)));
        b.pos = place(b, add(b.pos, scale(n, overlap / 2)));
      }
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
    if (this.soccer) {
      if (b.owner !== null && this.#dribble(dt)) return;
      b.speed = Math.max(0, b.speed - (b.speed * SOCCER.friction + SOCCER.rollingDrag) * dt);
      if (b.speed * b.shotMul < SOCCER.maxKick * 0.8) b.super = false;
    }
    const steps = Math.max(1, Math.ceil((b.speed * b.shotMul * dt) / (this.ballRadius * 0.5)));
    const h = dt / steps;
    for (let i = 0; i < steps; i++) {
      b.pos = add(b.pos, scale(b.dir, b.speed * b.shotMul * h));
      const scored = this.hockey ? this.#collideHockey() : this.soccer ? this.#collideSoccer() : this.#collide();
      if (scored) return;
      if (this.soccer && b.owner !== null) break;
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

    if (this.#collideWalls(1)) return true;
    this.#touchPowerups();
    return false;
  }

  // Bounces off walls and goal posts, keeping `bounce` of the speed. Returns
  // true when the ball went in a goal mouth.
  #collideWalls(bounce) {
    const b = this.ball;
    const r = this.ballRadius;
    for (const side of this.arena.sides) {
      const rel = sub(b.pos, side.a);
      const v = dot(rel, side.n);
      const owner = side.kind === 'goal' ? this.players[side.seat] : null;
      const goal = owner?.alive ? (owner.zone ?? owner.goal).mouth : null;
      if (goal) {
        const u = dot(rel, side.t);
        if (u > goal.from && u < goal.to) {
          // In the mouth: only the posts at either end can stop it.
          for (const at of [goal.from, goal.to]) this.#bounceOffPoint(add(side.a, scale(side.t, at)), r, bounce);
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
        b.speed *= bounce;
        this.events.push({ type: 'wall', x: b.pos.x, y: b.pos.y });
      } else if (v < r) {
        b.pos = add(b.pos, scale(side.n, r - v));
      }
    }
    return false;
  }

  // Soccer: a dribbled ball rides in front of its owner until the dribble
  // runs out, the owner is knocked over, or someone tackles. Returns true
  // while it is still being carried.
  #dribble(dt) {
    const b = this.ball;
    const p = this.players[b.owner];
    b.ownedFor += dt;
    this.sinceHit = 0;
    if (!p.alive || p.stunUntil > this.time) {
      this.#loseBall(p, 0);
      return false;
    }
    if (b.ownedFor > SOCCER.dribbleTime) {
      this.#loseBall(p, SOCCER.looseSpeed);
      this.events.push({ type: 'loose', seat: p.seat, x: b.pos.x, y: b.pos.y });
      return false;
    }
    b.pos = add(p.pos, scale(p.facing, p.radius + this.ballRadius + 1));
    b.dir = p.facing;
    b.speed = 0;
    if (this.#collideWalls(SOCCER.wallBounce)) return true;
    if (b.ownedFor > SOCCER.tackleGrace) {
      for (const q of this.players) {
        if (!this.#rivals(q, p) || !this.#canTake(q)) continue;
        if (length(sub(q.pos, b.pos)) < q.radius + this.ballRadius) {
          p.noBallUntil = this.time + SOCCER.regainDelay;
          this.#take(q);
          this.events.push({ type: 'tackle', seat: q.seat, from: p.seat, x: b.pos.x, y: b.pos.y });
          break;
        }
      }
    }
    this.#touchPowerups();
    return true;
  }

  #canTake(p) {
    return p.alive && p.stunUntil <= this.time && p.noBallUntil <= this.time;
  }

  #take(p) {
    const b = this.ball;
    b.owner = p.seat;
    b.ownedFor = 0;
    b.lastHitter = p.seat;
    b.super = false;
    b.shotMul = 1;
    this.sinceHit = 0;
  }

  #collideSoccer() {
    const b = this.ball;
    const r = this.ballRadius;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = sub(b.pos, p.pos);
      const dist = length(d);
      if (dist >= r + p.radius) continue;
      const n = dist > 1e-6 ? scale(d, 1 / dist) : p.facing;
      const v = scale(b.dir, b.speed * b.shotMul);
      const vn = dot(sub(v, p.vel), n);
      if (b.super && vn < 0 && b.lastHitter !== null && this.#rivals(p, this.players[b.lastHitter])) {
        // A perfect shot bowls over whoever it hits.
        p.knock = scale(b.dir, SOCCER.knockback);
        p.stunUntil = this.time + SOCCER.stunTime;
        p.chargeStart = null;
        b.super = false;
        b.pos = add(p.pos, scale(n, r + p.radius));
        this.#bounceBall(sub(v, scale(n, (1 + SOCCER.bodyBounce) * vn)), 0.5);
        this.events.push({ type: 'knock', seat: p.seat, by: b.lastHitter, x: b.pos.x, y: b.pos.y });
        continue;
      }
      if (this.#canTake(p) && length(v) < SOCCER.trapSpeed) {
        this.#take(p);
        this.events.push({ type: 'trap', seat: p.seat, x: b.pos.x, y: b.pos.y });
        return false;
      }
      // Too fast to control, or not allowed yet: it bounces off.
      b.pos = add(p.pos, scale(n, r + p.radius));
      if (vn < 0) {
        this.#bounceBall(sub(v, scale(n, (1 + SOCCER.bodyBounce) * vn)), 1);
        b.lastHitter = p.seat;
        this.sinceHit = 0;
        if (this.time - p.lastHit > 0.15) this.events.push({ type: 'hit', seat: p.seat, shot: 1, x: b.pos.x, y: b.pos.y });
        p.lastHit = this.time;
      }
    }
    if (this.#collideWalls(SOCCER.wallBounce)) return true;
    this.#touchPowerups();
    return false;
  }

  // Sets the ball moving at `velocity` (scaled by `keep`), keeping its shot multiplier.
  #bounceBall(velocity, keep) {
    const b = this.ball;
    b.dir = normalize(velocity);
    b.speed = (length(velocity) * keep) / b.shotMul;
  }

  #bounceOffPoint(point, r, bounce = 1) {
    const b = this.ball;
    const d = sub(b.pos, point);
    const dist = length(d);
    if (dist >= r || dist < 1e-6) return;
    const n = scale(d, 1 / dist);
    const dn = dot(b.dir, n);
    if (dn < 0) {
      b.dir = sub(b.dir, scale(n, 2 * dn));
      b.speed *= bounce;
    }
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

  // p conceded: they (and their teammate) lose a life.
  #score(p) {
    const b = this.ball;
    this.events.push({ type: 'goal', seat: p.seat, side: p.team, x: b.pos.x, y: b.pos.y });
    for (const q of this.players.filter((x) => x.team === p.team)) {
      q.lives -= 1;
      if (q.lives > 0) continue;
      q.alive = false;
      q.effects = {};
      this.events.push({ type: 'eliminated', seat: q.seat });
    }
    const alive = this.players.filter((q) => q.alive);
    if (new Set(alive.map((q) => q.team)).size <= 1) {
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
    b.owner = null;
    b.super = false;
    if (this.soccer) {
      // Everyone lines up again for kick-off.
      for (const p of this.players) {
        p.pos = this.#kickOffSpot(p);
        p.facing = p.side.n;
        p.knock = vec();
        p.stunUntil = 0;
        p.chargeStart = null;
        p.pendingKick = null;
      }
    }
  }

  #serve() {
    const b = this.ball;
    const alive = this.players.filter((p) => p.alive);
    const target = alive[Math.floor(this.rng() * alive.length)];
    b.dir = rotate(scale(target.side.n, -1), (this.rng() * 2 - 1) * 0.4);
    b.pos = vec();
    // Soccer kicks off from a ball resting on the centre spot.
    b.speed = { pong: CONFIG.ballSpeed, hockey: HOCKEY.puckSpeed, soccer: 0 }[this.mode];
    b.shotMul = 1;
    b.lastHitter = null;
    b.live = true;
    this.phase = 'playing';
    this.sinceHit = 0;
  }

  #collect(pu, by) {
    const def = POWERUPS[pu.type];
    const targets = def.negative ? this.players.filter((p) => p.alive && this.#rivals(p, by)) : [by];
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
