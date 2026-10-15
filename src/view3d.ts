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

type V2 = [number, number];
type V3 = [number, number, number];

const midCol = 4;
const boardXY = (id: number): V2 => [(CELLS[id].col - midCol) * 1.5 * R, (CELLS[id].h - CENTER_H) * HALF_H];

function hex2(cx: number, cy: number, r: number): V2[] {
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

interface Camera {
  lean: number; // radians; positive sinks the Blue (bottom, +y) edge
  yaw: number; // radians about the vertical axis
}

/** Board point → world (applies the lean about the pipe) → screen. */
function project([x, y, z]: V3, cam: Camera, leans = true): { p: V2; depth: number } {
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
  const P = (v: V3, leans = true) => project(v, cam, leans);
  const out: string[] = [];

  // Ground shadow and the pipe with its stands (the pipe does not lean).
  const pipeA = Math.max(5, view.pipeHalfWidth * 2 * HALF_H);
  const pipeTop = -PLATE_T;
  const pipeBot = -PLATE_T - 2 * pipeA;
  const ground = pipeBot - 70;
  const pipeX = PLATE_HALF_W + 30;
  const shadow = [-1, 1].flatMap((sx) => [-1, 1].map((sy) => P([sx * (PLATE_HALF_W + 10), sy * 230, ground], false).p));
  out.push(`<polygon class="ground-shadow" points="${fmt([shadow[0], shadow[1], shadow[3], shadow[2]])}" />`);

  const box = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, cls: string) => {
    const faces: { pts: V2[]; depth: number; light: number }[] = [];
    const v = (x: number, y: number, z: number) => P([x, y, z], false);
    const quad = (a: V3, b: V3, c: V3, d: V3, light: number) => {
      const pp = [a, b, c, d].map((q) => v(...q));
      faces.push({ pts: pp.map((q) => q.p), depth: pp.reduce((s, q) => s + q.depth, 0) / 4, light });
    };
    quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], 1); // top
    quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], faceLight(0, 1, view.yaw)); // +y
    quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], faceLight(0, -1, view.yaw)); // -y
    quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], faceLight(-1, 0, view.yaw)); // -x
    quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], faceLight(1, 0, view.yaw)); // +x
    faces.sort((a, b) => a.depth - b.depth);
    return faces.map((f) => `<polygon class="${cls}" points="${fmt(f.pts)}" fill="${shade([150, 156, 166], f.light)}" />`).join('');
  };
  for (const sx of [-1, 1]) out.push(box(sx * pipeX - 9, sx * pipeX + 9, -16, 16, ground, pipeBot, 'stand'));
  out.push(box(-pipeX - 14, pipeX + 14, -pipeA, pipeA, pipeBot, pipeTop, 'pipe'));
  const under = out.splice(0, out.length);

  // Plate: side faces back-to-front, then the top face.
  const sides = PLATE.map((a, i) => {
    const b = PLATE[(i + 1) % PLATE.length];
    const pts = [P([a[0], a[1], 0]), P([b[0], b[1], 0]), P([b[0], b[1], -PLATE_T]), P([a[0], a[1], -PLATE_T])];
    const [ex, ey] = [b[0] - a[0], b[1] - a[1]];
    return { pts: pts.map((q) => q.p), depth: pts.reduce((s, q) => s + q.depth, 0) / 4, light: faceLight(ey, -ex, view.yaw) };
  }).sort((a, b) => a.depth - b.depth);
  for (const s of sides) out.push(`<polygon class="plate-side" points="${fmt(s.pts)}" fill="${shade([92, 98, 108], s.light)}" />`);
  out.push(`<polygon class="plate-top" points="${fmt(PLATE.map(([x, y]) => P([x, y, 0]).p))}" />`);

  // Pivot line drawn on the plate surface.
  out.push(`<line class="pivot-line" x1="${P([-PLATE_HALF_W + 14, 0, 0]).p[0]}" y1="${P([-PLATE_HALF_W + 14, 0, 0]).p[1]}" x2="${P([PLATE_HALF_W - 14, 0, 0]).p[0]}" y2="${P([PLATE_HALF_W - 14, 0, 0]).p[1]}" />`);

  // Slots.
  const spawnOwner = new Map<number, Player>([...SPAWNS.red.map((id) => [id, 'red'] as const), ...SPAWNS.blue.map((id) => [id, 'blue'] as const)]);
  for (const { id } of CELLS) {
    const [cx, cy] = boardXY(id);
    const spawn = spawnOwner.get(id);
    const target = view.targets.get(id);
    const classes = ['slot', spawn ? `spawn spawn-${spawn}` : '', view.sources.has(id) ? 'is-source' : '', target ? `is-target target-${target}` : '']
      .filter(Boolean)
      .join(' ');
    const hex = (r: number) => fmt(hex2(cx, cy, r).map(([x, y]) => P([x, y, 0]).p));
    out.push(`<g class="${classes}" data-id="${id}"><polygon class="slot-hex" points="${hex(R - 3)}" />${spawn ? `<polygon class="spawn-ring" points="${hex(R - 8)}" />` : ''}</g>`);
  }

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
    .filter((s): s is { stack: Stack; id: number; depth: number } => s.stack !== null)
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
          svg: `<polygon class="piece-side" points="${fmt(pts.map((q) => q.p))}" fill="${shade([205, 210, 217], faceLight(mid[0], mid[1], view.yaw))}" />${seams}`,
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
    const classes = ['stack', `owner-${stack.owner}`, view.sources.has(id) ? 'is-source' : '', view.from === id ? 'is-from' : '', target ? `is-target target-${target}` : '']
      .filter(Boolean)
      .join(' ');
    out.push(`<g class="${classes}" data-id="${id}">${faces}<polygon class="piece-top" points="${top}" /><polygon class="piece-sheen" points="${sheen}" /><text class="piece-count" transform="${faceMatrix(cx, cy, height)}" y="6">${stack.count}</text></g>`);
  }

  // Destination outlines drawn above everything, so a tall stack in front never hides
  // or blocks the tile behind it. Each action kind has its own colour and marker.
  const ry = Math.sin(CAMERA_ELEVATION);
  for (const [id, kind] of view.targets) {
    const [cx, cy] = boardXY(id);
    const hex = fmt(hex2(cx, cy, R - 3).map(([x, y]) => P([x, y, 0]).p));
    out.push(`<polygon class="target-hit target-${kind}" data-id="${id}" points="${hex}" />`);
    const [x, y] = view.stacks[id] ? tops.get(id)! : P([cx, cy, 0]).p;
    const at = `translate(${x.toFixed(1)} ${(view.stacks[id] ? y - 22 : y).toFixed(1)})`;
    if (kind === 'move') {
      out.push(`<ellipse class="mark mark-move" data-id="${id}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" rx="7" ry="${(7 * ry).toFixed(1)}" />`);
    } else if (kind === 'spawn') {
      out.push(`<g class="mark mark-spawn" data-id="${id}" transform="${at}"><circle r="11" /><path d="M-6 0H6M0 -6V6" /></g>`);
    } else if (kind === 'merge') {
      out.push(`<g class="mark mark-merge" data-id="${id}" transform="${at}"><circle r="12" /><path d="M-6 -4L0 3L6 -4M-6 3H6" /></g>`);
    } else if (kind === 'strike') {
      out.push(`<g class="mark mark-strike" data-id="${id}" transform="${at}"><circle r="12" /><path d="M-5 -5L5 5M5 -5L-5 5" /></g>`);
    }
  }

  const viewBox = `${VIEWBOX.x.toFixed(0)} ${VIEWBOX.y.toFixed(0)} ${VIEWBOX.w.toFixed(0)} ${VIEWBOX.h.toFixed(0)}`;

  return {
    under: `<svg class="board-under" viewBox="${viewBox}" aria-hidden="true">${under.join('')}</svg>`,
    board: `<svg class="board" viewBox="${viewBox}" role="img" aria-label="Hexagonal balance board">
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#454b54" /><stop offset="0.5" stop-color="#30343b" /><stop offset="1" stop-color="#22252b" />
      </linearGradient>
      <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#eef1f4" /><stop offset="0.45" stop-color="#b3bac3" /><stop offset="1" stop-color="#858c96" />
      </linearGradient>
    </defs>
    ${out.join('\n')}
  </svg>`,
  };
}
