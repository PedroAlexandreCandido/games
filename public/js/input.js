// Screen direction of each steering key.
const KEYS = {
  KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0],
  KeyW: [0, -1], ArrowUp: [0, -1], KeyS: [0, 1], ArrowDown: [0, 1],
};

// screenTangent: your side's direction as drawn on screen. The view is rotated
// so it is horizontal or vertical, and each key moves the paddle the way the
// key points.
export function controlsLabel(screenTangent) {
  return Math.abs(screenTangent.x) >= Math.abs(screenTangent.y) ? 'A / D  ← / →' : 'W / S  ↑ / ↓';
}

export class KeyboardInput {
  constructor(screenTangent, onChange) {
    this.tangent = screenTangent;
    this.onChange = onChange;
    this.pressed = new Set();
    this.dir = 0;
    this.onDown = (e) => {
      if (!(e.code in KEYS)) return;
      e.preventDefault();
      this.pressed.add(e.code);
      this.#update();
    };
    this.onUp = (e) => {
      this.pressed.delete(e.code);
      this.#update();
    };
    this.onBlur = () => {
      this.pressed.clear();
      this.#update();
    };
    addEventListener('keydown', this.onDown);
    addEventListener('keyup', this.onUp);
    addEventListener('blur', this.onBlur);
  }

  #update() {
    let dir = 0;
    for (const code of this.pressed) {
      const [x, y] = KEYS[code];
      const along = x * this.tangent.x + y * this.tangent.y;
      if (Math.abs(along) > 0.5) dir += Math.sign(along);
    }
    dir = Math.sign(dir);
    if (dir !== this.dir) {
      this.dir = dir;
      this.onChange(dir);
    }
  }

  detach() {
    removeEventListener('keydown', this.onDown);
    removeEventListener('keyup', this.onUp);
    removeEventListener('blur', this.onBlur);
  }
}
