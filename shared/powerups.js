// Positive power-ups help the player who last hit the ball. Negative ones hit
// every other player still in the game.
export const POWERUPS = {
  boost: { label: 'BOOST', color: '#38c8ff', negative: false, duration: 10 },
  power: { label: 'POWER', color: '#ff9a2e', negative: false, duration: 10 },
  growth: { label: 'GROWTH', color: '#3fe08a', negative: false, duration: 10 },
  slow: { label: 'SLOW', color: '#ff4d6a', negative: true, duration: 7 },
  weak: { label: 'WEAK', color: '#b46cff', negative: true, duration: 7 },
  shrink: { label: 'SHRINK', color: '#ff5ccf', negative: true, duration: 7 },
};

export const NEGATIVE_CHANCE = 1 / 6;
const POSITIVE_TYPES = Object.keys(POWERUPS).filter((k) => !POWERUPS[k].negative);
const NEGATIVE_TYPES = Object.keys(POWERUPS).filter((k) => POWERUPS[k].negative);

export function rollPowerup(rng) {
  const pool = rng() < NEGATIVE_CHANCE ? NEGATIVE_TYPES : POSITIVE_TYPES;
  return pool[Math.floor(rng() * pool.length)];
}

// effects maps power-up type to the game time it wears off.
export function multipliers(effects, now) {
  const on = (type) => (effects[type] ?? 0) > now;
  return {
    speed: (on('boost') ? 1.6 : 1) * (on('slow') ? 0.55 : 1),
    shot: (on('power') ? 2 : 1) * (on('weak') ? 0.6 : 1),
    size: (on('growth') ? 1.5 : 1) * (on('shrink') ? 0.6 : 1),
  };
}
