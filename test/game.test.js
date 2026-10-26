import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArena } from '../shared/arena.js';
import { Game, CONFIG } from '../shared/sim.js';
import { Bot, createBot } from '../shared/bot.js';
import { HOCKEY } from '../shared/hockey.js';
import { POWERUPS, rollPowerup, NEGATIVE_CHANCE } from '../shared/powerups.js';
import { vec, add, sub, scale, dot, length } from '../shared/vec.js';

// Deterministic RNG (mulberry32) so failures reproduce.
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const botSeats = (n, difficulty) => Array.from({ length: n }, (_, i) => ({ name: `Bot ${i + 1}`, isBot: true, difficulty }));

test('arena shapes match the player count', () => {
  const two = buildArena(2);
  assert.deepEqual(two.sides.map((s) => s.kind), ['wall', 'goal', 'wall', 'goal']);

  const three = buildArena(3);
  const goals = three.sides.filter((s) => s.kind === 'goal');
  const walls = three.sides.filter((s) => s.kind === 'wall');
  assert.equal(three.sides.length, 6);
  assert.equal(goals.length, 3);
  assert.ok(Math.min(...goals.map((s) => s.length)) > 2 * Math.max(...walls.map((s) => s.length)));

  const four = buildArena(4);
  assert.equal(four.sides.filter((s) => s.kind === 'goal').length, 4);

  for (const arena of [two, three, four]) {
    for (const side of arena.sides) assert.ok(dot(sub(vec(), side.a), side.n) > 0, 'normals point inward');
    const seats = arena.sides.filter((s) => s.kind === 'goal').map((s) => s.seat).sort();
    assert.deepEqual(seats, [...Array(arena.seatCount).keys()]);
  }
});

test('about 1 in 6 power-ups is negative', () => {
  const rng = seeded(7);
  const rolls = 60000;
  let negative = 0;
  for (let i = 0; i < rolls; i++) if (POWERUPS[rollPowerup(rng)].negative) negative++;
  assert.ok(Math.abs(negative / rolls - NEGATIVE_CHANCE) < 0.01);
});

for (const count of [2, 3, 4]) {
  test(`${count} bots play a match to a single winner with the ball kept in bounds`, () => {
    const rng = seeded(count * 101);
    const game = new Game({ seats: botSeats(count, 'easy'), lives: 3, rng });
    const bots = game.players.map((p) => new Bot(p.seat, 'easy', rng));
    const tick = 1 / 120;
    const seen = new Set();
    for (let i = 0; i < 120 * 60 * 30 && game.phase !== 'over'; i++) {
      for (const bot of bots) game.setInput(bot.seat, bot.update(game, tick));
      game.step(tick);
      for (const e of game.drainEvents()) seen.add(e.type);
      const { pos, live } = game.ball;
      assert.ok(Number.isFinite(pos.x) && Number.isFinite(pos.y));
      if (!live) continue;
      for (const side of game.arena.sides) {
        assert.ok(dot(sub(pos, side.a), side.n) > -CONFIG.ballRadius * 3, 'ball escaped the arena');
      }
    }
    assert.equal(game.phase, 'over');
    assert.equal(game.players.filter((p) => p.alive).length, 1);
    assert.equal(game.players[game.winner].alive, true);
    for (const type of ['hit', 'goal', 'spawn']) assert.ok(seen.has(type), `expected a ${type} event`);
  });
}

function playingGame(count) {
  const game = new Game({ seats: botSeats(count, 'medium'), rng: seeded(3) });
  game.phase = 'playing';
  game.ball.live = true;
  game.ball.lastHitter = 0;
  game.ball.dir = vec(0, 1);
  return game;
}

test('positive power-ups go to the last hitter', () => {
  const game = playingGame(4);
  game.powerups.push({ id: 1, type: 'growth', pos: vec(0, 4), age: 0, life: 12 });
  game.step(1 / 120);
  const [pickup] = game.drainEvents().filter((e) => e.type === 'pickup');
  assert.deepEqual(pickup.targets, [0]);
  assert.ok(game.players[0].effects.growth > game.time);
  assert.equal(game.players[1].effects.growth, undefined);
  for (let i = 0; i < 120; i++) game.step(1 / 120);
  assert.ok(game.players[0].len > CONFIG.paddleLength * 1.4);
});

test('negative power-ups hit every other player', () => {
  const game = playingGame(3);
  game.powerups.push({ id: 1, type: 'slow', pos: vec(0, 4), age: 0, life: 12 });
  game.step(1 / 120);
  assert.equal(game.players[0].effects.slow, undefined);
  assert.ok(game.players[1].effects.slow > game.time);
  assert.ok(game.players[2].effects.slow > game.time);
});

test('the ball passes through power-ups before anyone has hit it', () => {
  const game = playingGame(2);
  game.ball.lastHitter = null;
  game.powerups.push({ id: 1, type: 'boost', pos: vec(0, 4), age: 0, life: 12 });
  game.step(1 / 120);
  assert.equal(game.powerups.length, 1);
});

test('power doubles the speed of the next shot', () => {
  const game = playingGame(2);
  const p = game.players[0];
  p.effects.power = game.time + 10;
  const side = p.side;
  // Put the ball just in front of the left paddle, heading into it.
  game.ball.pos = vec(side.a.x + CONFIG.paddleInset + CONFIG.paddleThickness / 2 + CONFIG.ballRadius + 1, 0);
  game.ball.dir = vec(-1, 0);
  p.s = side.length / 2;
  game.step(1 / 120);
  const hit = game.drainEvents().find((e) => e.type === 'hit');
  assert.equal(hit.seat, 0);
  assert.equal(game.ball.shotMul, 2);
  assert.ok(game.ball.dir.x > 0);
});

// ---- Air hockey ----

for (const count of [2, 3, 4]) {
  test(`air hockey: ${count} bots play to a winner, mallets stay in their zones`, () => {
    const rng = seeded(count * 17);
    const game = new Game({ seats: botSeats(count, 'medium'), lives: 2, mode: 'hockey', rng });
    const bots = game.players.map((p) => createBot('hockey', p.seat, 'medium', rng));
    const tick = 1 / 120;
    const seen = new Set();
    for (let i = 0; i < 120 * 60 * 30 && game.phase !== 'over'; i++) {
      for (const bot of bots) game.setInput(bot.seat, bot.update(game, tick));
      game.step(tick);
      for (const e of game.drainEvents()) seen.add(e.type);
      for (const p of game.players.filter((q) => q.alive)) {
        const d = length(sub(p.pos, p.zone.center));
        assert.ok(d > p.zone.minR - 1 && d < p.zone.maxR + 1, 'mallet left its zone');
      }
      if (!game.ball.live) continue;
      for (const side of game.arena.sides) {
        assert.ok(dot(sub(game.ball.pos, side.a), side.n) > -HOCKEY.puckRadius * 3, 'puck escaped the arena');
      }
    }
    assert.equal(game.phase, 'over');
    for (const type of ['hit', 'goal', 'spawn']) assert.ok(seen.has(type), `expected a ${type} event`);
  });
}

function hockeyGame() {
  const game = new Game({ seats: botSeats(2, 'medium'), mode: 'hockey', rng: seeded(5) });
  game.phase = 'playing';
  game.ball.live = true;
  return game;
}

test('air hockey: only the goal mouth scores; the rest of the goal side is wall', () => {
  const game = hockeyGame();
  const { side, mouth } = game.players[0].zone;
  game.players[0].pos = add(game.players[0].zone.center, scale(side.n, 250)); // out of the way
  const shoot = (u) => {
    game.ball.pos = add(side.a, add(scale(side.t, u), scale(side.n, 30)));
    game.ball.dir = scale(side.n, -1);
    game.drainEvents();
    for (let i = 0; i < 30; i++) game.step(1 / 120);
    return game.drainEvents().map((e) => e.type);
  };
  assert.ok(shoot(mouth.from - 40).includes('wall'));
  assert.equal(game.players[0].lives, 5);
  assert.ok(shoot((mouth.from + mouth.to) / 2).includes('goal'));
  assert.equal(game.players[0].lives, 4);
});

test('air hockey: a moving mallet sends the puck off faster, and power doubles it', () => {
  const game = hockeyGame();
  const p = game.players[0];
  p.effects.power = game.time + 10;
  game.ball.pos = add(p.pos, scale(p.zone.side.n, p.radius + HOCKEY.puckRadius + 4));
  game.ball.dir = scale(p.zone.side.n, -1);
  game.ball.speed = HOCKEY.puckMinSpeed;
  game.setInput(0, { tx: game.ball.pos.x, ty: game.ball.pos.y });
  for (let i = 0; i < 3; i++) game.step(1 / 120);
  const hit = game.drainEvents().find((e) => e.type === 'hit');
  assert.equal(hit.seat, 0);
  assert.equal(game.ball.shotMul, 2);
  assert.ok(dot(game.ball.dir, p.zone.side.n) > 0.9, 'puck heads away from the goal');
  assert.ok(game.ball.speed > HOCKEY.puckSpeed);
});

test('air hockey: bad input is ignored, and keys move at most full speed', () => {
  const game = hockeyGame();
  const start = game.players[0].pos;
  for (const bad of [null, 'x', { tx: 'a' }, { x: NaN, y: Infinity }]) game.setInput(0, bad);
  game.setInput(0, { x: 50, y: 0 });
  assert.ok(length(game.players[0].input.dir) <= 1);
  game.step(1 / 120);
  assert.ok(length(sub(game.players[0].pos, start)) <= HOCKEY.malletSpeed / 120 + 1e-6);
});
