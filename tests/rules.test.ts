import { describe, expect, it } from 'vitest';
import { CELLS, SPAWNS, cellAt, leverArm, neighbors } from '../src/board';
import {
  applyAction,
  balance,
  legalActions,
  newGame,
  roll,
  skipDie,
  type DieFace,
  type GameState,
  type Stack,
} from '../src/rules';

const facesRandom = (...faces: number[]) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};

function withDice(state: GameState, a: DieFace, b: DieFace): GameState {
  return roll(state, facesRandom(a, b));
}

function emptyGame(): GameState {
  return newGame({ boardMass: 120, pipeHalfWidth: 0.35, startingPieces: 0 });
}

function place(state: GameState, id: number, stack: Stack): GameState {
  const stacks = state.stacks.slice();
  stacks[id] = stack;
  return { ...state, stacks };
}

describe('board geometry', () => {
  it('matches the photographed plate: 52 cells in columns of 2,5,8,7,8,7,8,5,2', () => {
    expect(CELLS).toHaveLength(52);
    const perColumn = Array.from({ length: 9 }, (_, col) => CELLS.filter((c) => c.col === col).length);
    expect(perColumn).toEqual([2, 5, 8, 7, 8, 7, 8, 5, 2]);
  });

  it('is mirror symmetric across the pivot so an empty board balances', () => {
    expect(CELLS.reduce((sum, c) => sum + leverArm(c.id), 0)).toBe(0);
  });

  it('puts three spawn slots on each outer edge', () => {
    expect(SPAWNS.red.map((id) => leverArm(id))).toEqual([-3.5, -3.5, -3.5]);
    expect(SPAWNS.blue.map((id) => leverArm(id))).toEqual([3.5, 3.5, 3.5]);
  });

  it('gives interior cells six neighbours', () => {
    expect(neighbors(cellAt(4, 6)!)).toHaveLength(6);
    expect(neighbors(cellAt(0, 6)!).length).toBeLessThan(6);
  });
});

describe('balance', () => {
  it('starts level with symmetric starting pieces', () => {
    expect(balance(newGame()).torque).toBe(0);
  });

  it('tips toward Blue and Red wins once enough weight sits on Blue’s edge', () => {
    let state = emptyGame();
    state = place(state, SPAWNS.blue[1], { owner: 'red', count: 11 });
    state = place(state, cellAt(4, 2)!, { owner: 'red', count: 1 });
    state = withDice(state, 5, 5);
    // 11 pieces at 3.5 = 38.5, threshold 0.35 * 132 = 46.2 → standing.
    expect(state.phase).toBe('act');
    state = applyAction(state, 0, { kind: 'reinforce', to: SPAWNS.blue[1] });
    state = applyAction(state, 1, { kind: 'reinforce', to: SPAWNS.blue[1] });
    // 13 * 3.5 = 45.5 - 2.5 = 43 vs 0.35 * 134 = 46.9 → still standing
    expect(state.phase).toBe('roll');
    state = { ...state, turn: 'red' };
    state = withDice(state, 5, 5);
    state = applyAction(state, 0, { kind: 'reinforce', to: SPAWNS.blue[1] });
    state = applyAction(state, 1, { kind: 'reinforce', to: SPAWNS.blue[1] });
    expect(state.phase).toBe('over');
    expect(state.loser).toBe('blue');
  });
});

describe('actions', () => {
  it('spawn uses your own spawn slots unless an enemy stack blocks them', () => {
    let state = place(emptyGame(), SPAWNS.red[0], { owner: 'blue', count: 3 });
    state = place(state, SPAWNS.red[1], { owner: 'red', count: 2 });
    state = withDice(state, 1, 1);
    expect(legalActions(state, 'spawn').map((a) => a.to)).toEqual([SPAWNS.red[1], SPAWNS.red[2]]);
    state = applyAction(state, 0, { kind: 'spawn', to: SPAWNS.red[1] });
    expect(state.stacks[SPAWNS.red[1]]).toEqual({ owner: 'red', count: 3 });
  });

  it('move can step to an empty neighbour or jump an adjacent stack', () => {
    const from = cellAt(4, 6)!;
    const blocker = cellAt(4, 8)!;
    let state = place(emptyGame(), from, { owner: 'red', count: 2 });
    state = place(state, blocker, { owner: 'blue', count: 1 });
    state = withDice(state, 2, 2);
    const moves = legalActions(state, 'move');
    expect(moves.some((m) => m.to === blocker)).toBe(false);
    expect(moves).toContainEqual({ kind: 'move', from, to: cellAt(4, 10)!, jump: true });
    state = applyAction(state, 0, { kind: 'move', from, to: cellAt(4, 10)!, jump: true });
    expect(state.stacks[cellAt(4, 10)!]).toEqual({ owner: 'red', count: 2 });
    expect(state.stacks[from]).toBeNull();
  });

  it('merge combines adjacent friendly stacks', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 2 });
    state = place(state, cellAt(5, 7)!, { owner: 'red', count: 3 });
    state = withDice(state, 3, 6);
    state = applyAction(state, 0, { kind: 'merge', from: cellAt(4, 6)!, to: cellAt(5, 7)! });
    expect(state.stacks[cellAt(5, 7)!]).toEqual({ owner: 'red', count: 5 });
  });

  it('strike removes one piece and clears a stack of one', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 1 });
    state = place(state, cellAt(4, 8)!, { owner: 'blue', count: 1 });
    state = withDice(state, 4, 2);
    state = applyAction(state, 0, { kind: 'strike', from: cellAt(4, 6)!, to: cellAt(4, 8)! });
    expect(state.stacks[cellAt(4, 8)!]).toBeNull();
  });

  it('rejects an action the die does not allow', () => {
    const state = withDice(newGame(), 1, 1);
    expect(() => applyAction(state, 0, { kind: 'reinforce', to: SPAWNS.red[0] })).toThrow();
  });

  it('passes the turn after both dice are used or skipped', () => {
    let state = withDice(newGame(), 3, 3);
    state = skipDie(state, 0);
    expect(state.turn).toBe('red');
    state = skipDie(state, 1);
    expect(state.turn).toBe('blue');
    expect(state.phase).toBe('roll');
  });
});
