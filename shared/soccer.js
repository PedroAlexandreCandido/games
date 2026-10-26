import { add, sub, scale, length } from './vec.js';

export const SOCCER = {
  goalWidth: 200,
  creaseRadius: 90, // nobody may stand this close to any goal
  playerRadius: 22,
  playerSpeed: 340,
  dribbleSpeedMul: 0.85, // carrying the ball slows you a little
  ballRadius: 11,
  dribbleTime: 2.2, // seconds you can keep the ball before it runs loose
  looseSpeed: 160, // how hard the ball rolls away when a dribble runs out
  regainDelay: 0.7, // after losing or kicking the ball, before you can take it again
  tackleGrace: 0.6, // a new owner can't be tackled straight away
  trapSpeed: 650, // slower balls are controlled on touch; faster ones bounce off
  friction: 0.7, // fraction of speed lost per second while rolling
  rollingDrag: 60, // plus this much speed lost per second, so the ball stops
  wallBounce: 0.8,
  bodyBounce: 0.55,
  // Holding kick fills the gauge over riseTime, then empties it again, and repeats.
  riseTime: 0.8,
  perfectWindow: 0.07, // seconds either side of full that count as perfect
  minKick: 320, // a tap: a short pass
  maxKick: 950, // a full charge
  superKick: 1500, // released at exactly full
  maxBallSpeed: 1900,
  knockback: 750, // a super shot sends whoever it hits flying back this fast
  stunTime: 0.8,
  serveDistance: 200, // where players line up for kick-off, measured from their goal
};

// Gauge level (0..1) after holding kick for `held` seconds, and whether a
// release now is perfectly timed.
export function gauge(held) {
  const phase = held % (SOCCER.riseTime * 2);
  const level = phase <= SOCCER.riseTime ? phase / SOCCER.riseTime : 2 - phase / SOCCER.riseTime;
  return { level, perfect: Math.abs(phase - SOCCER.riseTime) <= SOCCER.perfectWindow };
}

export function kickSpeed(held) {
  const { level, perfect } = gauge(held);
  return { speed: perfect ? SOCCER.superKick : SOCCER.minKick + (SOCCER.maxKick - SOCCER.minKick) * level, perfect, level };
}

// The middle of each goal and its open mouth, measured along the side from side.a.
export function soccerGoal(side) {
  return {
    center: add(side.a, scale(side.t, side.length / 2)),
    mouth: { from: (side.length - SOCCER.goalWidth) / 2, to: (side.length + SOCCER.goalWidth) / 2 },
  };
}

// Nearest spot a player of `radius` may stand: inside the field and outside
// every live goal's crease. creases: list of goal centres.
export function clampPlayer(arena, creases, pos, radius) {
  for (let i = 0; i < 3; i++) {
    for (const c of creases) {
      const d = sub(pos, c);
      const dist = length(d);
      const min = SOCCER.creaseRadius + radius;
      if (dist < min && dist > 1e-6) pos = add(c, scale(d, min / dist));
    }
    for (const side of arena.sides) {
      const v = (pos.x - side.a.x) * side.n.x + (pos.y - side.a.y) * side.n.y;
      if (v < radius) pos = add(pos, scale(side.n, radius - v));
    }
  }
  return pos;
}
