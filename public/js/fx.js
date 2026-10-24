import { POWERUPS } from '../shared/powerups.js';
import { sideForSeat } from '../shared/arena.js';

const WHITE = '#f4f4f4';
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const rand = (lo, hi) => lo + Math.random() * (hi - lo);
const easeOut = (k) => 1 - (1 - k) ** 3;
const easeInOut = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

// Short-lived visuals driven by simulation events. Purely cosmetic: nothing
// here feeds back into the game.
export class Fx {
  constructor() {
    this.particles = [];
    this.rings = [];
    this.comets = [];
    this.texts = [];
    this.sideFlashes = [];
    this.flashes = new Map();
    this.shake = 0;
  }

  handle(events, snap) {
    for (const e of events) {
      switch (e.type) {
        case 'hit': this.#onHit(e); break;
        case 'wall': this.burst(e.x, e.y, 3, WHITE, 80, 0.2); break;
        case 'spawn': this.ring(e.x, e.y, POWERUPS[e.powerup].color, 46, 0.45, 2); break;
        case 'expire': this.burst(e.x, e.y, 10, 'rgba(244,244,244,0.5)', 70, 0.5); break;
        case 'pickup': this.#onPickup(e); break;
        case 'goal':
          this.kick(14);
          this.sideFlashes.push({ seat: e.seat, t: 0, life: 0.7 });
          this.burst(e.x, e.y, 24, WHITE, 300, 0.6);
          break;
        case 'eliminated':
          this.text(0, 0, `${snap.players[e.seat].name.toUpperCase()} OUT`, WHITE, 44, 1.6, -20);
          break;
        case 'win':
          for (let i = 0; i < 3; i++) this.ring(0, 0, WHITE, 220 + i * 140, 1 + i * 0.3, 3);
          this.burst(0, 0, 90, WHITE, 520, 1.4);
          break;
      }
    }
  }

  #onHit(e) {
    this.burst(e.x, e.y, 6, WHITE, 140, 0.25);
    if (e.shot > 1.01) {
      const { color } = POWERUPS.power;
      this.ring(e.x, e.y, color, 95, 0.4, 5);
      this.ring(e.x, e.y, WHITE, 50, 0.25, 2);
      this.burst(e.x, e.y, 22, color, 380, 0.5);
      this.kick(7);
    } else if (e.shot < 0.99) {
      const { color } = POWERUPS.weak;
      this.ring(e.x, e.y, color, 36, 0.4, 2);
      this.burst(e.x, e.y, 8, color, 50, 0.7);
    }
  }

  #onPickup(e) {
    const def = POWERUPS[e.powerup];
    this.ring(e.x, e.y, def.color, 120, 0.6, 5);
    this.ring(e.x, e.y, WHITE, 60, 0.3, 2);
    this.burst(e.x, e.y, 32, def.color, 340, 0.7);
    this.kick(4);
    this.text(e.x, e.y - 34, def.label, def.color, 22, 0.9, -40);
    // A comet carries the power from the pickup spot to each affected paddle.
    for (const seat of e.targets) {
      this.comets.push({ seat, def, sx: e.x, sy: e.y, x: e.x, y: e.y, t: 0, dur: rand(0.45, 0.6), bend: rand(-180, 180), trail: [] });
    }
  }

  burst(x, y, count, color, speed, life) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * Math.PI * 2;
      const v = speed * rand(0.3, 1);
      this.particles.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, color, size: rand(2, 5), t: 0, life: life * rand(0.6, 1) });
    }
  }

  ring(x, y, color, radius, life, width) {
    this.rings.push({ x, y, color, radius, life, width, t: 0 });
  }

  text(x, y, value, color, size, life, vy) {
    this.texts.push({ x, y, value, color, size, life, vy, t: 0 });
  }

  kick(amount) {
    this.shake = Math.max(this.shake, amount);
  }

  shakeOffset() {
    return { x: rand(-1, 1) * this.shake, y: rand(-1, 1) * this.shake };
  }

  // 0..1 tint for a paddle that just received a power.
  flashFor(seat) {
    const f = this.flashes.get(seat);
    return f ? { color: f.color, alpha: 1 - f.t / f.life } : null;
  }

  update(dt, snap) {
    this.shake *= Math.exp(-dt * 9);
    const drag = Math.exp(-dt * 3.5);
    for (const p of this.particles) {
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= drag;
      p.vy *= drag;
      p.t += dt;
    }
    for (const list of [this.rings, this.sideFlashes]) for (const r of list) r.t += dt;
    for (const txt of this.texts) txt.t += dt;
    for (const [seat, f] of this.flashes) {
      f.t += dt;
      if (f.t >= f.life) this.flashes.delete(seat);
    }
    for (const c of this.comets) this.#moveComet(c, dt, snap);

    const alive = (x) => x.t < x.life;
    this.particles = this.particles.filter(alive);
    this.rings = this.rings.filter(alive);
    this.texts = this.texts.filter(alive);
    this.sideFlashes = this.sideFlashes.filter(alive);
    this.comets = this.comets.filter((c) => c.t < c.dur);
  }

  #moveComet(c, dt, snap) {
    c.t += dt;
    const target = snap.players[c.seat];
    const k = easeInOut(Math.min(1, c.t / c.dur));
    const dx = target.x - c.sx;
    const dy = target.y - c.sy;
    const len = Math.hypot(dx, dy) || 1;
    const cx = (c.sx + target.x) / 2 - (dy / len) * c.bend;
    const cy = (c.sy + target.y) / 2 + (dx / len) * c.bend;
    c.x = (1 - k) ** 2 * c.sx + 2 * (1 - k) * k * cx + k * k * target.x;
    c.y = (1 - k) ** 2 * c.sy + 2 * (1 - k) * k * cy + k * k * target.y;
    c.trail.push({ x: c.x, y: c.y });
    if (c.trail.length > 14) c.trail.shift();
    if (c.t >= c.dur) {
      const sign = c.def.negative ? '−' : '+';
      this.flashes.set(c.seat, { color: c.def.color, t: 0, life: 0.7 });
      this.burst(target.x, target.y, 18, c.def.color, 220, 0.5);
      this.ring(target.x, target.y, c.def.color, 80, 0.45, 3);
      this.text(target.x + target.nx * 60, target.y + target.ny * 60, sign + c.def.label, c.def.color, 18, 1.1, -30);
    }
  }

  drawSideFlashes(ctx, arena) {
    for (const f of this.sideFlashes) {
      const side = sideForSeat(arena, f.seat);
      const a = 1 - f.t / f.life;
      ctx.save();
      ctx.strokeStyle = WHITE;
      ctx.globalAlpha = a;
      ctx.lineWidth = 4 + 12 * a;
      ctx.shadowColor = WHITE;
      ctx.shadowBlur = 30;
      ctx.beginPath();
      ctx.moveTo(side.a.x, side.a.y);
      ctx.lineTo(side.b.x, side.b.y);
      ctx.stroke();
      ctx.restore();
    }
  }

  drawBelow(ctx) {
    ctx.save();
    for (const r of this.rings) {
      const k = r.t / r.life;
      ctx.globalAlpha = 1 - k;
      ctx.strokeStyle = r.color;
      ctx.lineWidth = r.width * (1 - k) + 0.5;
      ctx.beginPath();
      ctx.arc(r.x, r.y, r.radius * easeOut(k), 0, Math.PI * 2);
      ctx.stroke();
    }
    for (const p of this.particles) {
      const k = p.t / p.life;
      const s = p.size * (1 - k);
      ctx.globalAlpha = 1 - k;
      ctx.fillStyle = p.color;
      ctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
    }
    ctx.restore();
  }

  drawAbove(ctx, rotation = 0) {
    ctx.save();
    ctx.lineCap = 'round';
    for (const c of this.comets) {
      for (let i = 1; i < c.trail.length; i++) {
        const k = i / c.trail.length;
        ctx.globalAlpha = k;
        ctx.strokeStyle = c.def.color;
        ctx.lineWidth = 8 * k;
        ctx.beginPath();
        ctx.moveTo(c.trail[i - 1].x, c.trail[i - 1].y);
        ctx.lineTo(c.trail[i].x, c.trail[i].y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = WHITE;
      ctx.shadowColor = c.def.color;
      ctx.shadowBlur = 20;
      ctx.beginPath();
      ctx.arc(c.x, c.y, 6, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const txt of this.texts) {
      const k = txt.t / txt.life;
      ctx.globalAlpha = k < 0.7 ? 1 : 1 - (k - 0.7) / 0.3;
      ctx.fillStyle = txt.color;
      ctx.font = `700 ${txt.size * (1 + 0.25 * (1 - easeOut(Math.min(1, k * 4))))}px ${FONT}`;
      // Upright and drifting up the screen, whatever way the field is turned.
      ctx.save();
      ctx.translate(txt.x, txt.y);
      ctx.rotate(-rotation);
      ctx.fillText(txt.value, 0, txt.vy * txt.t);
      ctx.restore();
    }
    ctx.restore();
  }
}
