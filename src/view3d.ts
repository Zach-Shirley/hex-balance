// 2.5D renderer: projects the board, plate, pipe and stacks from 3D into SVG.
// World axes: x to the right, y toward the bottom (Blue) edge, z up out of the plate.
// The camera sits above Blue's edge looking down at CAMERA_ELEVATION; `yaw` spins the
// whole table about the vertical axis (π puts Red's edge nearest).

import { CELLS, CENTER_H, SPAWNS, type Player } from './board';
import type { ActionKind, Stack } from './rules';

const R = 34; // cell circumradius
const HALF_H = (Math.sqrt(3) / 2) * R; // one `h` unit
const PAD = 22; // plate border around the outer cells
const PLATE_T = 18; // plate thickness
const PIECE_H = 8; // thickness of one steel piece
const MAX_LAYERS = 16; // taller stacks are capped visually; the number shows the real count
const CAMERA_ELEVATION = (50 * Math.PI) / 180; // 90° would be straight down
const FOCAL = 2000; // mild perspective

export type V2 = [number, number];
export type V3 = [number, number, number];
export { R, PIECE_H, MAX_LAYERS, PLATE_T, CAMERA_ELEVATION };

const midCol = 4;
export const boardXY = (id: number): V2 => [(CELLS[id].col - midCol) * 1.5 * R, (CELLS[id].h - CENTER_H) * HALF_H];

export function hex2(cx: number, cy: number, r: number): V2[] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as V2;
  });
}

function convexHull(points: V2[]): V2[] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: V2, a: V2, b: V2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const build = (list: V2[]) => {
    const out: V2[] = [];
    for (const pt of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], pt) <= 0) out.pop();
      out.push(pt);
    }
    return out;
  };
  const lower = build(p);
  const upper = build(p.reverse());
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

/**
 * The plate is a true hexagon: flat top and bottom edges, with pointed ends that
 * meet the middle of the pipe. It is the smallest such hexagon around the padded cells.
 */
const PLATE: V2[] = (() => {
  const hull = convexHull(CELLS.flatMap((c) => hex2(...boardXY(c.id), R + PAD)));
  const H = Math.max(...hull.map(([, y]) => Math.abs(y)));
  const a = Math.max(...hull.filter(([, y]) => Math.abs(y) >= H - 0.5).map(([x]) => Math.abs(x)));
  const W = Math.max(
    ...hull.filter(([x, y]) => Math.abs(x) > a && Math.abs(y) < H - 0.5).map(([x, y]) => a + (Math.abs(x) - a) / (1 - Math.abs(y) / H)),
  );
  return [[-a, -H], [a, -H], [W, 0], [a, H], [-a, H], [-W, 0]] as V2[];
})();
const PLATE_HALF_W = Math.max(...PLATE.map((p) => p[0]));
export const PLATE_POINTS = PLATE;

export interface Camera {
  lean: number; // radians; positive sinks the Blue (bottom, +y) edge
  yaw: number; // radians about the vertical axis
}

/** Board point → world (applies the lean about the pipe) → screen. */
export function project([x, y, z]: V3, cam: Camera, leans = true): { p: V2; depth: number } {
  let wy = y;
  let wz = z;
  if (leans) {
    // Rotate about the pipe's top edge (y = 0, z = -PLATE_T).
    const c = Math.cos(cam.lean);
    const s = Math.sin(cam.lean);
    const zz = z + PLATE_T;
    wy = y * c + zz * s;
    wz = -PLATE_T - y * s + zz * c;
  }
  const cy = Math.cos(cam.yaw);
  const sy = Math.sin(cam.yaw);
  const wx = x * cy - wy * sy;
  wy = x * sy + wy * cy;
  const sinE = Math.sin(CAMERA_ELEVATION);
  const cosE = Math.cos(CAMERA_ELEVATION);
  const depth = wy * cosE + wz * sinE;
  const k = FOCAL / (FOCAL - depth);
  return { p: [wx * k, (wy * sinE - wz * cosE) * k], depth };
}

const fmt = (pts: V2[]) => pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

export type Theme = 'neon' | 'forge' | 'foundry';
type RGB = [number, number, number];

interface Palette {
  metal: RGB; // pipe and stands
  plateSide: RGB;
  pieceSide: RGB;
  plateStops: [string, string, string];
  steelStops: [string, string, string];
}

const PALETTES: Record<Theme, Palette> = {
  // Dark gunmetal so the glowing edges carry the look.
  neon: {
    metal: [74, 82, 98],
    plateSide: [38, 42, 54],
    pieceSide: [150, 160, 178],
    plateStops: ['#262a34', '#191c23', '#101217'],
    steelStops: ['#dfe7f2', '#93a0b2', '#5a6475'],
  },
  // Warm wrought iron and worn steel.
  forge: {
    metal: [80, 74, 68],
    plateSide: [82, 74, 64],
    pieceSide: [172, 160, 142],
    plateStops: ['#4d4842', '#35312c', '#221f1b'],
    steelStops: ['#ece3d2', '#b6a991', '#7c6e5a'],
  },
  // Heat-blued tool steel lit from below by the crucible.
  foundry: {
    metal: [70, 60, 56],
    plateSide: [58, 44, 38],
    pieceSide: [150, 140, 132],
    plateStops: ['#3b3230', '#241c1a', '#140f0e'],
    steelStops: ['#e9e2da', '#a59c94', '#5c524c'],
  },
};

/** A small tile of grain noise for the forge plate, generated once in the browser. */
let grainUrl: string | null = null;
function grain(): string {
  if (grainUrl !== null) return grainUrl;
  grainUrl = '';
  try {
    const c = document.createElement('canvas');
    c.width = c.height = 96;
    const ctx = c.getContext('2d')!;
    const img = ctx.createImageData(96, 96);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = Math.random() < 0.5 ? 0 : 255;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = Math.floor(Math.random() * 38);
    }
    ctx.putImageData(img, 0, 0);
    grainUrl = c.toDataURL();
  } catch {
    // no canvas (tests); the plate just renders without grain
  }
  return grainUrl;
}

/** Rust blotches, drips and pitting for forge metal, generated once in the browser. */
let rustUrl: string | null = null;
function rust(): string {
  if (rustUrl !== null) return rustUrl;
  rustUrl = '';
  try {
    const n = 160;
    const c = document.createElement('canvas');
    c.width = c.height = n;
    const ctx = c.getContext('2d')!;
    const tones = ['118,58,24', '92,48,24', '140,78,34', '60,36,22', '30,24,20'];
    // Wrap blotches across edges so the tile repeats without seams.
    const blot = (x: number, y: number, r: number, color: string, a: number) => {
      for (const dx of [-n, 0, n]) {
        for (const dy of [-n, 0, n]) {
          const g = ctx.createRadialGradient(x + dx, y + dy, 0, x + dx, y + dy, r);
          g.addColorStop(0, `rgba(${color},${a})`);
          g.addColorStop(1, `rgba(${color},0)`);
          ctx.fillStyle = g;
          ctx.fillRect(x + dx - r, y + dy - r, r * 2, r * 2);
        }
      }
    };
    for (let i = 0; i < 26; i++) blot(Math.random() * n, Math.random() * n, 8 + Math.random() * 30, tones[i % tones.length], 0.18 + Math.random() * 0.35);
    // Drips running down.
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * n;
      const y = Math.random() * n;
      const len = 12 + Math.random() * 40;
      const g = ctx.createLinearGradient(x, y, x, y + len);
      g.addColorStop(0, 'rgba(110,56,24,0.45)');
      g.addColorStop(1, 'rgba(110,56,24,0)');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, 1 + Math.random() * 2, len);
    }
    // Pitting.
    for (let i = 0; i < 900; i++) {
      ctx.fillStyle = Math.random() < 0.7 ? `rgba(20,14,10,${0.2 + Math.random() * 0.4})` : `rgba(210,190,160,${0.1 + Math.random() * 0.2})`;
      ctx.fillRect(Math.random() * n, Math.random() * n, 1, 1);
    }
    rustUrl = c.toDataURL();
  } catch {
    // no canvas (tests); metal renders clean
  }
  return rustUrl;
}

/** Texture and shading defs shared by both forge layers (ids are suffixed per layer). */
function forgeDefs(suffix: string): string {
  const g = grain();
  const r = rust();
  return `${g ? `<pattern id="grain${suffix}" width="96" height="96" patternUnits="userSpaceOnUse"><image href="${g}" width="96" height="96" /></pattern>` : ''}
    ${r ? `<pattern id="rust${suffix}" width="160" height="160" patternUnits="userSpaceOnUse"><image href="${r}" width="160" height="160" /></pattern>` : ''}
    <linearGradient id="soot${suffix}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000" stop-opacity="0" /><stop offset="0.55" stop-color="#000" stop-opacity="0.18" /><stop offset="1" stop-color="#000" stop-opacity="0.6" />
    </linearGradient>
    <radialGradient id="vignette${suffix}" cx="0.5" cy="0.5" r="0.62">
      <stop offset="0.55" stop-color="#000" stop-opacity="0" /><stop offset="1" stop-color="#000" stop-opacity="0.55" />
    </radialGradient>`;
}

function shade(base: [number, number, number], light: number): string {
  const f = 0.45 + 0.55 * Math.max(0, Math.min(1, light));
  return `rgb(${base.map((v) => Math.round(v * f)).join(',')})`;
}

/** Light comes from the upper-left of the screen; returns 0..1 for a side face's outward normal. */
function faceLight(nx: number, ny: number, yaw: number): number {
  const sx = nx * Math.cos(yaw) - ny * Math.sin(yaw);
  const sy = nx * Math.sin(yaw) + ny * Math.cos(yaw);
  const len = Math.hypot(sx, sy) || 1;
  return 0.5 + 0.5 * ((-0.45 * sx + 0.9 * sy) / len);
}

export interface BoardView {
  stacks: (Stack | null)[];
  pipeHalfWidth: number;
  lean: number; // radians
  yaw: number; // radians
  theme: Theme;
  /** Cells punched through the plate. */
  holes: Set<number>;
  /** Stacks not drawn (an animation is carrying them). */
  hidden?: Set<number>;
  /** Freshly worked stacks still glowing, with ms since they were heated. */
  hot?: Map<number, number>;
  /** Spawn slot heat: level 1-2, or overheated with turns left. */
  heat: Map<number, { heat: number; cooldown: number }>;
  sources: Set<number>;
  targets: Map<number, ActionKind>;
  from: number | null;
}

/** A fixed viewBox that fits the board at moderate lean in either orientation. */
export const VIEWBOX = (() => {
  const pts: V2[] = [];
  for (const lean of [-0.12, 0, 0.12]) {
    for (const yaw of [0, Math.PI]) {
      for (const [x, y] of PLATE) {
        pts.push(project([x, y, 0], { lean, yaw }).p, project([x, y, -PLATE_T], { lean, yaw }).p);
      }
    }
  }
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const minX = Math.min(...xs) - 64;
  const minY = Math.min(...ys) - 36;
  return { x: minX, y: minY, w: Math.max(...xs) + 64 - minX, h: Math.max(...ys) + 30 - minY };
})();

export interface RenderedBoard {
  /** Shadow, stands and pipe: these never lean. */
  under: string;
  /** Plate, slots and stacks: everything that leans about the pipe. */
  board: string;
}

export function renderBoard(view: BoardView): RenderedBoard {
  const cam: Camera = { lean: view.lean, yaw: view.yaw };
  const pal = PALETTES[view.theme];
  const P = (v: V3, leans = true) => project(v, cam, leans);
  const out: string[] = [];

  // Ground shadow and the pipe with its stands (the pipe does not lean).
  const pipeA = Math.max(5, view.pipeHalfWidth * 2 * HALF_H);
  const pipeTop = -PLATE_T;
  const pipeBot = -PLATE_T - 2 * pipeA;
  const ground = pipeBot - 70;
  const foundry = view.theme === 'foundry';
  const pipeX = PLATE_HALF_W + (foundry ? 320 : 30);
  if (!foundry) {
    const shadow = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => P([sx * (PLATE_HALF_W + 10), sy * 230, ground], false).p));
    out.push(`<polygon class="ground-shadow" points="${fmt([shadow[0], shadow[1], shadow[3], shadow[2]])}" />`);
  }

  const forge = view.theme === 'forge' || foundry;
  /** Grime layers over a metal face: grain, rust and (on vertical faces) soot pooling low. */
  const grit = (pts: V2[], suffix: string, vertical: boolean, rustiness = 1) =>
    forge
      ? `<polygon class="grit" points="${fmt(pts)}" fill="url(#grain${suffix})" opacity="0.55" />` +
        `<polygon class="grit" points="${fmt(pts)}" fill="url(#rust${suffix})" opacity="${(0.75 * rustiness).toFixed(2)}" />` +
        (vertical ? `<polygon class="grit" points="${fmt(pts)}" fill="url(#soot${suffix})" />` : '')
      : '';

  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, cls: string, rustiness = 1) => {
    const faces: { pts: V2[]; depth: number; light: number }[] = [];
    const v = (x: number, y: number, z: number) => P([x, y, z], false);
    // Only faces turned toward the camera are drawn, so a box never shows its inside
    // (that is what made the pipe and its clamps look like impossible shapes).
    const quad = (a: V3, b: V3, c: V3, d: V3, light: number, n: V3) => {
      const cx = (a[0] + c[0]) / 2;
      const cy = (a[1] + c[1]) / 2;
      const cz = (a[2] + c[2]) / 2;
      if (v(cx + n[0], cy + n[1], cz + n[2]).depth - v(cx, cy, cz).depth <= 1e-3) return;
      const pp = [a, b, c, d].map((q) => v(...q));
      faces.push({ pts: pp.map((q) => q.p), depth: pp.reduce((s, q) => s + q.depth, 0) / 4, light });
    };
    const top = faces.length;
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1, [0, 0, 1]); // top
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], faceLight(0, 1, view.yaw), [0, 1, 0]); // +y
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], faceLight(0, -1, view.yaw), [0, -1, 0]); // -y
    quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], faceLight(-1, 0, view.yaw), [-1, 0, 0]); // -x
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], faceLight(1, 0, view.yaw), [1, 0, 0]); // +x
    const topFace = faces.length > top ? faces[top] : undefined;
    faces.sort((a, b) => a.depth - b.depth);
    return faces
      .map((f) => {
        const fill = `<polygon class="${cls}" points="${fmt(f.pts)}" fill="${shade(pal.metal, f.light)}" />`;
        // A worn, lighter lip on top faces so edges catch the light.
        const lip = forge && f === topFace ? `<polygon class="edge-hi" points="${fmt(f.pts)}" />` : '';
        return fill + grit(f.pts, '-u', f !== topFace, rustiness) + lip;
      })
      .join('');
  };
  // Trestle stands: foot plate, post and a saddle clamped around the pipe.
  const front = Math.cos(view.yaw) >= 0 ? 1 : -1; // which y face points at the camera
  const bolt = (x: number, y: number, z: number) => {
    const [bx, by] = P([x, y, z], false).p;
    return forge ? `<circle class="bolt" cx="${bx.toFixed(1)}" cy="${by.toFixed(1)}" r="2.6" />` : '';
  };
  for (const sx of foundry ? [] : [-1, 1]) {
    const cx = sx * pipeX;
    out.push(box(cx - 22, cx + 22, -pipeA - 8, pipeA + 8, ground, ground + 6, 'stand'));
    out.push(box(cx - 7, cx + 7, -12, 12, ground + 6, pipeBot - 6, 'stand'));
    out.push(bolt(cx - 15, front * (pipeA + 8), ground + 3) + bolt(cx + 15, front * (pipeA + 8), ground + 3));
  }
  out.push(box(-pipeX - 14, pipeX + 14, -pipeA, pipeA, pipeBot, pipeTop, 'pipe', 1.4));
  if (forge) {
    // Flanged end caps on the square tube.
    for (const sx of [-1, 1]) out.push(box(sx * (pipeX + 14) - 2, sx * (pipeX + 14) + 2, -pipeA - 5, pipeA + 5, pipeBot - 5, pipeTop, 'pipe flange', 1.2));
    // A beaded weld seam along the near face of the square tube.
    const seam = Array.from({ length: 40 }, (_, i) => {
      const x = -pipeX - 10 + ((2 * pipeX + 20) * i) / 39;
      return P([x, front * pipeA, (pipeBot + pipeTop) / 2], false).p;
    });
    out.push(`<polyline class="weld" points="${fmt(seam)}" />`);
  }
  // In the foundry the axle is held by bearing blocks just outside the plate.
  for (const sx of [-1, 1]) {
    const cx = sx * (foundry ? PLATE_HALF_W + 46 : pipeX);
    out.push(box(cx - 11, cx + 11, -pipeA - 4, pipeA + 4, pipeBot - 6, pipeTop, 'stand saddle'));
    out.push(bolt(cx - 6, front * (pipeA + 4), pipeBot - 2) + bolt(cx + 6, front * (pipeA + 4), pipeBot - 2));
  }
  const under = out.splice(0, out.length);

  // Plate: side faces back-to-front, then the top face.
  const sides = PLATE.map((a, i) => {
    const b = PLATE[(i + 1) % PLATE.length];
    const pts = [P([a[0], a[1], 0]), P([b[0], b[1], 0]), P([b[0], b[1], -PLATE_T]), P([a[0], a[1], -PLATE_T])];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    return { pts: pts.map((q) => q.p), depth: pts.reduce((s, q) => s + q.depth, 0) / 4, light: faceLight(ey, -ex, view.yaw) };
  }).sort((a, b) => a.depth - b.depth);
  for (const s of sides) out.push(`<polygon class="plate-side" points="${fmt(s.pts)}" fill="${shade(pal.plateSide, s.light)}" />${grit(s.pts, '', true, 1.2)}`);
  const plateTop = fmt(PLATE.map(([x, y]) => P([x, y, 0]).p));
  out.push(`<polygon class="plate-top" points="${plateTop}" />`);
  if (forge) {
    out.push(`<polygon class="grain" points="${plateTop}" fill="url(#grain)" />`);
    out.push(`<polygon class="grit" points="${plateTop}" fill="url(#rust)" opacity="0.38" />`);
    out.push(`<polygon class="grit" points="${plateTop}" fill="url(#vignette)" />`);
  }

  // Each player's half gets a coloured rim along the plate edge; the two rims meet at
  // the pointed ends, right over the pipe.
  const inset = (k: number) => PLATE.map(([x, y]) => [x * k, y * k] as V2);
  const rimPts = inset(0.985);
  const rimPath = (idx: number[]) => fmt(idx.map((i) => P([rimPts[i][0], rimPts[i][1], 0]).p));
  out.push(`<polyline class="rim rim-red" points="${rimPath([5, 0, 1, 2])}" />`);
  out.push(`<polyline class="rim rim-blue" points="${rimPath([2, 3, 4, 5])}" />`);

  // Rivets around the forge plate.
  if (forge) {
    const rv = inset(0.955);
    for (let i = 0; i < rv.length; i++) {
      const [ax, ay] = rv[i];
      const [bx, by] = rv[(i + 1) % rv.length];
      const n = Math.max(2, Math.round(Math.hypot(bx - ax, by - ay) / 42));
      for (let k = 0; k < n; k++) {
        const t = (k + 0.5) / n;
        const [x, y] = P([ax + (bx - ax) * t, ay + (by - ay) * t, 0]).p;
        out.push(`<ellipse class="rivet" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="3.4" ry="${(3.4 * Math.sin(CAMERA_ELEVATION)).toFixed(1)}" />`);
      }
    }
  }

  /** Overheat countdowns, drawn above the stacks so a piece on the slot never hides them. */
  const heatBadges: [number, number, number][] = [];
  // Slots, grouped so a theme can light them all with one filter.
  out.push('<g class="slots">');
  const spawnOwner = new Map<number, Player>([...SPAWNS.red.map((id) => [id, 'red'] as const), ...SPAWNS.blue.map((id) => [id, 'blue'] as const)]);
  for (const { id } of CELLS) {
    const [cx, cy] = boardXY(id);
    const spawn = spawnOwner.get(id);
    const target = view.targets.get(id);
    const classes = ['slot', spawn ? `spawn spawn-${spawn}` : '', view.sources.has(id) ? 'is-source' : '', target ? `is-target target-${target}` : '']
      .filter(Boolean)
      .join(' ');
    const hex = (r: number) => fmt(hex2(cx, cy, r).map(([x, y]) => P([x, y, 0]).p));
    if (view.holes.has(id)) {
      // A hole straight through the plate. The opening shows the far inner wall; where the
      // bottom opening lines up with it you see straight through (clipped to the opening).
      const bottom = fmt(hex2(cx, cy, R - 4).map(([x, y]) => P([x, y, -PLATE_T]).p));
      out.push(
        `<g class="hole" data-id="${id}"><clipPath id="hole-${id}"><polygon points="${hex(R - 4)}" /></clipPath>` +
          `<polygon class="hole-wall" points="${hex(R - 4)}" /><polygon class="hole-through" points="${bottom}" clip-path="url(#hole-${id})" /></g>`,
      );
      continue;
    }
    const h = view.heat.get(id);
    const heatCls = h ? (h.cooldown > 0 ? 'overheated' : h.heat > 0 ? `heat-${Math.min(2, h.heat)}` : '') : '';
    if (heatCls) {
      const [tx, ty] = P([cx, cy, 0]).p;
      out.push(`<polygon class="heat-glow ${heatCls}" points="${hex(R - 3)}" />`);
      if (h!.cooldown > 1) heatBadges.push([tx, ty, h!.cooldown - 1]);
    }
    out.push(`<g class="${classes}" data-id="${id}"><polygon class="slot-hex" points="${hex(R - 3)}" />${spawn ? `<polygon class="spawn-ring" points="${hex(R - 8)}" />` : ''}</g>`);
  }
  out.push('</g>');

  /**
   * Affine transform that lays text flat on the plate at (x, y, z), upright for the camera,
   * so numbers lean and foreshorten with the stack tops.
   */
  const faceMatrix = (x: number, y: number, z: number) => {
    const ux: V2 = [Math.cos(view.yaw), -Math.sin(view.yaw)]; // board direction that reads as screen-right
    const uy: V2 = [Math.sin(view.yaw), Math.cos(view.yaw)]; // board direction that reads as screen-down
    const o = P([x, y, z]).p;
    const ex = P([x + ux[0], y + ux[1], z]).p;
    const ey = P([x + uy[0], y + uy[1], z]).p;
    return `matrix(${[ex[0] - o[0], ex[1] - o[1], ey[0] - o[0], ey[1] - o[1], o[0], o[1]].map((n) => n.toFixed(3)).join(' ')})`;
  };

  // Stacks, far to near. `tops` keeps each stack's projected top centre for badges and popovers.
  const tops = new Map<number, V2>();
  const order = view.stacks
    .map((stack, id) => ({ stack, id, depth: P([...boardXY(id), 0]).depth }))
    .filter((s): s is { stack: Stack; id: number; depth: number } => s.stack !== null && !view.hidden?.has(s.id))
    .sort((a, b) => a.depth - b.depth);
  for (const { stack, id } of order) {
    const [cx, cy] = boardXY(id);
    const r = R - 7;
    const height = Math.min(stack.count, MAX_LAYERS) * PIECE_H;
    const ring = hex2(cx, cy, r);
    const faces = ring
      .map((a, i) => {
        const b = ring[(i + 1) % 6];
        const pts = [P([a[0], a[1], 0]), P([b[0], b[1], 0]), P([b[0], b[1], height]), P([a[0], a[1], height])];
        const mid: V2 = [(a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cy];
        // Lines between individual pieces.
        const seams = Array.from({ length: Math.min(stack.count, MAX_LAYERS) - 1 }, (_, k) => {
          const z = (k + 1) * PIECE_H;
          const p1 = P([a[0], a[1], z]).p;
          const p2 = P([b[0], b[1], z]).p;
          return `<line class="seam" x1="${p1[0].toFixed(1)}" y1="${p1[1].toFixed(1)}" x2="${p2[0].toFixed(1)}" y2="${p2[1].toFixed(1)}" />`;
        }).join('');
        return {
          svg: `<polygon class="piece-side" points="${fmt(pts.map((q) => q.p))}" fill="${shade(pal.pieceSide, faceLight(mid[0], mid[1], view.yaw))}" />${forge ? `<polygon class="grit" points="${fmt(pts.map((q) => q.p))}" fill="url(#soot)" opacity="0.8" />` : ''}${seams}`,
          depth: pts.reduce((s, q) => s + q.depth, 0) / 4,
        };
      })
      .sort((a, b) => a.depth - b.depth)
      .map((f) => f.svg)
      .join('');
    const top = fmt(ring.map(([x, y]) => P([x, y, height]).p));
    const sheen = fmt(hex2(cx, cy, r - 6).map(([x, y]) => P([x, y, height]).p));
    const label = P([cx, cy, height]).p;
    tops.set(id, label);
    const target = view.targets.get(id);
    const hotFor = view.hot?.get(id);
    const classes = ['stack', `owner-${stack.owner}`, view.sources.has(id) ? 'is-source' : '', view.from === id ? 'is-from' : '', target ? `is-target target-${target}` : '', hotFor !== undefined ? 'hot' : '']
      .filter(Boolean)
      .join(' ');
    // Freshly worked metal glows and cools; the negative delay keeps the fade continuous across redraws.
    const glow =
      hotFor !== undefined
        ? `<g class="hot-glow" style="animation-delay:-${Math.round(hotFor)}ms">${ring
            .map((a, i) => {
              const b = ring[(i + 1) % 6];
              return `<polygon points="${fmt([P([a[0], a[1], 0]).p, P([b[0], b[1], 0]).p, P([b[0], b[1], height]).p, P([a[0], a[1], height]).p])}" />`;
            })
            .join('')}<polygon points="${top}" /></g>`
        : '';
    out.push(`<g class="${classes}" data-id="${id}">${faces}<polygon class="piece-top" points="${top}" />${forge ? `<polygon class="grit" points="${top}" fill="url(#grain)" opacity="0.7" />` : ''}${glow}<polygon class="piece-sheen" points="${sheen}" /><text class="piece-count" transform="${faceMatrix(cx, cy, height)}" y="6">${stack.count}</text></g>`);
  }

  // Destination outlines drawn above everything, so a tall stack in front never hides
  // or blocks the tile behind it. Each action kind has its own colour and marker.
  const ry = Math.sin(CAMERA_ELEVATION);
  for (const [id, kind] of view.targets) {
    const [cx, cy] = boardXY(id);
    const hex = fmt(hex2(cx, cy, R - 3).map(([x, y]) => P([x, y, 0]).p));
    out.push(`<polygon class="target-hit target-${kind}" data-id="${id}" points="${hex}" />`);
    // A stack being carried by an animation is not drawn, so it has no top: fall back to the cell.
    const top = view.stacks[id] ? tops.get(id) : undefined;
    const [x, y] = top ?? P([cx, cy, 0]).p;
    const at = `translate(${x.toFixed(1)} ${(top ? y - 22 : y).toFixed(1)})`;
    if (kind === 'move') {
      out.push(`<ellipse class="mark mark-move" data-id="${id}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="${(7 * ry).toFixed(1)}" />`);
    } else if (kind === 'spawn') {
      out.push(`<g class="mark mark-spawn" data-id="${id}" transform="${at}"><circle r="11" /><path d="M-6 0H6M0 -6V6" /></g>`);
    } else if (kind === 'split') {
      out.push(`<g class="mark mark-split" data-id="${id}" transform="${at}"><circle r="11" /><path d="M-5 5L5 -5" /><circle class="dot" cx="-3.5" cy="-3.5" r="1.6" /><circle class="dot" cx="3.5" cy="3.5" r="1.6" /></g>`);
    } else if (kind === 'merge') {
      out.push(`<g class="mark mark-merge" data-id="${id}" transform="${at}"><circle r="12" /><path d="M-6 -4L0 3L6 -4M-6 3H6" /></g>`);
    } else if (kind === 'convert') {
      out.push(`<g class="mark mark-convert" data-id="${id}" transform="${at}"><circle r="12" /><path d="M-5 -2A5 5 0 0 1 5 -2M5 -2L5 -6M5 2A5 5 0 0 1 -5 2M-5 2L-5 6" /></g>`);
    } else if (kind === 'strike') {
      out.push(`<g class="mark mark-strike" data-id="${id}" transform="${at}"><circle r="12" /><path d="M-5 -5L5 5M5 -5L-5 5" /></g>`);
    }
  }

  for (const [x, y, n] of heatBadges) {
    out.push(`<g class="heat-badge" transform="translate(${x.toFixed(1)} ${(y - 30).toFixed(1)})"><circle r="11" /><text y="5">${n}</text></g>`);
  }

  const viewBox = `${VIEWBOX.x.toFixed(0)} ${VIEWBOX.y.toFixed(0)} ${VIEWBOX.w.toFixed(0)} ${VIEWBOX.h.toFixed(0)}`;

  return {
    under: `<svg class="board-under" viewBox="${viewBox}" aria-hidden="true">${forge ? `<defs>${forgeDefs('-u')}</defs>` : ''}${under.join('')}</svg>`,
    board: `<svg class="board" viewBox="${viewBox}" role="img" aria-label="Hexagonal balance board">
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${pal.plateStops[0]}" /><stop offset="0.5" stop-color="${pal.plateStops[1]}" /><stop offset="1" stop-color="${pal.plateStops[2]}" />
      </linearGradient>
      <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${pal.steelStops[0]}" /><stop offset="0.45" stop-color="${pal.steelStops[1]}" /><stop offset="1" stop-color="${pal.steelStops[2]}" />
      </linearGradient>
      ${forge ? forgeDefs('') : ''}
    </defs>
    ${out.join('\n')}
  </svg>`,
  };
}
