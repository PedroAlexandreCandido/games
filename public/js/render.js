import { POWERUPS } from '../shared/powerups.js';
import { CONFIG } from '../shared/sim.js';
import { sideForSeat } from '../shared/arena.js';
import { hockeyZone } from '../shared/hockey.js';
import { SOCCER, gauge, soccerGoal } from '../shared/soccer.js';
import { rotate } from '../shared/vec.js';
import { Fx } from './fx.js';
import { gameSize } from './layout.js';

const WHITE = '#f4f4f4';
const YOU = '#ffd23f'; // the local player's paddle and label; no power-up uses yellow
const SUPER = '#ff2e2e'; // a perfectly timed soccer shot
const FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
const LABEL_SPACE = 150; // world units kept around the arena for names and lives
const easeOutBack = (k) => 1 + 2.7 * (k - 1) ** 3 + 1.7 * (k - 1) ** 2;

// Rotation that puts `seat`'s side at the bottom of the screen (at the left in
// 2-player games, which suit a wide screen better). 0 when spectating.
export function viewRotation(arena, seat) {
  if (seat === null) return 0;
  const { n } = sideForSeat(arena, seat);
  const target = arena.seatCount === 2 ? Math.PI : Math.PI / 2;
  return target - Math.atan2(-n.y, -n.x);
}

// Draws game snapshots onto a canvas. Reads only snapshot data and the static
// arena, which the client rebuilds from the seat count.
export class Renderer {
  // Call resize() whenever the window or the game screen's orientation changes.
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
  }

  // youSeat: the seat played from this screen, drawn in its own colour (null to
  // spectate). rotation: from viewRotation(). controls: key hint for youSeat.
  // mode: 'pong', 'hockey' or 'soccer'.
  setMatch(arena, { mode = 'pong', youSeat = null, rotation = 0, controls = '' } = {}) {
    this.arena = arena;
    this.mode = mode;
    // Air hockey and soccer goals: the open mouth, and the lines drawn around each goal.
    const zone = {
      pong: () => null,
      hockey: (side) => hockeyZone(arena, side.seat),
      soccer: (side) => ({ ...soccerGoal(side), minR: SOCCER.creaseRadius, maxR: null }),
    }[mode];
    this.zones = mode === 'pong' ? null : new Map(arena.sides.filter((s) => s.kind === 'goal').map((s) => [s.seat, zone(s)]));
    this.localCharge = null; // performance.now() when you started holding kick
    this.youSeat = youSeat;
    this.rotation = rotation;
    this.controls = controls;
    this.fx = new Fx();
    this.pending = [];
    this.ghosts = [];
    this.lastPaddles = new Map();
    this.ballTrail = [];
    const corners = arena.sides.map((s) => rotate(s.a, rotation));
    const xs = corners.map((p) => p.x);
    const ys = corners.map((p) => p.y);
    const [minX, maxX, minY, maxY] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    this.view = {
      cx: (minX + maxX) / 2,
      cy: (minY + maxY) / 2,
      w: maxX - minX + LABEL_SPACE * 2,
      h: maxY - minY + LABEL_SPACE * 2,
    };
  }

  resize() {
    const dpr = devicePixelRatio || 1;
    const { w, h } = gameSize();
    const width = Math.round(w * dpr);
    const height = Math.round(h * dpr);
    // Assigning a size, even the same one, reallocates and clears the canvas.
    if (this.canvas.width === width && this.canvas.height === height) return;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  // World point under a point on the game screen (CSS pixels, landscape frame).
  toWorld(x, y) {
    const { canvas, view } = this;
    const dpr = devicePixelRatio || 1;
    const k = Math.min(canvas.width / view.w, canvas.height / view.h) / dpr;
    const local = { x: (x - canvas.width / dpr / 2) / k + view.cx, y: (y - canvas.height / dpr / 2) / k + view.cy };
    return rotate(local, -this.rotation);
  }

  queue(events) {
    if (events.length) this.pending.push(...events);
  }

  draw(snap, dt) {
    const { ctx, canvas, view } = this;
    this.fx.handle(this.pending, snap);
    this.pending = [];
    this.fx.update(dt, snap);
    this.#track(snap, dt);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const k = Math.min(canvas.width / view.w, canvas.height / view.h);
    const shake = this.fx.shakeOffset();
    ctx.setTransform(k, 0, 0, k, canvas.width / 2 + (shake.x - view.cx) * k, canvas.height / 2 + (shake.y - view.cy) * k);
    ctx.rotate(this.rotation);

    this.#drawArena(snap);
    this.fx.drawSideFlashes(ctx, this.arena);
    this.#drawPowerups(snap);
    this.fx.drawBelow(ctx);
    this.#drawGhosts();
    if (this.mode === 'hockey') this.#drawMallets(snap);
    else if (this.mode === 'soccer') this.#drawFootballers(snap);
    else this.#drawPaddles(snap);
    this.#drawBall(snap);
    this.fx.drawAbove(ctx, this.rotation);
    this.#drawLabels(snap);
    this.#drawPhase(snap);
  }

  // Keeps short histories for the ball trail and boosted-paddle afterimages.
  #track(snap, dt) {
    const { ball } = snap;
    if (ball.live && ball.owner == null) {
      this.ballTrail.push({ x: ball.x, y: ball.y });
      if (this.ballTrail.length > 16) this.ballTrail.shift();
    } else {
      this.ballTrail = [];
    }
    for (const g of this.ghosts) g.t += dt;
    this.ghosts = this.ghosts.filter((g) => g.t < 0.25);
    for (const p of snap.players) {
      const last = this.lastPaddles.get(p.seat);
      if (p.alive && p.effects.boost && last && Math.hypot(p.x - last.x, p.y - last.y) > 0.5) {
        this.ghosts.push({ x: p.x, y: p.y, angle: Math.atan2(p.ty, p.tx), len: p.len, r: p.r, t: 0 });
      }
      this.lastPaddles.set(p.seat, { x: p.x, y: p.y });
    }
  }

  #drawArena(snap) {
    const { ctx, arena } = this;
    ctx.save();
    ctx.lineCap = 'round';
    const line = (side, from, to, open) => {
      ctx.setLineDash(open ? [6, 12] : []);
      ctx.lineWidth = open ? 2 : 5;
      ctx.strokeStyle = open ? 'rgba(244,244,244,0.3)' : WHITE;
      ctx.beginPath();
      ctx.moveTo(side.a.x + side.t.x * from, side.a.y + side.t.y * from);
      ctx.lineTo(side.a.x + side.t.x * to, side.a.y + side.t.y * to);
      ctx.stroke();
    };
    for (const side of arena.sides) {
      const open = side.kind === 'goal' && snap.players[side.seat].alive;
      const mouth = open && this.zones?.get(side.seat).mouth;
      if (mouth) {
        // Air hockey: solid wall either side of a small open goal.
        line(side, 0, mouth.from, false);
        line(side, mouth.from, mouth.to, true);
        line(side, mouth.to, side.length, false);
      } else {
        line(side, 0, side.length, open);
      }
    }
    if (this.zones) this.#drawZones(snap);
    ctx.setLineDash([10, 14]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = 'rgba(244,244,244,0.15)';
    ctx.beginPath();
    if (arena.seatCount === 2) {
      ctx.moveTo(0, arena.bounds.minY);
      ctx.lineTo(0, arena.bounds.maxY);
    } else {
      ctx.arc(0, 0, 60, 0, Math.PI * 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  // Each mallet's reach: a solid crease it can't enter and a faint outer limit.
  #drawZones(snap) {
    const { ctx, arena } = this;
    ctx.save();
    ctx.beginPath();
    arena.sides.forEach((s, i) => (i ? ctx.lineTo(s.a.x, s.a.y) : ctx.moveTo(s.a.x, s.a.y)));
    ctx.closePath();
    ctx.clip();
    for (const [seat, zone] of this.zones) {
      if (!snap.players[seat].alive) continue;
      const { x, y } = zone.center;
      ctx.setLineDash([]);
      ctx.lineWidth = 2;
      ctx.strokeStyle = 'rgba(244,244,244,0.35)';
      ctx.beginPath();
      ctx.arc(x, y, zone.minR, 0, Math.PI * 2);
      ctx.stroke();
      if (zone.maxR === null) continue;
      ctx.setLineDash([4, 10]);
      ctx.strokeStyle = 'rgba(244,244,244,0.15)';
      ctx.beginPath();
      ctx.arc(x, y, zone.maxR, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  #drawPowerups(snap) {
    const { ctx } = this;
    const r = CONFIG.powerupRadius;
    for (const pu of snap.powerups) {
      const def = POWERUPS[pu.type];
      const appear = easeOutBack(Math.min(1, pu.age / 0.35));
      const pulse = 1 + 0.07 * Math.sin(snap.time * 5 + pu.id);
      const remaining = pu.life - pu.age;
      ctx.save();
      ctx.translate(pu.x, pu.y);
      ctx.scale(appear * pulse, appear * pulse);
      ctx.globalAlpha = remaining < 2.5 && Math.sin(snap.time * 22) < 0 ? 0.3 : 1;
      ctx.shadowColor = def.color;
      ctx.shadowBlur = 18;
      ctx.strokeStyle = def.color;
      ctx.fillStyle = `${def.color}26`;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      if (def.negative) {
        // Negatives are spinning diamonds so they read as "danger" at a glance.
        ctx.rotate(snap.time * 1.5);
        const d = r * 1.2;
        ctx.moveTo(0, -d);
        ctx.lineTo(d, 0);
        ctx.lineTo(0, d);
        ctx.lineTo(-d, 0);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.rotate(-snap.time * 1.5);
      } else {
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      drawGlyph(ctx, pu.type, def.color, r * 0.55);
      ctx.restore();
    }
  }

  #drawGhosts() {
    const { ctx } = this;
    ctx.save();
    ctx.strokeStyle = POWERUPS.boost.color;
    ctx.lineWidth = 2;
    for (const g of this.ghosts) {
      ctx.globalAlpha = 0.5 * (1 - g.t / 0.25);
      ctx.save();
      ctx.translate(g.x, g.y);
      if (g.r !== undefined) {
        ctx.beginPath();
        ctx.arc(0, 0, g.r, 0, Math.PI * 2);
        ctx.stroke();
      } else {
        ctx.rotate(g.angle);
        ctx.strokeRect(-g.len / 2, -CONFIG.paddleThickness / 2, g.len, CONFIG.paddleThickness);
      }
      ctx.restore();
    }
    ctx.restore();
  }

  #drawPaddles(snap) {
    const { ctx } = this;
    const th = CONFIG.paddleThickness;
    for (const p of snap.players) {
      if (!p.alive) continue;
      const effects = Object.entries(p.effects).sort((a, b) => b[1] - a[1]);
      // Local y after rotating by the side's direction; flip so bars sit behind the paddle.
      const inward = Math.sign(p.ny * p.tx - p.nx * p.ty) || 1;
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate(Math.atan2(p.ty, p.tx));
      if (effects.length) {
        ctx.shadowColor = POWERUPS[effects[0][0]].color;
        ctx.shadowBlur = 22;
      }
      ctx.fillStyle = p.seat === this.youSeat ? YOU : WHITE;
      ctx.fillRect(-p.len / 2, -th / 2, p.len, th);
      ctx.shadowBlur = 0;
      if (this.#isMate(p, snap)) {
        ctx.strokeStyle = YOU;
        ctx.lineWidth = 2.5;
        ctx.strokeRect(-p.len / 2 + 1.25, -th / 2 + 1.25, p.len - 2.5, th - 2.5);
      }

      const negative = effects.find(([type]) => POWERUPS[type].negative);
      if (negative) {
        ctx.strokeStyle = POWERUPS[negative[0]].color;
        ctx.lineWidth = 3;
        ctx.strokeRect(-p.len / 2, -th / 2, p.len, th);
      }

      const flash = this.fx.flashFor(p.seat);
      if (flash) {
        ctx.globalAlpha = flash.alpha;
        ctx.fillStyle = flash.color;
        const grow = 6 * flash.alpha;
        ctx.fillRect(-p.len / 2 - grow, -th / 2 - grow, p.len + grow * 2, th + grow * 2);
        ctx.globalAlpha = 1;
      }

      // One timer bar per active effect, shrinking as it wears off.
      effects.forEach(([type, remaining], i) => {
        const def = POWERUPS[type];
        const w = p.len * Math.min(1, remaining / def.duration);
        ctx.fillStyle = def.color;
        ctx.fillRect(-w / 2, -inward * (th / 2 + 6 + i * 6) - 1.5, w, 3);
      });
      ctx.restore();
    }
  }

  #drawMallets(snap) {
    const { ctx } = this;
    for (const p of snap.players) {
      if (!p.alive) continue;
      const effects = Object.entries(p.effects).sort((a, b) => b[1] - a[1]);
      const color = p.seat === this.youSeat ? YOU : WHITE;
      const mate = this.#isMate(p, snap);
      const disc = (r, fill) => {
        ctx.fillStyle = fill;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.fill();
      };
      ctx.save();
      ctx.translate(p.x, p.y);
      if (effects.length) {
        ctx.shadowColor = POWERUPS[effects[0][0]].color;
        ctx.shadowBlur = 22;
      }
      // A mallet seen from above: rim, groove, handle.
      disc(p.r, color);
      ctx.shadowBlur = 0;
      disc(p.r * 0.62, '#000');
      disc(p.r * 0.38, mate ? YOU : color);

      const negative = effects.find(([type]) => POWERUPS[type].negative);
      if (negative) {
        ctx.strokeStyle = POWERUPS[negative[0]].color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.stroke();
      }

      const flash = this.fx.flashFor(p.seat);
      if (flash) {
        ctx.globalAlpha = flash.alpha;
        disc(p.r + 6 * flash.alpha, flash.color);
        ctx.globalAlpha = 1;
      }

      // One ring per active effect, unwinding as it wears off.
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      effects.forEach(([type, remaining], i) => {
        const def = POWERUPS[type];
        ctx.strokeStyle = def.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r + 7 + i * 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, remaining / def.duration));
        ctx.stroke();
      });
      ctx.restore();
    }
  }

  #drawFootballers(snap) {
    const { ctx } = this;
    const ball = snap.ball;
    for (const p of snap.players) {
      if (!p.alive) continue;
      const effects = Object.entries(p.effects).sort((a, b) => b[1] - a[1]);
      const color = p.seat === this.youSeat ? YOU : WHITE;
      ctx.save();
      ctx.translate(p.x, p.y);
      // Knocked over: wobble and flicker until back on their feet.
      if (p.stunned) {
        ctx.rotate(Math.sin(snap.time * 30) * 0.4);
        ctx.globalAlpha = 0.55 + 0.45 * Math.sin(snap.time * 40);
      }
      if (effects.length) {
        ctx.shadowColor = POWERUPS[effects[0][0]].color;
        ctx.shadowBlur = 22;
      }
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(0, 0, p.r, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
      if (this.#isMate(p, snap)) {
        ctx.strokeStyle = YOU;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, p.r - 1.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      // A notch shows which way they face, which is where the ball goes.
      const angle = Math.atan2(p.fy, p.fx);
      ctx.fillStyle = '#000';
      ctx.beginPath();
      ctx.moveTo(Math.cos(angle) * p.r * 0.85, Math.sin(angle) * p.r * 0.85);
      ctx.lineTo(Math.cos(angle + 2.5) * p.r * 0.35, Math.sin(angle + 2.5) * p.r * 0.35);
      ctx.lineTo(Math.cos(angle - 2.5) * p.r * 0.35, Math.sin(angle - 2.5) * p.r * 0.35);
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;

      const negative = effects.find(([type]) => POWERUPS[type].negative);
      if (negative) {
        ctx.strokeStyle = POWERUPS[negative[0]].color;
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(0, 0, p.r, 0, Math.PI * 2);
        ctx.stroke();
      }
      const flash = this.fx.flashFor(p.seat);
      if (flash) {
        ctx.globalAlpha = flash.alpha;
        ctx.fillStyle = flash.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r + 6 * flash.alpha, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      }

      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      // Dribble timer: a ring that runs down until the ball goes loose.
      let ring = 0;
      if (ball.owner === p.seat) {
        ctx.strokeStyle = WHITE;
        ctx.globalAlpha = 0.8;
        ctx.beginPath();
        ctx.arc(0, 0, p.r + 7, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, 1 - ball.dribble));
        ctx.stroke();
        ctx.globalAlpha = 1;
        ring = 1;
      }
      effects.forEach(([type, remaining], i) => {
        const def = POWERUPS[type];
        ctx.strokeStyle = def.color;
        ctx.beginPath();
        ctx.arc(0, 0, p.r + 7 + (i + ring) * 6, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, remaining / def.duration));
        ctx.stroke();
      });

      // Your own gauge runs on your own clock, so it matches what your thumb feels.
      const held = p.seat === this.youSeat && this.localCharge !== null ? (performance.now() - this.localCharge) / 1000 : p.charge;
      if (held !== null && held !== undefined && !p.stunned) this.#drawGauge(held, p.r);
      ctx.restore();
    }
  }

  // Kick power, drawn upright under the player. The bright end marks the
  // perfect-release zone.
  #drawGauge(held, r) {
    const { ctx } = this;
    const { level, perfect } = gauge(held);
    const w = 64;
    const h = 9;
    const zone = SOCCER.perfectWindow / SOCCER.riseTime;
    ctx.save();
    ctx.rotate(-this.rotation);
    ctx.translate(-w / 2, r + 14);
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillRect(-2, -2, w + 4, h + 4);
    ctx.fillStyle = 'rgba(255,154,46,0.35)';
    ctx.fillRect(w * (1 - zone), 0, w * zone, h);
    ctx.fillStyle = perfect ? '#ff9a2e' : WHITE;
    if (perfect) {
      ctx.shadowColor = '#ff9a2e';
      ctx.shadowBlur = 16;
    }
    ctx.fillRect(0, 0, w * level, h);
    ctx.shadowBlur = 0;
    ctx.strokeStyle = WHITE;
    ctx.lineWidth = 1.5;
    ctx.strokeRect(-2, -2, w + 4, h + 4);
    ctx.restore();
  }

  // Your teammate gets a yellow trim, so you can tell them apart from rivals.
  #isMate(p, snap) {
    const you = snap.players[this.youSeat];
    return snap.teams && you !== undefined && p.seat !== you.seat && p.team === you.team;
  }

  #drawBall(snap) {
    const { ctx } = this;
    const b = snap.ball;
    if (!b.live) return;
    let color = WHITE;
    if (b.super) color = SUPER;
    else if (b.shotMul > 1.01) color = POWERUPS.power.color;
    else if (b.shotMul < 0.99) color = POWERUPS.weak.color;
    const trail = this.ballTrail;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.strokeStyle = color;
    for (let i = 1; i < trail.length; i++) {
      const k = i / trail.length;
      ctx.globalAlpha = k * (color === WHITE ? 0.35 : 0.7);
      ctx.lineWidth = b.r * 2 * k;
      ctx.beginPath();
      ctx.moveTo(trail[i - 1].x, trail[i - 1].y);
      ctx.lineTo(trail[i].x, trail[i].y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    if (color !== WHITE) {
      ctx.shadowColor = color;
      ctx.shadowBlur = 24;
    }
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(b.x, b.y, b.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  #drawLabels(snap) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    // One label per goal: a player, or both teammates, who share lives.
    for (const side of this.arena.sides.filter((s) => s.kind === 'goal')) {
      const members = snap.players.filter((q) => q.team === side.seat);
      const p = members[0];
      const x = (side.a.x + side.b.x) / 2 - side.n.x * 78;
      const y = (side.a.y + side.b.y) / 2 - side.n.y * 78;
      const isYou = members.some((q) => q.seat === this.youSeat);
      // Text stays upright whatever way the field is turned.
      ctx.save();
      ctx.translate(x, y);
      ctx.rotate(-this.rotation);
      ctx.globalAlpha = p.alive ? 1 : 0.35;
      if (members.length > 1) {
        ctx.font = `700 17px ${FONT}`;
        members.forEach((q, i) => {
          ctx.fillStyle = q.seat === this.youSeat ? YOU : WHITE;
          ctx.fillText(q.name.toUpperCase(), 0, -40 + i * 21);
        });
      } else {
        ctx.font = `700 20px ${FONT}`;
        ctx.fillStyle = isYou ? YOU : WHITE;
        ctx.fillText(p.name.toUpperCase(), 0, -18);
      }
      ctx.fillStyle = isYou ? YOU : WHITE;

      if (p.alive) {
        const pip = 9;
        const gap = 6;
        const total = snap.maxLives * pip + (snap.maxLives - 1) * gap;
        for (let i = 0; i < snap.maxLives; i++) {
          const px = -total / 2 + i * (pip + gap);
          if (i < p.lives) ctx.fillRect(px, -pip / 2 + 4, pip, pip);
          else {
            ctx.strokeStyle = 'rgba(244,244,244,0.4)';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(px, -pip / 2 + 4, pip, pip);
          }
        }
      } else {
        ctx.font = `700 16px ${FONT}`;
        ctx.fillText('OUT', 0, 6);
      }

      ctx.globalAlpha = p.alive ? 0.5 : 0.25;
      ctx.font = `500 13px ${FONT}`;
      let tag = '';
      if (isYou) tag = `YOU · ${this.controls}`;
      else if (members.length > 1) tag = 'TEAM';
      else if (p.isBot) tag = `BOT · ${p.difficulty.toUpperCase()}`;
      ctx.fillText(tag, 0, 28);
      ctx.restore();
    }
    ctx.restore();
  }

  #drawPhase(snap) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = WHITE;
    ctx.rotate(-this.rotation);
    if (snap.phase === 'countdown') {
      const n = Math.ceil(snap.timer);
      const frac = snap.timer - Math.floor(snap.timer);
      ctx.globalAlpha = Math.min(1, frac * 1.5);
      ctx.font = `700 ${120 * (1 + 0.3 * frac)}px ${FONT}`;
      ctx.fillText(String(n), 0, 0);
    } else if (snap.phase === 'serve') {
      ctx.globalAlpha = 0.5 + 0.5 * Math.sin(snap.time * 14);
      ctx.beginPath();
      ctx.arc(0, 0, snap.ball.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
}

function chevron(ctx, x, s, flip) {
  const d = flip ? -1 : 1;
  ctx.moveTo(x - d * s * 0.3, -s * 0.6);
  ctx.lineTo(x + d * s * 0.3, 0);
  ctx.lineTo(x - d * s * 0.3, s * 0.6);
}

function bolt(ctx, s) {
  const pts = [[2, -10], [-6, 1], [-1, 1], [-3, 10], [6, -2], [1, -2], [3, -10]];
  ctx.moveTo(pts[0][0] * s / 10, pts[0][1] * s / 10);
  for (const [x, y] of pts.slice(1)) ctx.lineTo(x * s / 10, y * s / 10);
  ctx.closePath();
}

function arrow(ctx, y, tipY, s) {
  ctx.moveTo(0, y);
  ctx.lineTo(0, tipY);
  const back = tipY > y ? -1 : 1;
  ctx.moveTo(-s * 0.35, tipY + back * s * 0.35);
  ctx.lineTo(0, tipY);
  ctx.lineTo(s * 0.35, tipY + back * s * 0.35);
}

// Small vector icons, drawn centred on the origin.
function drawGlyph(ctx, type, color, s) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  switch (type) {
    case 'boost':
      chevron(ctx, -s * 0.35, s, false);
      chevron(ctx, s * 0.35, s, false);
      ctx.stroke();
      break;
    case 'slow':
      chevron(ctx, -s * 0.35, s, true);
      chevron(ctx, s * 0.35, s, true);
      ctx.stroke();
      break;
    case 'power':
      bolt(ctx, s);
      ctx.fill();
      break;
    case 'weak':
      bolt(ctx, s);
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.beginPath();
      ctx.lineWidth = 2.5;
      ctx.moveTo(-s * 0.8, s * 0.8);
      ctx.lineTo(s * 0.8, -s * 0.8);
      ctx.stroke();
      break;
    case 'growth':
      arrow(ctx, 0, -s, s);
      arrow(ctx, 0, s, s);
      ctx.stroke();
      break;
    case 'shrink':
      arrow(ctx, -s, -s * 0.2, s);
      arrow(ctx, s, s * 0.2, s);
      ctx.moveTo(-s * 0.7, 0);
      ctx.lineTo(s * 0.7, 0);
      ctx.stroke();
      break;
  }
  ctx.restore();
}
