import { describe, expect, it } from 'vitest';
import { CELLS, SPAWNS, cellAt, leverArm, neighbors } from '../src/board';
import {
  DEFAULT_SETTINGS,
  applyAction,
  balance,
  canPass,
  chooseCombo,
  isOverheated,
  legalActions,
  newGame,
  normalizeSettings,
  piecesOf,
  playableActions,
  roll,
  skipDie,
  type GameState,
  type Settings,
  type Stack,
} from '../src/rules';

const facesRandom = (...faces: number[]) => {
  let i = 0;
  return () => (faces[i++ % faces.length] - 1) / 6 + 0.01;
};

function rolled(state: GameState, ...faces: number[]): GameState {
  return roll(state, facesRandom(...faces));
}

const game = (extra: Partial<Settings> = {}) => newGame({ ...DEFAULT_SETTINGS, ...extra });
const emptyGame = (extra: Partial<Settings> = {}) => game({ startingPieces: 0, ...extra });

function place(state: GameState, id: number, stack: Stack): GameState {
  const stacks = state.stacks.slice();
  stacks[id] = stack;
  return { ...state, stacks };
}

/** Pass every remaining die (dead or not) to end the turn. */
const passAll = (state: GameState) => state.dice.reduce((s, d, i) => (d.used || s.phase !== 'act' ? s : skipDie(s, i)), state);
/** Play a turn that does nothing (a non-double roll, every die passed). */
const idleTurn = (state: GameState) => passAll(rolled(state, 2, 4));

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
    expect(balance(game()).torque).toBe(0);
  });

  it('tips toward Blue (Red wins) once torque reaches the threshold', () => {
    let state = place(emptyGame({ boardMass: 40 }), SPAWNS.blue[1], { owner: 'red', count: 6 });
    state = place(state, cellAt(4, 6)!, { owner: 'red', count: 1 });
    // Locked half-width 0.5: 6 × 3.5 − 0.5 = 20.5 vs 0.5 × (40 + 7) = 23.5, standing.
    state = rolled(state, 5, 2);
    expect(state.phase).toBe('act');
    state = applyAction(state, 0, { kind: 'reinforce', to: SPAWNS.blue[1] });
    // 7 × 3.5 − 0.5 = 24 vs 0.5 × 48 = 24: tips.
    expect(state.phase).toBe('over');
    expect(state.loser).toBe('blue');
  });
});

describe('actions', () => {
  it('spawn uses your own spawn slots unless an enemy stack blocks them', () => {
    let state = place(emptyGame(), SPAWNS.red[0], { owner: 'blue', count: 3 });
    state = place(state, SPAWNS.red[1], { owner: 'red', count: 2 });
    state = rolled(state, 1, 2);
    expect(legalActions(state, 'spawn').map((a) => a.to)).toEqual([SPAWNS.red[1], SPAWNS.red[2]]);
    state = applyAction(state, 0, { kind: 'spawn', to: SPAWNS.red[1] });
    expect(state.stacks[SPAWNS.red[1]]).toEqual({ owner: 'red', count: 3 });
  });

  it('move can step to an empty neighbour or jump an adjacent stack', () => {
    const from = cellAt(4, 6)!;
    const blocker = cellAt(4, 8)!;
    let state = place(emptyGame(), from, { owner: 'red', count: 2 });
    state = place(state, blocker, { owner: 'blue', count: 1 });
    state = rolled(state, 2, 5);
    expect(legalActions(state, 'move').some((m) => m.to === blocker)).toBe(false);
    state = applyAction(state, 0, { kind: 'move', from, to: cellAt(4, 10)!, jump: true });
    expect(state.stacks[cellAt(4, 10)!]).toEqual({ owner: 'red', count: 2 });
    expect(state.stacks[from]).toBeNull();
  });

  it('a 3 offers merge: two adjacent friendly stacks combine', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 2 });
    state = place(state, cellAt(5, 7)!, { owner: 'red', count: 3 });
    state = rolled(state, 3, 5);
    state = applyAction(state, 0, { kind: 'merge', from: cellAt(4, 6)!, to: cellAt(5, 7)! });
    expect(state.stacks[cellAt(5, 7)!]).toEqual({ owner: 'red', count: 5 });
  });

  it('a 3 also offers split: half a stack, rounded down, moves to an adjacent empty cell', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 7 });
    state = rolled(state, 3, 5);
    state = applyAction(state, 0, { kind: 'split', from: cellAt(4, 6)!, to: cellAt(4, 8)! });
    expect(state.stacks[cellAt(4, 6)!]).toEqual({ owner: 'red', count: 4 });
    expect(state.stacks[cellAt(4, 8)!]).toEqual({ owner: 'red', count: 3 });
  });

  it('a single piece cannot split', () => {
    const state = rolled(place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 1 }), 3, 5);
    expect(legalActions(state, 'split')).toHaveLength(0);
  });

  it('strike removes one piece and clears a stack of one', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 1 });
    state = place(state, cellAt(4, 8)!, { owner: 'blue', count: 1 });
    state = rolled(state, 4, 2);
    state = applyAction(state, 0, { kind: 'strike', from: cellAt(4, 6)!, to: cellAt(4, 8)! });
    expect(state.stacks[cellAt(4, 8)!]).toBeNull();
  });

  it('rejects an action the die does not allow', () => {
    const state = rolled(game(), 1, 2);
    expect(() => applyAction(state, 0, { kind: 'reinforce', to: SPAWNS.red[0] })).toThrow();
  });

  it('passes the turn after both dice are used or skipped', () => {
    let state = rolled(game(), 3, 4);
    state = skipDie(state, 0);
    expect(state.turn).toBe('red');
    state = skipDie(state, 1);
    expect(state.turn).toBe('blue');
    expect(state.phase).toBe('roll');
  });

  it('forced moves block passing on a playable die but allow passing a dead one', () => {
    let state = rolled(game({ forcedMoves: true }), 5, 4);
    expect(() => skipDie(state, 0)).toThrow();
    state = skipDie(state, 1); // strike has no target at the start
    expect(state.dice[1].used).toBe(true);
  });

  it('lists each playable action once and prefers a specific die over the wild one', () => {
    const state = rolled(game(), 5, 6);
    const playable = playableActions(state);
    const reinforce = playable.filter((p) => p.action.kind === 'reinforce');
    expect(reinforce).toHaveLength(3);
    expect(reinforce.every((p) => p.die === 0)).toBe(true);
    expect(playable.some((p) => p.action.kind === 'move' && p.die === 1)).toBe(true);
  });

  it('normalizes old saved settings and drops retired keys', () => {
    const s = normalizeSettings({ boardMass: 30, pipeHalfWidth: 0.25, doubleCombos: false } as never);
    expect(s.boardMass).toBe(30);
    expect('pipeHalfWidth' in s).toBe(false);
    expect(s.overheat).toBe(false);
  });
});

describe('combos (core rule)', () => {
  it('snake eyes gives three forced spawns that cannot be passed', () => {
    const state = rolled(game(), 1, 1);
    expect(state.combo?.name).toBe('Snake eyes');
    expect(state.dice).toHaveLength(3);
    expect(state.dice.every((d) => d.forced && d.action === 'spawn')).toBe(true);
    expect(canPass(state, 0)).toBe(false);
  });

  it('weld gives two merge/splits and two moves', () => {
    const state = rolled(game(), 3, 3);
    expect(state.combo?.name).toBe('Weld');
    expect(state.dice.map((d) => d.action)).toEqual(['mergesplit', 'mergesplit', 'move', 'move']);
  });

  it('double fours convert an adjacent enemy stack of up to three', () => {
    let state = place(emptyGame(), cellAt(4, 6)!, { owner: 'red', count: 1 });
    state = place(state, cellAt(4, 8)!, { owner: 'blue', count: 3 });
    state = rolled(state, 4, 4);
    expect(state.dice).toHaveLength(1);
    state = applyAction(state, 0, { kind: 'convert', from: cellAt(4, 6)!, to: cellAt(4, 8)! });
    expect(state.stacks[cellAt(4, 8)!]).toEqual({ owner: 'red', count: 3 });
  });

  it('jackpot grants a bonus roll; combos still apply on it but cannot chain another roll', () => {
    let state = passAll(rolled(game(), 6, 6));
    expect(state.turn).toBe('red');
    expect(state.phase).toBe('roll');
    state = rolled(state, 6, 6);
    expect(state.combo?.name).toBe('Jackpot');
    expect(state.bonusRoll).toBe(false);
  });

  it('a pair counts wherever the matching dice sit in a three-dice roll', () => {
    for (const faces of [[4, 2, 4], [4, 4, 2], [2, 4, 4]]) {
      expect(rolled(game({ diceCount: 3 }), ...faces).combo?.name).toBe('Convert');
    }
  });

  it('triple sixes let the player pick a double combo, then roll again', () => {
    let state = rolled(game({ diceCount: 3 }), 6, 6, 6);
    expect(state.comboChoice).toBe(true);
    expect(() => chooseCombo(state, 1)).toThrow();
    state = chooseCombo(state, 2);
    expect(state.dice.filter((d) => d.action === 'move')).toHaveLength(4);
    state = passAll(state);
    expect(state.turn).toBe('red');
    expect(state.isBonusRoll).toBe(true);
  });
});

describe('experiments', () => {
  it('piece limit blocks spawning and reinforcing at the cap', () => {
    const state = rolled(game({ pieceLimit: 3 }), 1, 5);
    expect(piecesOf(state, 'red')).toBe(3);
    expect(playableActions(state).filter((p) => p.action.kind === 'spawn' || p.action.kind === 'reinforce')).toHaveLength(0);
  });

  it('overheat: three spawns on one slot lock it for the owner’s next two turns', () => {
    const slot = SPAWNS.red[1];
    let state = rolled(game({ overheat: true }), 1, 1); // snake eyes: three spawns
    for (let i = 0; i < 3; i++) state = applyAction(state, i, { kind: 'spawn', to: slot });
    expect(state.event).toMatch(/overheated/);
    expect(state.turn).toBe('blue');
    state = idleTurn(state); // blue
    expect(isOverheated(state, slot)).toBe(true); // red, next turn: locked
    expect(legalActions(rolled(state, 1, 2), 'spawn').some((a) => a.to === slot)).toBe(false);
    state = idleTurn(idleTurn(state)); // red, blue
    expect(isOverheated(state, slot)).toBe(true); // red, second turn: still locked
    state = idleTurn(idleTurn(state));
    expect(isOverheated(state, slot)).toBe(false); // cooled
  });

  it('tower break: a tower made taller than the hidden limit falls through and leaves a hole', () => {
    let state = emptyGame({ towerBreak: true });
    state = { ...state, breakLimit: 5 };
    state = place(state, cellAt(4, 6)!, { owner: 'red', count: 5 });
    state = rolled(state, 5, 2);
    state = applyAction(state, 0, { kind: 'reinforce', to: cellAt(4, 6)! });
    expect(state.stacks[cellAt(4, 6)!]).toBeNull();
    expect(state.holes).toContain(cellAt(4, 6)!);
    expect(state.breakLimit).toBeGreaterThanOrEqual(5); // a new limit was rolled
    state = place(state, cellAt(4, 4)!, { owner: 'red', count: 1 });
    expect(legalActions(state, 'move').some((a) => a.to === cellAt(4, 6)!)).toBe(false);
  });

  it('tower break uses one limit for every tower, and reaching it exactly is safe', () => {
    let state = emptyGame({ towerBreak: true, boardMass: 400 });
    state = { ...state, breakLimit: 7 };
    state = place(state, cellAt(2, 4)!, { owner: 'red', count: 6 });
    state = place(state, cellAt(6, 4)!, { owner: 'red', count: 6 });
    state = rolled(state, 5, 5); // supply drop: three reinforcements
    state = applyAction(state, 0, { kind: 'reinforce', to: cellAt(2, 4)! }); // 7: at the limit, safe
    expect(state.stacks[cellAt(2, 4)!]?.count).toBe(7);
    state = applyAction(state, 1, { kind: 'reinforce', to: cellAt(6, 4)! }); // 7 on another tile: same limit, safe
    expect(state.stacks[cellAt(6, 4)!]?.count).toBe(7);
    state = applyAction(state, 2, { kind: 'reinforce', to: cellAt(2, 4)! }); // 8: breaks
    expect(state.stacks[cellAt(2, 4)!]).toBeNull();
  });

  it('moving a tall tower never breaks it', () => {
    let state = emptyGame({ towerBreak: true });
    state = { ...state, breakLimit: 5 };
    state = place(state, cellAt(4, 6)!, { owner: 'red', count: 9 }); // already over (e.g. limit re-rolled lower)
    state = rolled(state, 2, 4);
    state = applyAction(state, 0, { kind: 'move', from: cellAt(4, 6)!, to: cellAt(4, 8)!, jump: false });
    expect(state.stacks[cellAt(4, 8)!]?.count).toBe(9);
  });

  it('tower break limits are hidden but always between 5 and 12', () => {
    for (let i = 0; i < 50; i++) {
      const n = game({ towerBreak: true }).breakLimit!;
      expect(n >= 5 && n <= 12).toBe(true);
    }
  });
});
