import { add, sub, scale, length } from './vec.js';
import { sideForSeat } from './arena.js';

export const HOCKEY = {
  goalWidth: 240, // the open mouth in the middle of each goal side
  creaseRadius: 100, // mallets can't come closer than this to their own goal
  malletRadius: 28,
  malletSpeed: 720,
  maxSizeMul: 1.5, // largest mallet growth, so neighbours' zones never overlap
  puckRadius: 13,
  puckSpeed: 380, // serve speed, and the least a mallet hit sends it
  puckMinSpeed: 240, // friction never slows the puck below this
  puckMaxSpeed: 1100,
  friction: 0.25, // fraction of speed lost per second
  restitution: 0.9,
};

// Where a seat's mallet may go: a band between minR and maxR around the
// middle of its goal, inside the arena. mouth is the open stretch of the goal
// side, measured along it from side.a.
export function hockeyZone(arena, seat) {
  const side = sideForSeat(arena, seat);
  const center = add(side.a, scale(side.t, side.length / 2));
  const others = arena.sides
    .filter((s) => s.kind === 'goal' && s !== side)
    .map((s) => length(sub(add(s.a, scale(s.t, s.length / 2)), center)));
  const maxR = Math.min(arena.inradius * 0.9, Math.min(...others) / 2 - HOCKEY.malletRadius * HOCKEY.maxSizeMul);
  return {
    side,
    center,
    minR: HOCKEY.creaseRadius,
    maxR,
    mouth: { from: (side.length - HOCKEY.goalWidth) / 2, to: (side.length + HOCKEY.goalWidth) / 2 },
  };
}

// Nearest allowed spot for a mallet of `radius` wanting to be at `pos`.
export function clampMallet(arena, zone, pos, radius) {
  for (let i = 0; i < 3; i++) {
    const d = sub(pos, zone.center);
    const dist = length(d);
    const dirOut = dist > 1e-6 ? scale(d, 1 / dist) : zone.side.n;
    if (dist < zone.minR) pos = add(zone.center, scale(dirOut, zone.minR));
    else if (dist > zone.maxR) pos = add(zone.center, scale(dirOut, zone.maxR));
    for (const side of arena.sides) {
      const v = (pos.x - side.a.x) * side.n.x + (pos.y - side.a.y) * side.n.y;
      if (v < radius) pos = add(pos, scale(side.n, radius - v));
    }
  }
  return pos;
}
