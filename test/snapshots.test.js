import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SnapshotBuffer } from '../public/js/snapshots.js';

// A ball moving at a steady 600 units/s, sent at 60 Hz.
const snapAt = (ms) => ({
  time: ms / 1000,
  phase: 'playing',
  ball: { x: ms * 0.6, y: 0, live: true },
  players: [{ x: 0, y: 0, len: 110 }],
});

// Server sends every ~16.7 ms; the network delivers in bursts every
// `burstMs`. Renders at 120 fps and returns the ball's per-frame movement.
function play(burstMs, seconds = 6) {
  const buffer = new SnapshotBuffer();
  const latency = 40;
  const sent = [];
  for (let ts = 0; ts < seconds * 1000; ts += 1000 / 60) sent.push(ts);
  const steps = [];
  let lastX = null;
  let i = 0;
  const frame = 1000 / 120;
  for (let now = 0; now < seconds * 1000 + latency + 300; now += frame) {
    // Everything sent before the latest burst boundary has arrived.
    const deliveredUpTo = Math.floor((now - latency) / burstMs) * burstMs;
    while (i < sent.length && sent[i] <= deliveredUpTo) {
      buffer.push(sent[i], snapAt(sent[i]), [], now);
      i++;
    }
    const { snap } = buffer.sample(now, frame / 1000);
    if (snap && now > 3000 && now < seconds * 1000) {
      if (lastX !== null) steps.push(snap.ball.x - lastX);
      lastX = snap.ball.x;
    }
  }
  return { steps, delay: buffer.delay };
}

test('motion stays smooth when updates arrive in 100 ms bursts', () => {
  const { steps, delay } = play(100);
  const expected = 600 / 120; // units per frame
  assert.ok(Math.min(...steps) > expected * 0.8, `no stalls (min step ${Math.min(...steps).toFixed(2)})`);
  assert.ok(Math.max(...steps) < expected * 1.2, `no jumps (max step ${Math.max(...steps).toFixed(2)})`);
  assert.ok(delay > 100 && delay < 160, `buffer grew to cover the bursts (${delay.toFixed(0)} ms)`);
});

test('a steady connection keeps the buffer small', () => {
  const { steps, delay } = play(1000 / 60);
  const expected = 600 / 120;
  assert.ok(Math.min(...steps) > expected * 0.8 && Math.max(...steps) < expected * 1.2);
  assert.ok(delay < 60, `small buffer (${delay.toFixed(0)} ms)`);
});
