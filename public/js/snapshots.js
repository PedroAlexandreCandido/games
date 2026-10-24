// Shows the game slightly in the past, blending the two server snapshots on
// either side of that moment, so motion stays smooth despite network jitter.
const DELAY_MS = 60;

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
      return { ...p, x: mix(q.x, p.x), y: mix(q.y, p.y), len: mix(q.len, p.len) };
    }),
  };
}

export class SnapshotBuffer {
  constructor() {
    this.entries = [];
  }

  push(snap, events) {
    this.entries.push({ at: performance.now(), snap, events, done: false });
  }

  // The snapshot to draw at `now`, and the events that have come due.
  sample(now) {
    const t = now - DELAY_MS;
    const list = this.entries;
    const events = [];
    for (const entry of list) {
      if (!entry.done && entry.at <= t) {
        events.push(...entry.events);
        entry.done = true;
      }
    }
    while (list.length > 2 && list[1].at <= t) list.shift();
    if (!list.length) return { snap: null, events };
    const next = list.findIndex((e) => e.at > t);
    if (next === -1) return { snap: list.at(-1).snap, events };
    if (next === 0) return { snap: list[0].snap, events };
    const a = list[next - 1];
    const b = list[next];
    return { snap: blend(a.snap, b.snap, (t - a.at) / (b.at - a.at)), events };
  }
}
