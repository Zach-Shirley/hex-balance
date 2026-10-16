// The Foundry backdrop: a live foundry hall drawn on a full-screen canvas behind the game.
// Steel trusses and swinging chains overhead, two giant gears, the rival presses (Red's
// furnace hammer on the left, Blue's quench hammer on the right) pounding in turn, embers
// rising, and the molten pool the plate hangs over.

interface Ember {
  x: number;
  y: number;
  vy: number;
  drift: number;
  size: number;
  phase: number;
}

export class FoundryBackdrop {
  private ctx: CanvasRenderingContext2D;
  private raf: number | null = null;
  private embers: Ember[] = [];
  private flareUntil = 0;
  private last = 0;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d')!;
    addEventListener('resize', () => this.resize());
    this.resize();
  }

  /** Brighten the pool for a moment (breakthroughs, the final meltdown). */
  flare(ms = 2200) {
    this.flareUntil = performance.now() + ms;
  }

  setActive(on: boolean) {
    this.canvas.style.display = on ? 'block' : 'none';
    if (on && this.raf === null) this.raf = requestAnimationFrame((t) => this.frame(t));
    if (!on && this.raf !== null) {
      cancelAnimationFrame(this.raf);
      this.raf = null;
    }
  }

  private resize() {
    const dpr = Math.min(1.5, devicePixelRatio || 1);
    this.w = innerWidth;
    this.h = innerHeight;
    this.canvas.width = this.w * dpr;
    this.canvas.height = this.h * dpr;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const n = Math.round((this.w * this.h) / 9000);
    this.embers = Array.from({ length: n }, () => this.ember(true));
  }

  private ember(anywhere = false): Ember {
    return {
      x: Math.random() * this.w,
      y: anywhere ? Math.random() * this.h : this.h + 10,
      vy: 20 + Math.random() * 60,
      drift: (Math.random() - 0.5) * 30,
      size: 0.6 + Math.random() * 1.8,
      phase: Math.random() * 10,
    };
  }

  private frame(now: number) {
    this.raf = requestAnimationFrame((t) => this.frame(t));
    // About 30 fps is plenty for a backdrop.
    if (now - this.last < 32) return;
    const dt = Math.min(0.08, (now - this.last) / 1000);
    this.last = now;
    const t = now / 1000;
    const { ctx, w, h } = this;
    const flare = Math.max(0, (this.flareUntil - now) / 2200);
    const poolTop = h * 0.74;

    // Smoky hall, lit orange from the pool below.
    const sky = ctx.createLinearGradient(0, 0, 0, h);
    sky.addColorStop(0, '#060405');
    sky.addColorStop(0.45, '#160b08');
    sky.addColorStop(0.75, '#3a1406');
    sky.addColorStop(1, '#5a1d05');
    ctx.fillStyle = sky;
    ctx.fillRect(0, 0, w, h);

    // Back wall: tall foundry windows glowing faintly.
    ctx.save();
    for (let i = 0; i < 9; i++) {
      const x = (i + 0.5) * (w / 9);
      const ww = w / 22;
      const top = h * 0.14;
      const bottom = h * 0.6;
      const g = ctx.createLinearGradient(0, top, 0, bottom);
      g.addColorStop(0, 'rgba(255,140,60,0.05)');
      g.addColorStop(1, `rgba(255,110,40,${0.12 + 0.04 * Math.sin(t * 0.7 + i)})`);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.moveTo(x - ww, bottom);
      ctx.lineTo(x - ww, top + ww);
      ctx.arc(x, top + ww, ww, Math.PI, 0);
      ctx.lineTo(x + ww, bottom);
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.lineWidth = 2;
      for (let r = 1; r < 5; r++) {
        ctx.beginPath();
        ctx.moveTo(x - ww, top + ww + (r * (bottom - top - ww)) / 5);
        ctx.lineTo(x + ww, top + ww + (r * (bottom - top - ww)) / 5);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
      ctx.stroke();
    }
    ctx.restore();

    // Giant gears turning in the gloom.
    this.gear(w * 0.12, h * 0.3, h * 0.2, t * 0.12, 18);
    this.gear(w * 0.9, h * 0.22, h * 0.16, -t * 0.16, 14);
    this.gear(w * 0.8, h * 0.42, h * 0.09, t * 0.26, 10);

    // Overhead trusses.
    this.truss(h * 0.06, h * 0.05);
    this.truss(h * 0.17, h * 0.03);

    // Chains and hooks swinging from the trusses.
    for (let i = 0; i < 6; i++) {
      const x0 = w * (0.2 + i * 0.12);
      const len = h * (0.18 + ((i * 37) % 23) / 100);
      const sway = Math.sin(t * 0.6 + i * 1.7) * 0.06;
      this.chain(x0, h * 0.09, len, sway);
    }

    // The rival presses: Red's furnace hammer (left) and Blue's quench hammer (right).
    this.press(w * 0.06, h, t, 0, '#ff5a1f', 'rgba(255,90,30,');
    this.press(w * 0.94, h, t, 1.3, '#3fb3ff', 'rgba(60,170,255,');

    // The molten pool.
    const glowUp = ctx.createRadialGradient(w / 2, poolTop + 40, 10, w / 2, poolTop, w * 0.7);
    glowUp.addColorStop(0, `rgba(255,140,40,${0.35 + 0.25 * flare})`);
    glowUp.addColorStop(1, 'rgba(255,80,20,0)');
    ctx.fillStyle = glowUp;
    ctx.fillRect(0, 0, w, h);

    const lava = ctx.createLinearGradient(0, poolTop, 0, h);
    lava.addColorStop(0, `rgb(255,${Math.round(150 + 60 * flare)},60)`);
    lava.addColorStop(0.25, '#ff6a14');
    lava.addColorStop(0.7, '#b8260a');
    lava.addColorStop(1, '#5a0d04');
    ctx.fillStyle = lava;
    ctx.beginPath();
    ctx.moveTo(0, h);
    for (let x = 0; x <= w; x += 16) {
      const y = poolTop + Math.sin(x * 0.012 + t * 1.2) * 4 + Math.sin(x * 0.031 - t * 0.8) * 3;
      ctx.lineTo(x, y);
    }
    ctx.lineTo(w, h);
    ctx.fill();

    // Flowing bright bands and dark crust on the surface.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (let band = 0; band < 7; band++) {
      const y = poolTop + 10 + band * ((h - poolTop) / 7);
      ctx.strokeStyle = `rgba(255,${200 - band * 18},90,${0.18 - band * 0.018 + 0.1 * flare})`;
      ctx.lineWidth = 3 + band;
      ctx.beginPath();
      for (let x = -20; x <= w + 20; x += 20) {
        const yy = y + Math.sin(x * 0.01 + t * (0.6 + band * 0.12) + band) * (4 + band);
        if (x === -20) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    }
    ctx.restore();
    ctx.fillStyle = 'rgba(40,10,4,0.45)';
    for (let i = 0; i < 9; i++) {
      const x = ((i * 211 + t * 14 * (1 + (i % 3))) % (w + 200)) - 100;
      const y = poolTop + 18 + ((i * 53) % Math.max(1, h - poolTop - 30));
      ctx.beginPath();
      ctx.ellipse(x, y, 40 + (i % 4) * 18, 6 + (i % 3) * 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // Bubbles popping.
    for (let i = 0; i < 6; i++) {
      const p = (t * 0.7 + i * 0.37) % 1;
      const x = (Math.sin(i * 91.7) * 0.5 + 0.5) * w;
      const y = poolTop + 14 + (i % 3) * 18;
      ctx.strokeStyle = `rgba(255,230,150,${0.5 * (1 - p)})`;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 2 + p * 9, Math.PI, 0);
      ctx.stroke();
    }

    // Embers rising on the heat.
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const e of this.embers) {
      e.y -= e.vy * dt;
      e.x += Math.sin(t + e.phase) * e.drift * dt;
      if (e.y < -10) Object.assign(e, this.ember());
      const flick = 0.5 + 0.5 * Math.sin(t * 6 + e.phase * 3);
      ctx.fillStyle = `rgba(255,${150 + Math.round(80 * flick)},70,${0.35 + 0.5 * flick})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.size, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();

    // Smoke vignette.
    const vig = ctx.createRadialGradient(w / 2, h * 0.5, Math.min(w, h) * 0.3, w / 2, h * 0.5, Math.max(w, h) * 0.75);
    vig.addColorStop(0, 'rgba(0,0,0,0)');
    vig.addColorStop(1, 'rgba(0,0,0,0.65)');
    ctx.fillStyle = vig;
    ctx.fillRect(0, 0, w, h);
  }

  private gear(cx: number, cy: number, r: number, angle: number, teeth: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.fillStyle = '#100a08';
    ctx.strokeStyle = 'rgba(255,120,50,0.18)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < teeth * 2; i++) {
      const a0 = (i / (teeth * 2)) * Math.PI * 2;
      const a1 = ((i + 1) / (teeth * 2)) * Math.PI * 2;
      const rr = i % 2 ? r : r * 1.12;
      ctx.lineTo(Math.cos(a0) * rr, Math.sin(a0) * rr);
      ctx.lineTo(Math.cos(a1) * rr, Math.sin(a1) * rr);
    }
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#060404';
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      ctx.beginPath();
      ctx.arc(Math.cos(a) * r * 0.55, Math.sin(a) * r * 0.55, r * 0.18, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.16, 0, Math.PI * 2);
    ctx.fillStyle = '#1c1310';
    ctx.fill();
    ctx.restore();
  }

  private truss(y: number, depth: number) {
    const { ctx, w } = this;
    ctx.save();
    ctx.strokeStyle = '#0c0808';
    ctx.lineWidth = 5;
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
    ctx.moveTo(0, y + depth);
    ctx.lineTo(w, y + depth);
    const step = depth * 1.4;
    for (let x = 0; x < w + step; x += step) {
      ctx.moveTo(x, y);
      ctx.lineTo(x + step / 2, y + depth);
      ctx.lineTo(x + step, y);
    }
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,120,50,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, y + depth + 2);
    ctx.lineTo(w, y + depth + 2);
    ctx.stroke();
    ctx.restore();
  }

  private chain(x: number, y: number, len: number, sway: number) {
    const { ctx } = this;
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(sway);
    ctx.strokeStyle = '#1a1210';
    ctx.lineWidth = 2;
    for (let yy = 0; yy < len; yy += 9) {
      ctx.beginPath();
      ctx.ellipse(0, yy, (yy / 9) % 2 ? 1.5 : 3.5, 5, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.strokeStyle = '#2a1d18';
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.arc(-6, len + 10, 9, -Math.PI / 2, Math.PI * 0.9);
    ctx.stroke();
    ctx.restore();
  }

  /** A tall drop press at the edge of the hall, pounding on its own rhythm. */
  private press(x: number, h: number, t: number, offset: number, color: string, rgba: string) {
    const { ctx } = this;
    const cycle = ((t + offset) % 2.6) / 2.6;
    // Rise slowly, slam fast.
    const pos = cycle < 0.8 ? cycle / 0.8 : 1 - (cycle - 0.8) / 0.2;
    const anvil = h * 0.7;
    const head = anvil - 18 - pos * h * 0.28;
    const fw = Math.max(46, innerWidth * 0.05);
    ctx.save();
    // Frame.
    ctx.fillStyle = '#0d0909';
    ctx.fillRect(x - fw, h * 0.08, 10, anvil - h * 0.08 + 20);
    ctx.fillRect(x + fw - 10, h * 0.08, 10, anvil - h * 0.08 + 20);
    ctx.fillRect(x - fw, h * 0.08, fw * 2, 14);
    // Anvil glowing with the player's colour.
    const ag = ctx.createRadialGradient(x, anvil, 2, x, anvil, fw * 1.6);
    const slam = cycle > 0.97 || cycle < 0.06 ? 1 : 0;
    ag.addColorStop(0, `${rgba}${0.35 + 0.5 * slam})`);
    ag.addColorStop(1, `${rgba}0)`);
    ctx.fillStyle = ag;
    ctx.fillRect(x - fw * 1.6, anvil - fw * 1.6, fw * 3.2, fw * 3.2);
    ctx.fillStyle = '#16100e';
    ctx.fillRect(x - fw * 0.7, anvil, fw * 1.4, 22);
    // Ram and head.
    ctx.fillStyle = '#1b1412';
    ctx.fillRect(x - 6, h * 0.08, 12, head - h * 0.08);
    ctx.fillStyle = '#231a17';
    ctx.fillRect(x - fw * 0.75, head - 34, fw * 1.5, 34);
    ctx.fillStyle = color;
    ctx.globalAlpha = 0.55;
    ctx.fillRect(x - fw * 0.75, head - 4, fw * 1.5, 4);
    ctx.restore();
  }
}
