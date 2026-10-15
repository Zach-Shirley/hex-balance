// Board geometry recovered from the photo of the original steel plate.
// Flat-top hexagonal cells arranged in 9 vertical columns. Each cell is
// addressed by its column and its vertical position `h` in half-cell units,
// so cells in the same column are 2 apart and neighbouring columns are offset by 1.
// Column cell counts (left to right): 2, 5, 8, 7, 8, 7, 8, 5, 2 = 52 cells.

export type Player = 'red' | 'blue';

export interface Cell {
  id: number;
  col: number;
  h: number;
}

const range = (from: number, to: number) => {
  const out: number[] = [];
  for (let v = from; v <= to; v += 2) out.push(v);
  return out;
};

const COLUMN_ROWS: number[][] = [
  range(6, 8),
  range(3, 11),
  range(0, 14),
  range(1, 13),
  range(0, 14),
  range(1, 13),
  range(0, 14),
  range(3, 11),
  range(6, 8),
];

/** Half-row position of the pivot pipe that runs left-to-right under the board. */
export const CENTER_H = 7;

export const CELLS: Cell[] = COLUMN_ROWS.flatMap((rows, col) => rows.map((h) => ({ col, h }))).map(
  (cell, id) => ({ id, ...cell }),
);

const byKey = new Map(CELLS.map((cell) => [`${cell.col},${cell.h}`, cell.id]));

export function cellAt(col: number, h: number): number | undefined {
  return byKey.get(`${col},${h}`);
}

/** The six neighbour directions for flat-top cells: N, NE, SE, S, SW, NW. */
export const DIRECTIONS: ReadonlyArray<readonly [number, number]> = [
  [0, -2],
  [1, -1],
  [1, 1],
  [0, 2],
  [-1, 1],
  [-1, -1],
];

export function step(id: number, dir: number, distance = 1): number | undefined {
  const cell = CELLS[id];
  const [dc, dh] = DIRECTIONS[dir];
  return cellAt(cell.col + dc * distance, cell.h + dh * distance);
}

export function neighbors(id: number): number[] {
  return DIRECTIONS.map((_, dir) => step(id, dir)).filter((n): n is number => n !== undefined);
}

/** Red sits at the top of the photo, Blue at the bottom. */
export const SPAWNS: Record<Player, number[]> = {
  red: [2, 4, 6].map((col) => cellAt(col, 0)!),
  blue: [2, 4, 6].map((col) => cellAt(col, 14)!),
};

/**
 * Signed lever arm in cell heights from the pivot line.
 * Negative = Red's half (top), positive = Blue's half (bottom).
 */
export function leverArm(id: number): number {
  return (CELLS[id].h - CENTER_H) / 2;
}

export function sideOf(id: number): Player | null {
  const arm = leverArm(id);
  if (arm === 0) return null;
  return arm < 0 ? 'red' : 'blue';
}
