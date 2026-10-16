// Foundry machine effects, drawn on a full-screen canvas over the board.
// Each game action gets a short piece of machinery: a crane claw for spawns, a drop
// hammer for reinforce and strike, lifted stacks for moves, weld arcs for merges, a
// cutting torch for splits, and a meltdown when the plate tips.

import type { GameState, Player } from './rules';
import { CELLS } from './board';
import { MAX_LAYERS, PIECE_H, R, VIEWBOX, boardXY, hex2, project, type Camera, type V2, type V3 } from './view3d';

export interface FxHost {
  /** The board's SVG element, used to map board coordinates to the screen. */
  svg(): SVGSVGElement | null;
  /** Current lean and yaw of the plate. */
  cam(): Camera;
  /** Redraw the board (hidden or hot stacks changed). */
  redraw(): void;
  /** Kick the scene for an impact, in pixels. */
  shake(px: number): void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  color: string;
  width: number;
  gravity: number;
}

interface Effect {
  /** Return false once finished. */
  frame(now: number, ctx: CanvasRenderingContext2D): boolean;
}

const OWNER: Record<Player, string> = { red: '#ff5a2e', blue: '#3fb3ff' };
const easeIn = (t: number) => t * t * t;
const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const clamp01 = (t: number) => Math.max(0, Math.min(1, t));
const stackH = (count: number) => Math.min(count, MAX_LAYERS) * PIECE_H;

export class Fx {
  readonly hidden = new Set<number>();
  private hotAt = new Map<number, number>();
  private effects: Effect[] = [];
  private particles: Particle[] = [];
  private raf: number | null = null;
  private ctx: CanvasRenderingContext2D;

  constructor(
    private canvas: HTMLCanvasElement,
    private host: FxHost,
  ) {
    this.ctx = canvas.getContext('2d')!;
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  // ---------- public ----------

  /** Stacks still glowing, with ms since they were heated (the glow lasts 2.6 s). */
  hotMap(): Map<number, number> {
    const now = performance.now();
    const out = new Map<number, number>();
    for (const [id, t] of this.hotAt) {
      if (now - t < 2600) out.set(id, now - t);
      else this.hotAt.delete(id);
    }
    return out;
  }

  clear() {
    this.effects = [];
    this.particles = [];
    this.hidden.clear();
    this.hotAt.clear();
  }

  /** Animate whatever changed between two states. */
  play(prev: GameState, next: GameState) {
    const la = next.lastAction;
    if (la && la.seq !== prev.lastAction?.seq) this.playAction(prev, next);
    if (next.phase === 'over' && prev.phase !== 'over') setTimeout(() => this.meltdown(next), 650);
    this.start();
  }

  // ---------- geometry ----------

  private resize() {
    const dpr = Math.min(2, devicePixelRatio || 1);
    this.canvas.width = innerWidth * dpr;
    this.canvas.height = innerHeight * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  /** Board point (x, y, z) to screen pixels, plus screen pixels per board unit. */
  private screen(v: V3, leans = true): { x: number; y: number; k: number } {
    const svg = this.host.svg();
    const p = project(v, this.host.cam(), leans).p;
    if (!svg) return { x: p[0], y: p[1], k: 1 };
    const r = svg.getBoundingClientRect();
    const k = r.width / VIEWBOX.w;
    return { x: r.left + (p[0] - VIEWBOX.x) * k, y: r.top + (p[1] - VIEWBOX.y) * k, k };
  }

  private top(id: number, count: number) {
    const [x, y] = boardXY(id);
    return this.screen([x, y, stackH(count)]);
  }

  // ---------- primitives ----------

  private sparks(x: number, y: number, n: number, opts: { speed?: number; color?: string[]; up?: number; gravity?: number; width?: number } = {}) {
    const colors = opts.color ?? ['#fff3c4', '#ffd166', '#ff9a3c', '#ff6a1f'];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = (opts.speed ?? 260) * (0.3 + Math.random());
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp * 0.6 - (opts.up ?? 140) * Math.random(),
        life: 0,
        max: 0.35 + Math.random() * 0.55,
        color: colors[Math.floor(Math.random() * colors.length)],
        width: opts.width ?? 1.6,
        gravity: opts.gravity ?? 620,
      });
    }
  }

  private heat(id: number) {
    this.hotAt.set(id, performance.now());
  }

  /** A projected hex stack drawn at a board position (z = base height). */
  private drawStack(ctx: CanvasRenderingContext2D, bx: number, by: number, z: number, count: number, owner: Player, opts: { leans?: boolean; alpha?: number; glow?: number } = {}) {
    const leans = opts.leans ?? true;
    const h = stackH(count);
    const ring = hex2(bx, by, R - 7);
    const pt = (q: V2, zz: number) => this.screen([q[0], q[1], zz], leans);
    const faces = ring.map((a, i) => {
      const b = ring[(i + 1) % 6];
      const pts = [pt(a, z), pt(b, z), pt(b, z + h), pt(a, z + h)];
      const nx = (a[0] + b[0]) / 2 - bx;
      const ny = (a[1] + b[1]) / 2 - by;
      return { pts, depth: pts.reduce((s, p) => s + p.y, 0), light: 0.55 + 0.45 * (ny / (R - 7)) - 0.15 * (nx / (R - 7)) };
    });
    faces.sort((a, b) => a.depth - b.depth);
    ctx.save();
    ctx.globalAlpha = opts.alpha ?? 1;
    for (const f of faces) {
      const l = Math.max(0.25, Math.min(1, f.light));
      ctx.fillStyle = `rgb(${Math.round(150 * l)},${Math.round(140 * l)},${Math.round(132 * l)})`;
      ctx.strokeStyle = OWNER[owner];
      ctx.lineWidth = 1;
      ctx.beginPath();
      f.pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }
    const topPts = ring.map((q) => pt(q, z + h));
    ctx.beginPath();
    topPts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
    ctx.closePath();
    ctx.fillStyle = '#cfc7bf';
    ctx.fill();
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = OWNER[owner];
    ctx.shadowColor = OWNER[owner];
    ctx.shadowBlur = 8;
    ctx.stroke();
    if (opts.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.fillStyle = `rgba(255,120,30,${0.7 * opts.glow})`;
      ctx.fill();
    }
    ctx.restore();
  }

  // ---------- machines ----------

  /** A crane lowers a glowing piece onto a cell, releases it and retracts. */
  private claw(id: number, owner: Player, baseCount: number, onRelease: () => void) {
    const t0 = performance.now();
    const dur = 1000;
    const [bx, by] = boardXY(id);
    const z = stackH(baseCount);
    let released = false;
    this.effects.push({
      frame: (now, ctx) => {
        const t = clamp01((now - t0) / dur);
        const down = t < 0.55 ? easeOut(t / 0.55) : t < 0.65 ? 1 : 1 - easeIn((t - 0.65) / 0.35);
        const lift = (1 - down) * 520; // board units above the target
        if (!released && t >= 0.6) {
          released = true;
          onRelease();
        }
        const head = this.screen([bx, by, z + PIECE_H + 26 + lift]);
        // Cable.
        ctx.strokeStyle = '#2b2522';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(head.x, -20);
        ctx.lineTo(head.x, head.y - 18 * head.k);
        ctx.stroke();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = '#6d625a';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        // Claw block and arms.
        const k = head.k;
        const open = released ? 1 : 0;
        ctx.fillStyle = '#3b3431';
        ctx.strokeStyle = '#ffb04a';
        ctx.lineWidth = 1.2;
        ctx.fillRect(head.x - 16 * k, head.y - 18 * k, 32 * k, 12 * k);
        ctx.strokeRect(head.x - 16 * k, head.y - 18 * k, 32 * k, 12 * k);
        ctx.strokeStyle = '#5a504a';
        ctx.lineWidth = 4 * k;
        for (const sx of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(head.x + sx * 12 * k, head.y - 6 * k);
          ctx.lineTo(head.x + sx * (22 + 10 * open) * k, head.y + 10 * k);
          ctx.lineTo(head.x + sx * (14 + 12 * open) * k, head.y + 22 * k);
          ctx.stroke();
        }
        if (!released) this.drawStack(ctx, bx, by, z + lift, 1, owner, { glow: 1 });
        return t < 1;
      },
    });
  }

  /** A drop hammer slams onto a cell's stack top. */
  private hammer(id: number, topCount: number, onImpact: () => void, heavy = false) {
    const t0 = performance.now();
    const dur = heavy ? 900 : 820;
    const hit = 0.4;
    const [bx, by] = boardXY(id);
    const z = stackH(topCount);
    let struck = false;
    this.effects.push({
      frame: (now, ctx) => {
        const t = clamp01((now - t0) / dur);
        const pos = t < hit ? easeIn(t / hit) : t < hit + 0.12 ? 1 : 1 - easeOut((t - hit - 0.12) / (1 - hit - 0.12));
        const lift = (1 - pos) * 460;
        if (!struck && t >= hit) {
          struck = true;
          onImpact();
        }
        const face = this.screen([bx, by, z + lift]);
        const k = face.k;
        const w = 64 * k;
        const hh = 40 * k;
        // Piston rod and guide.
        ctx.fillStyle = '#2a2523';
        ctx.fillRect(face.x - 7 * k, -20, 14 * k, face.y - hh + 20);
        ctx.fillStyle = 'rgba(255,170,80,0.25)';
        ctx.fillRect(face.x - 2 * k, -20, 3 * k, face.y - hh + 20);
        // Hammer head: dark steel block with hazard band and a hot striking face.
        const grad = ctx.createLinearGradient(face.x - w / 2, 0, face.x + w / 2, 0);
        grad.addColorStop(0, '#2a2422');
        grad.addColorStop(0.5, '#5d534d');
        grad.addColorStop(1, '#221d1b');
        ctx.fillStyle = grad;
        ctx.fillRect(face.x - w / 2, face.y - hh, w, hh);
        ctx.save();
        ctx.beginPath();
        ctx.rect(face.x - w / 2, face.y - hh + 6 * k, w, 8 * k);
        ctx.clip();
        for (let i = -6; i < 12; i++) {
          ctx.fillStyle = i % 2 ? '#1b1716' : '#e0a12a';
          ctx.beginPath();
          const x0 = face.x - w / 2 + i * 8 * k;
          ctx.moveTo(x0, face.y - hh + 6 * k);
          ctx.lineTo(x0 + 8 * k, face.y - hh + 6 * k);
          ctx.lineTo(x0, face.y - hh + 14 * k);
          ctx.lineTo(x0 - 8 * k, face.y - hh + 14 * k);
          ctx.fill();
        }
        ctx.restore();
        ctx.fillStyle = struck && t < hit + 0.3 ? '#ffb347' : '#7a3a1c';
        ctx.fillRect(face.x - w / 2 + 3 * k, face.y - 5 * k, w - 6 * k, 5 * k);
        ctx.strokeStyle = 'rgba(0,0,0,0.6)';
        ctx.lineWidth = 1;
        ctx.strokeRect(face.x - w / 2, face.y - hh, w, hh);
        // Impact flash.
        if (struck && t < hit + 0.18) {
          const f = 1 - (t - hit) / 0.18;
          const g = ctx.createRadialGradient(face.x, face.y, 0, face.x, face.y, 90 * k);
          g.addColorStop(0, `rgba(255,240,200,${0.8 * f})`);
          g.addColorStop(1, 'rgba(255,120,30,0)');
          ctx.save();
          ctx.globalCompositeOperation = 'lighter';
          ctx.fillStyle = g;
          ctx.fillRect(face.x - 90 * k, face.y - 90 * k, 180 * k, 180 * k);
          ctx.restore();
        }
        return t < 1;
      },
    });
  }

  /** Carry a stack along an arc from one board point to another. */
  private carry(from: V3, to: V3, count: number, owner: Player, dur: number, lift: number, onLand: () => void, glow = 0) {
    const t0 = performance.now();
    let landed = false;
    this.effects.push({
      frame: (now, ctx) => {
        const t = clamp01((now - t0) / dur);
        const e = easeInOut(t);
        const x = from[0] + (to[0] - from[0]) * e;
        const y = from[1] + (to[1] - from[1]) * e;
        const z = from[2] + (to[2] - from[2]) * e + Math.sin(Math.PI * e) * lift;
        this.drawStack(ctx, x, y, z, count, owner, { glow });
        if (t >= 1 && !landed) {
          landed = true;
          onLand();
        }
        return t < 1;
      },
    });
  }

  /** Arc welding between two points for a moment. */
  private weld(a: () => { x: number; y: number }, b: () => { x: number; y: number }, dur = 520) {
    const t0 = performance.now();
    this.effects.push({
      frame: (now, ctx) => {
        const t = (now - t0) / dur;
        const p = a();
        const q = b();
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        for (let pass = 0; pass < 3; pass++) {
          ctx.strokeStyle = pass === 0 ? 'rgba(140,200,255,0.9)' : 'rgba(255,255,255,0.8)';
          ctx.lineWidth = pass === 0 ? 4 : 1.5;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          for (let i = 1; i < 8; i++) {
            const f = i / 8;
            ctx.lineTo(p.x + (q.x - p.x) * f + (Math.random() - 0.5) * 16, p.y + (q.y - p.y) * f + (Math.random() - 0.5) * 16);
          }
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
        const g = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, 60);
        g.addColorStop(0, `rgba(200,230,255,${0.7 * (1 - t)})`);
        g.addColorStop(1, 'rgba(120,180,255,0)');
        ctx.fillStyle = g;
        ctx.fillRect(p.x - 60, p.y - 60, 120, 120);
        ctx.restore();
        if (Math.random() < 0.6) this.sparks(p.x, p.y, 3, { color: ['#ffffff', '#bfe3ff', '#7cc4ff'], speed: 200 });
        return t < 1;
      },
    });
  }

  /** A torch spraying sparks at a point for a while. */
  private torch(at: () => { x: number; y: number }, dur = 600) {
    const t0 = performance.now();
    this.effects.push({
      frame: (now) => {
        const p = at();
        this.sparks(p.x, p.y, 4, { speed: 320, up: 40, color: ['#ffffff', '#fff1a8', '#ffb347'], width: 1.2 });
        return now - t0 < dur;
      },
    });
  }

  /** An expanding shock ring on the plate. */
  private ring(id: number, color: string) {
    const t0 = performance.now();
    const [bx, by] = boardXY(id);
    this.effects.push({
      frame: (now, ctx) => {
        const t = (now - t0) / 700;
        const c = this.screen([bx, by, 0]);
        ctx.save();
        ctx.strokeStyle = color;
        ctx.globalAlpha = 1 - t;
        ctx.lineWidth = 4 * (1 - t) + 1;
        ctx.shadowColor = color;
        ctx.shadowBlur = 14;
        ctx.beginPath();
        ctx.ellipse(c.x, c.y, (20 + 120 * t) * c.k, (20 + 120 * t) * c.k * 0.64, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
        return t < 1;
      },
    });
  }

  /** A stack drops straight down through the plate into the crucible. */
  private fall(id: number, count: number, owner: Player, delay = 0) {
    const t0 = performance.now() + delay;
    const [bx, by] = boardXY(id);
    let splashed = false;
    this.effects.push({
      frame: (now, ctx) => {
        if (now < t0) return true;
        const t = clamp01((now - t0) / 900);
        const z = -t * t * 900;
        this.drawStack(ctx, bx, by, z, count, owner, { alpha: 1 - t * 0.6, glow: t });
        if (t >= 1 && !splashed) {
          splashed = true;
          const p = this.screen([bx, by, -900]);
          this.sparks(p.x, Math.min(p.y, innerHeight - 30), 60, { speed: 420, up: 380, color: ['#fff4b0', '#ffb347', '#ff5a1f', '#c2260c'] });
          this.host.shake(6);
        }
        return t < 1;
      },
    });
  }

  // ---------- actions ----------

  private playAction(prev: GameState, next: GameState) {
    const la = next.lastAction!;
    const a = la.action;
    const owner = la.player;
    const redraw = () => this.host.redraw();
    const after = (id: number) => next.stacks[id]?.count ?? 0;
    const [tx, ty] = boardXY(a.to);

    switch (a.kind) {
      case 'spawn': {
        const base = la.before.to ?? 0;
        if (!base) this.hidden.add(a.to);
        this.claw(a.to, owner, base, () => {
          this.hidden.delete(a.to);
          this.heat(a.to);
          const p = this.top(a.to, after(a.to));
          this.sparks(p.x, p.y, 26);
          this.host.shake(2);
          redraw();
        });
        break;
      }
      case 'reinforce':
        this.hammer(a.to, after(a.to), () => {
          this.heat(a.to);
          const p = this.top(a.to, after(a.to));
          this.sparks(p.x, p.y, 40, { speed: 340 });
          this.host.shake(5);
          redraw();
        });
        break;
      case 'move': {
        const [fx, fy] = boardXY(a.from);
        this.hidden.add(a.to);
        this.carry([fx, fy, 0], [tx, ty, 0], la.before.from ?? 1, owner, 560, a.jump ? 120 : 60, () => {
          this.hidden.delete(a.to);
          const p = this.screen([tx, ty, 0]);
          this.sparks(p.x, p.y, 14, { speed: 180, up: 60 });
          redraw();
        });
        break;
      }
      case 'merge': {
        const [fx, fy] = boardXY(a.from);
        const base = la.before.to ?? 0;
        this.hidden.add(a.to);
        this.carry([fx, fy, 0], [tx, ty, stackH(base)], la.before.from ?? 1, owner, 520, 70, () => {
          this.hidden.delete(a.to);
          this.heat(a.to);
          redraw();
          const seam = () => this.top(a.to, base);
          this.weld(seam, () => {
            const s = seam();
            return { x: s.x + 30, y: s.y + 6 };
          });
        });
        break;
      }
      case 'split': {
        const [fx, fy] = boardXY(a.from);
        const total = la.before.from ?? 2;
        const half = Math.floor(total / 2);
        this.hidden.add(a.to);
        this.torch(() => this.top(a.from, total - half), 420);
        setTimeout(() => {
          this.carry([fx, fy, stackH(total - half)], [tx, ty, 0], half, owner, 520, 50, () => {
            this.hidden.delete(a.to);
            this.heat(a.to);
            this.heat(a.from);
            redraw();
          }, 0.8);
        }, 260);
        break;
      }
      case 'strike': {
        const victim = prev.stacks[a.to]?.owner ?? (owner === 'red' ? 'blue' : 'red');
        const left = after(a.to);
        this.hammer(a.to, Math.max(left, 0), () => {
          const p = this.top(a.to, left);
          this.sparks(p.x, p.y, 50, { speed: 380 });
          this.host.shake(7);
          // The knocked-off piece flies off the plate and drops into the crucible.
          const dir = Math.random() < 0.5 ? -1 : 1;
          this.carry([tx, ty, stackH(left)], [tx + dir * 260, ty + 120, -700], 1, victim, 900, 160, () => undefined, 0.9);
        }, true);
        break;
      }
      case 'convert':
        this.ring(a.to, '#c48bff');
        this.heat(a.to);
        setTimeout(() => {
          const p = this.top(a.to, after(a.to));
          this.sparks(p.x, p.y, 30, { color: ['#ffffff', '#e2c8ff', '#c48bff'] });
        }, 200);
        break;
    }

    // Breakthroughs: the overloaded tower drops through its new hole.
    la.broke.forEach((b, i) => this.fall(b.id, b.count, b.owner, 450 + i * 200));
    redraw();
  }

  /** The plate has tipped: every stack slides to the low edge and pours into the crucible. */
  private meltdown(state: GameState) {
    const down = state.loser === 'blue' ? 1 : -1;
    const stacks = state.stacks
      .map((s, id) => ({ s, id }))
      .filter((x): x is { s: NonNullable<typeof x.s>; id: number } => !!x.s)
      .sort((a, b) => down * (CELLS[b.id].h - CELLS[a.id].h));
    for (const { id } of stacks) this.hidden.add(id);
    this.host.redraw();
    stacks.forEach(({ s, id }, i) => {
      const [bx, by] = boardXY(id);
      const edgeY = down * 260;
      const t0 = performance.now() + i * 70;
      let splashed = false;
      this.effects.push({
        frame: (now, ctx) => {
          if (now < t0) {
            this.drawStack(ctx, bx, by, 0, s.count, s.owner);
            return true;
          }
          const t = clamp01((now - t0) / 1300);
          const slide = easeIn(clamp01(t / 0.55));
          const drop = clamp01((t - 0.45) / 0.55);
          const y = by + (edgeY - by) * slide;
          const z = -drop * drop * 900;
          this.drawStack(ctx, bx, y, z, s.count, s.owner, { glow: drop, alpha: 1 - drop * 0.5 });
          if (t >= 1 && !splashed) {
            splashed = true;
            const p = this.screen([bx, edgeY, -900]);
            this.sparks(p.x, Math.min(p.y, innerHeight - 20), 30, { speed: 380, up: 420, color: ['#fff4b0', '#ffb347', '#ff5a1f'] });
          }
          return t < 1;
        },
      });
    });
    this.host.shake(10);
    this.start();
  }

  // ---------- loop ----------

  private start() {
    if (this.raf !== null) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const ctx = this.ctx;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      this.effects = this.effects.filter((e) => e.frame(now, ctx));
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      this.particles = this.particles.filter((p) => {
        p.life += dt;
        if (p.life > p.max) return false;
        p.vy += p.gravity * dt;
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        ctx.strokeStyle = p.color;
        ctx.globalAlpha = 1 - p.life / p.max;
        ctx.lineWidth = p.width;
        ctx.beginPath();
        ctx.moveTo(p.x, p.y);
        ctx.lineTo(p.x - p.vx * 0.025, p.y - p.vy * 0.025);
        ctx.stroke();
        return true;
      });
      ctx.restore();
      if (this.effects.length || this.particles.length) this.raf = requestAnimationFrame(tick);
      else this.raf = null;
    };
    this.raf = requestAnimationFrame(tick);
  }
}
