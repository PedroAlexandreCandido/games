// Plays server snapshots back on the server's own clock, a little in the past,
// blending the two either side of that moment. Networks (phone Wi-Fi above all)
// deliver updates in bursts, so the delay adapts to how late updates actually
// run: small on a steady link, larger on a bursty one.
const WINDOW_MS = 3000; // history used to estimate clock offset and jitter
const MIN_DELAY_MS = 35;
const MAX_DELAY_MS = 250;
const DELAY_MARGIN_MS = 20;
const MAX_EXTRAPOLATE_MS = 50; // keep moving this long when updates run late

function blend(a, b, k) {
  const mix = (x, y) => x + (y - x) * k;
  // Don't slide the ball across a serve reset or a jump.
  const smoothBall = a.ball.live && b.ball.live && Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y) < 120;
  return {
    ...b,
    time: mix(a.time, b.time),
    ball: smoothBall ? { ...b.ball, x: mix(a.ball.x, b.ball.x), y: mix(a.ball.y, b.ball.y) } : b.ball,
    players: b.players.map((p, i) => {
      const q = a.players[i];
      // Pong paddles have a length, air hockey mallets a radius.
      const size = p.r === undefined ? { len: mix(q.len, p.len) } : { r: mix(q.r, p.r) };
      return { ...p, x: mix(q.x, p.x), y: mix(q.y, p.y), ...size };
    }),
  };
}

export class SnapshotBuffer {
  constructor() {
    this.entries = []; // { ts, snap, events, done }, ordered by server time
    this.samples = []; // { at, lag } arrival time minus server send time
    this.delay = 100;
  }

  // ts: when the server sent this snapshot, on the server's clock (ms).
  push(ts, snap, events, at = performance.now()) {
    this.entries.push({ ts, snap, events, done: false });
    this.samples.push({ at, lag: at - ts });
    while (this.samples[0].at < at - WINDOW_MS) this.samples.shift();
  }

  // Fastest delivery seen recently: the best estimate of the clock offset
  // plus the network's base latency.
  #offset() {
    let min = Infinity;
    for (const s of this.samples) min = Math.min(min, s.lag);
    return min;
  }

  // How much later than the fastest update most updates arrive.
  #targetDelay(offset) {
    const late = this.samples.map((s) => s.lag - offset).sort((x, y) => x - y);
    const p95 = late[Math.floor(late.length * 0.95)] ?? 0;
    return Math.min(MAX_DELAY_MS, Math.max(MIN_DELAY_MS, p95 + DELAY_MARGIN_MS));
  }

  // The snapshot to draw at `now`, and the events that have come due.
  sample(now, dt = 0) {
    const list = this.entries;
    if (!list.length) return { snap: null, events: [] };
    const offset = this.#offset();
    // Ease towards the target so playback speed never visibly jumps.
    this.delay += (this.#targetDelay(offset) - this.delay) * Math.min(1, dt * 1.5);
    const t = now - offset - this.delay; // render time on the server clock

    const events = [];
    for (const entry of list) {
      if (!entry.done && entry.ts <= t) {
        events.push(...entry.events);
        entry.done = true;
      }
    }
    while (list.length > 2 && list[1].ts <= t) list.shift();

    const next = list.findIndex((e) => e.ts > t);
    if (next === 0) return { snap: list[0].snap, events };
    if (next === -1) {
      // Out of updates: carry on along the last motion briefly, then hold.
      if (list.length < 2) return { snap: list[0].snap, events };
      const [a, b] = list.slice(-2);
      const span = b.ts - a.ts || 1;
      return { snap: blend(a.snap, b.snap, 1 + Math.min(t - b.ts, MAX_EXTRAPOLATE_MS) / span), events };
    }
    const a = list[next - 1];
    const b = list[next];
    return { snap: blend(a.snap, b.snap, (t - a.ts) / (b.ts - a.ts)), events };
  }
}
