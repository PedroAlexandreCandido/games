import { rotate } from '../shared/vec.js';
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

export function freeControlsLabel(touch, kick) {
  if (kick) return touch ? 'DRAG · KICK' : 'MOUSE / WASD · SPACE';
  return touch ? 'DRAG' : 'MOUSE · WASD';
}

// Free movement for air hockey and soccer. You head for the mouse pointer or
// a finger on the screen, or move the way the held keys point. Movement goes
// out at most once per frame, from flush(). With `kick` (soccer), holding
// Space, the mouse button or the KICK button charges a kick, and releasing
// sends it with how long it was held; onCharge(start) reports the
// performance.now() it started, or null once released.
export class FreeInput {
  // toWorld maps game-screen pixels to world space; rotation is the view's.
  constructor(pad, canvas, { toWorld, rotation, kick = false, onCharge = () => {} }, send) {
    this.pad = pad;
    this.canvas = canvas;
    this.toWorld = toWorld;
    this.rotation = rotation;
    this.send = send;
    this.kick = kick;
    this.onCharge = onCharge;
    this.keys = new Set();
    this.touches = new Map(); // pointer id → world point, most recent last
    this.mouse = null;
    this.sent = '';
    this.chargeStart = null;
    this.chargeBy = null; // 'Space', 'mouse' or the touch pointer id holding KICK

    this.onKeyDown = (e) => {
      if (kick && e.code === 'Space') {
        e.preventDefault();
        if (!e.repeat) this.#press('Space');
        return;
      }
      if (!(e.code in KEYS)) return;
      e.preventDefault();
      this.keys.add(e.code);
    };
    this.onKeyUp = (e) => {
      if (kick && e.code === 'Space') {
        e.preventDefault(); // or a focused button would click
        this.#release('Space');
      }
      this.keys.delete(e.code);
    };
    this.onBlur = () => {
      this.keys.clear();
      this.touches.clear();
      if (this.chargeBy !== null) this.#release(this.chargeBy);
    };
    this.onPointer = (e) => {
      const point = () => {
        const { x, y } = toGame(e.clientX, e.clientY);
        return this.toWorld(x, y);
      };
      const ends = e.type === 'pointerup' || e.type === 'pointercancel';
      if (kick && e.type === 'pointerdown' && e.target.closest?.('.kick')) {
        this.#press(e.pointerId);
        return;
      }
      if (ends && this.chargeBy === e.pointerId) {
        this.#release(e.pointerId);
        return;
      }
      if (e.pointerType === 'mouse') {
        if (kick && e.type === 'pointerdown' && e.button === 0) this.#press('mouse');
        if (kick && e.type === 'pointerup' && e.button === 0) this.#release('mouse');
        this.mouse = point();
        this.keys.clear(); // moving the mouse takes over from the keys
      } else if (e.type === 'pointerup' || e.type === 'pointercancel') {
        this.touches.delete(e.pointerId);
      } else if (e.type === 'pointerdown' || this.touches.has(e.pointerId)) {
        this.touches.delete(e.pointerId);
        this.touches.set(e.pointerId, point());
      }
    };

    addEventListener('keydown', this.onKeyDown);
    addEventListener('keyup', this.onKeyUp);
    addEventListener('blur', this.onBlur);
    for (const el of [pad, canvas]) {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) el.addEventListener(type, this.onPointer);
    }
    pad.hidden = !isTouchDevice();
    pad.classList.add('free');
    pad.classList.toggle('soccer', kick);
    document.activeElement?.blur?.();
  }

  #press(by) {
    if (this.chargeBy !== null) return;
    this.chargeBy = by;
    this.chargeStart = performance.now();
    this.pad.querySelector('.kick')?.classList.add('active');
    this.onCharge(this.chargeStart);
    this.send({ charge: true });
  }

  #release(by) {
    if (this.chargeBy !== by) return;
    const held = Math.round(performance.now() - this.chargeStart);
    this.chargeBy = null;
    this.chargeStart = null;
    this.pad.querySelector('.kick')?.classList.remove('active');
    this.onCharge(null);
    // Send the move first so the kick goes the way you're heading now.
    this.flush();
    this.send({ charge: false, held });
  }

  flush() {
    let input;
    const touch = [...this.touches.values()].at(-1);
    if (this.keys.size) {
      let x = 0;
      let y = 0;
      for (const code of this.keys) {
        x += KEYS[code][0];
        y += KEYS[code][1];
      }
      const dir = rotate({ x, y }, -this.rotation);
      const len = Math.hypot(dir.x, dir.y) || 1;
      input = { x: dir.x / len, y: dir.y / len };
    } else if (touch || this.mouse) {
      const { x, y } = touch ?? this.mouse;
      input = { tx: Math.round(x), ty: Math.round(y) };
    } else {
      input = { x: 0, y: 0 };
    }
    const key = JSON.stringify(input);
    if (key === this.sent) return;
    this.sent = key;
    this.send(input);
  }

  detach() {
    removeEventListener('keydown', this.onKeyDown);
    removeEventListener('keyup', this.onKeyUp);
    removeEventListener('blur', this.onBlur);
    for (const el of [this.pad, this.canvas]) {
      for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) el.removeEventListener(type, this.onPointer);
    }
    this.pad.hidden = true;
    this.pad.classList.remove('free', 'soccer');
    this.pad.querySelector('.kick')?.classList.remove('active');
  }
}
