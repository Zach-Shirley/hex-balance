import { describe, expect, it } from 'vitest';
import { CELLS, SPAWNS, cellAt, leverArm, neighbors } from '../src/board';
import {
  applyAction,
  balance,
  legalActions,
  newGame,
  roll,
  skipDie,
  playableActions,
  canPass,
  piecesOf,
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
  return newGame({ boardMass: 120, pipeHalfWidth: 0.35, startingPieces: 0, forcedMoves: false, doubleCombos: false, diceCount: 2, pieceLimit: 0 });
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

  it('forced moves block passing on a playable die but allow passing a dead one', () => {
    let state = withDice(newGame({ ...newGame().settings, forcedMoves: true }), 5, 4);
    expect(() => skipDie(state, 0)).toThrow();
    state = skipDie(state, 1); // strike has no target at the start
    expect(state.dice[1].used).toBe(true);
  });

  it('lists each playable action once and prefers a specific die over the wild one', () => {
    const state = withDice(newGame(), 5, 6);
    const playable = playableActions(state);
    const reinforce = playable.filter((p) => p.action.kind === 'reinforce');
    expect(reinforce).toHaveLength(3);
    expect(reinforce.every((p) => p.die === 0)).toBe(true);
    expect(playable.some((p) => p.action.kind === 'move' && p.die === 1)).toBe(true);
  });
});

describe('experiments', () => {
  const combos = (extra = {}) => newGame({ ...newGame().settings, doubleCombos: true, ...extra });

  it('snake eyes gives three forced spawns that cannot be passed', () => {
    const state = withDice(combos(), 1, 1);
    expect(state.combo?.name).toBe('Snake eyes');
    expect(state.dice).toHaveLength(3);
    expect(state.dice.every((d) => d.forced && d.action === 'spawn')).toBe(true);
    expect(canPass(state, 0)).toBe(false);
  });

  it('double fours convert an adjacent enemy stack of up to three', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 1 });
    state = place(state, cellAt(4, 8)!, { owner: 'blue', count: 3 });
    state = { ...state, settings: { ...state.settings, doubleCombos: true } };
    state = withDice(state, 4, 4);
    expect(state.dice).toHaveLength(1);
    state = applyAction(state, 0, { kind: 'convert', from: cellAt(4, 6)!, to: cellAt(4, 8)! });
    expect(state.stacks[cellAt(4, 8)!]).toEqual({ owner: 'red', count: 3 });
  });

  it('jackpot grants a bonus roll to the same player without chaining combos', () => {
    let state = withDice(combos(), 6, 6);
    state = skipDie(skipDie(state, 0), 1);
    expect(state.turn).toBe('red');
    expect(state.phase).toBe('roll');
    state = withDice(state, 1, 1);
    expect(state.combo).toBeNull();
    expect(state.dice).toHaveLength(2);
  });

  it('three-dice mode rolls three dice and triples trigger their own combo', () => {
    const three = withDice2(combos({ diceCount: 3 }), [5, 2, 3]);
    expect(three.dice).toHaveLength(3);
    const triple = withDice2(combos({ diceCount: 3 }), [6, 6, 6]);
    expect(triple.combo?.name).toBe('Mother lode');
    expect(triple.bonusRoll).toBe(true);
  });

  it('piece limit blocks spawning and reinforcing at the cap', () => {
    const state = withDice(newGame({ ...newGame().settings, pieceLimit: 3 }), 1, 5);
    expect(piecesOf(state, 'red')).toBe(3);
    expect(playableActions(state).filter((p) => p.action.kind === 'spawn' || p.action.kind === 'reinforce')).toHaveLength(0);
  });
});

function withDice2(state: GameState, faces: number[]): GameState {
  return roll(state, facesRandom(...faces));
}

