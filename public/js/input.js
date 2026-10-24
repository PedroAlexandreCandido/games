import { gameSize, isTouchDevice, toGame } from './layout.js';

// Screen direction of each steering key.
const KEYS = {
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
};

const isHorizontal = (t) => Math.abs(t.x) >= Math.abs(t.y);

// Hint shown under your name. The view is rotated so your side is horizontal
// or vertical on screen, so one pair of keys (or screen halves) steers.
export function controlsLabel(screenTangent, touch) {
  if (touch) return isHorizontal(screenTangent) ? 'HOLD ◀ ▶' : 'HOLD ▲ ▼';
  return isHorizontal(screenTangent) ? 'A / D  ← / →' : 'W / S  ↑ / ↓';
}

// Keyboard plus touch steering for your paddle. Every key, and each half of
// the touch pad, moves the paddle the way it points on screen. getTangent
// returns your side's on-screen direction, which changes if the phone turns.
export class PaddleInput {
  constructor(pad, getTangent, onChange) {
    this.pad = pad;
    this.getTangent = getTangent;
    this.onChange = onChange;
    this.keys = new Set();
    this.touches = new Map(); // pointer id → -1 (left/up half) or 1 (right/down half)
    this.dir = 0;

    this.onKeyDown = (e) => {
      if (!(e.code in KEYS)) return;
      e.preventDefault();
      this.keys.add(e.code);
      this.#update();
    };
    this.onKeyUp = (e) => {
      this.keys.delete(e.code);
      this.#update();
    };
    this.onBlur = () => {
      this.keys.clear();
      this.touches.clear();
      this.#update();
    };
    this.onPointer = (e) => {
      if (e.type === 'pointerup' || e.type === 'pointercancel') this.touches.delete(e.pointerId);
      else if (e.type === 'pointerdown' || this.touches.has(e.pointerId)) {
        // Re-insert so the most recent finger wins.
        this.touches.delete(e.pointerId);
        this.touches.set(e.pointerId, this.#half(e.clientX, e.clientY));
      }
      this.#update();
    };
    this.onResize = () => this.#update();

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    addEventListener('resize', this.onResize);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) pad.addEventListener(type, this.onPointer);
    pad.hidden = !isTouchDevice();
    this.#update();
  }

  #half(clientX, clientY) {
    const { x, y } = toGame(clientX, clientY);
    const { w, h } = gameSize();
    return isHorizontal(this.getTangent()) ? (x < w / 2 ? -1 : 1) : (y < h / 2 ? -1 : 1);
  }

  #update() {
    const t = this.getTangent();
    const horizontal = isHorizontal(t);
    // Holding the "+1" half (right, or bottom when the side is vertical) moves
    // the paddle that way on screen.
    const posAlong = Math.sign(horizontal ? t.x : t.y);

    let dir = 0;
    for (const code of this.keys) {
      const [x, y] = KEYS[code];
      const along = x * t.x + y * t.y;
      if (Math.abs(along) > 0.5) dir += Math.sign(along);
    }
    const half = [...this.touches.values()].at(-1) ?? 0;
    dir = Math.sign(dir + half * posAlong);

    this.pad.classList.toggle('vertical', !horizontal);
    this.pad.querySelector('.neg').classList.toggle('active', half === -1);
    this.pad.querySelector('.pos').classList.toggle('active', half === 1);
    if (dir !== this.dir) {
      this.dir = dir;
      this.onChange(dir);
    }
  }

  detach() {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    removeEventListener('resize', this.onResize);
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) this.pad.removeEventListener(type, this.onPointer);
    this.pad.hidden = true;
  }
}
