// Tiny immutable 2D vector helpers. World space has y pointing down.
export const vec = (x = 0, y = 0) => ({ x, y });
export const add = (a, b) => vec(a.x + b.x, a.y + b.y);
export const sub = (a, b) => vec(a.x - b.x, a.y - b.y);
export const scale = (a, k) => vec(a.x * k, a.y * k);
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const length = (a) => Math.hypot(a.x, a.y);
export const normalize = (a) => {
  const l = length(a) || 1;
  return vec(a.x / l, a.y / l);
};
export const lerp = (a, b, k) => vec(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
export const rotate = (a, angle) => {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return vec(a.x * c - a.y * s, a.x * s + a.y * c);
};
export const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
