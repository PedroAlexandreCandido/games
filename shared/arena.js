import { vec, sub, scale, dot, length, normalize, lerp } from './vec.js';

// How much of each triangle edge is cut off at the corners in a 3-player game.
const CORNER_CUT = 0.2;

function makeSide(a, b, kind, seat = null) {
  const d = sub(b, a);
  const t = normalize(d);
  let n = vec(-t.y, t.x);
  // The arena is convex and centred on the origin, so "inward" points at it.
  if (dot(n, scale(a, -1)) < 0) n = scale(n, -1);
  return { a, b, t, n, length: length(d), kind, seat };
}

// Builds the field for 2, 3 or 4 seats as a convex polygon of sides. A "goal"
// side belongs to a seat and carries that player's paddle; a "wall" bounces.
//   2 seats: classic rectangle, goals left (0) and right (1).
//   3 seats: triangle with tapered corners, 3 long goals and 3 short walls.
//   4 seats: square, every side is a goal (left 0, right 1, top 2, bottom 3).
export function buildArena(seatCount) {
  const sides = [];
  if (seatCount === 2) {
    const w = 500;
    const h = 330;
    const tl = vec(-w, -h), tr = vec(w, -h), br = vec(w, h), bl = vec(-w, h);
    sides.push(
      makeSide(tl, tr, 'wall'),
      makeSide(tr, br, 'goal', 1),
      makeSide(br, bl, 'wall'),
      makeSide(bl, tl, 'goal', 0),
    );
  } else if (seatCount === 3) {
    const r = 560;
    const corners = [-90, 30, 150].map((deg) => {
      const rad = (deg * Math.PI) / 180;
      return vec(r * Math.cos(rad), r * Math.sin(rad));
    });
    // Long sides in order: top→bottom-right, bottom, bottom-left→top.
    const seatForLongSide = [1, 2, 0];
    for (let i = 0; i < 3; i++) {
      const corner = corners[i];
      const prev = corners[(i + 2) % 3];
      const next = corners[(i + 1) % 3];
      const cutIn = lerp(corner, prev, CORNER_CUT);
      const cutOut = lerp(corner, next, CORNER_CUT);
      sides.push(makeSide(cutIn, cutOut, 'wall'));
      sides.push(makeSide(cutOut, lerp(next, corner, CORNER_CUT), 'goal', seatForLongSide[i]));
    }
  } else if (seatCount === 4) {
    const s = 400;
    const tl = vec(-s, -s), tr = vec(s, -s), br = vec(s, s), bl = vec(-s, s);
    sides.push(
      makeSide(tl, tr, 'goal', 2),
      makeSide(tr, br, 'goal', 1),
      makeSide(br, bl, 'goal', 3),
      makeSide(bl, tl, 'goal', 0),
    );
  } else {
    throw new Error(`Unsupported seat count: ${seatCount}`);
  }

  const xs = sides.map((s) => s.a.x);
  const ys = sides.map((s) => s.a.y);
  return {
    seatCount,
    sides,
    inradius: Math.min(...sides.map((s) => dot(scale(s.a, -1), s.n))),
    bounds: { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) },
  };
}

export const sideForSeat = (arena, seat) => arena.sides.find((s) => s.seat === seat);
