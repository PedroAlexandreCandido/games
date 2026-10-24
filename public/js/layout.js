// The game always plays in landscape. When a touch device is held upright,
// the game screen is drawn rotated 90° (the "sideways" class), which works even
// where the browser can't lock orientation. These helpers give sizes and touch
// points in the game screen's own landscape frame.
const gameEl = () => document.getElementById('game');

export const isTouchDevice = () => matchMedia('(pointer: coarse)').matches;

const isSideways = () => gameEl().classList.contains('sideways');

export function updateOrientation() {
  const el = gameEl();
  const sideways = isTouchDevice() && innerHeight > innerWidth;
  el.classList.toggle('sideways', sideways);
  el.style.width = sideways ? `${innerHeight}px` : '';
  el.style.height = sideways ? `${innerWidth}px` : '';
}

export function gameSize() {
  return isSideways() ? { w: innerHeight, h: innerWidth } : { w: innerWidth, h: innerHeight };
}

// Maps a viewport point into the game screen. Matches the CSS transform
// `rotate(90deg) translateY(-100%)` with a top-left origin.
export function toGame(x, y) {
  return isSideways() ? { x: y, y: innerWidth - x } : { x, y };
}

// Where supported (Android in fullscreen or an installed app), ask for real
// landscape too, so the status bar and keyboard turn with the game.
export function lockLandscape() {
  screen.orientation?.lock?.('landscape').catch(() => {});
}
