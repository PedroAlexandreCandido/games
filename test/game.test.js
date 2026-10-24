import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArena } from '../shared/arena.js';
import { Game, CONFIG } from '../shared/sim.js';
import { Bot } from '../shared/bot.js';
import { POWERUPS, rollPowerup, NEGATIVE_CHANCE } from '../shared/powerups.js';
import { vec, sub, dot } from '../shared/vec.js';

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
