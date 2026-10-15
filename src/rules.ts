import { CELLS, DIRECTIONS, SPAWNS, leverArm, neighbors, step, type Player } from './board';

export type { Player } from './board';

export interface Stack {
  owner: Player;
  count: number;
}

export type ActionKind = 'spawn' | 'move' | 'merge' | 'strike' | 'reinforce';
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;

/** Recovered die meanings. 4 (strike) is a best guess; 6 is wild. */
export const DIE_ACTIONS: Record<DieFace, ActionKind | 'wild'> = {
  1: 'spawn',
  2: 'move',
  3: 'merge',
  4: 'strike',
  5: 'reinforce',
  6: 'wild',
};

export const ACTION_LABELS: Record<ActionKind, string> = {
  spawn: 'Spawn',
  move: 'Move / jump',
  merge: 'Merge',
  strike: 'Strike',
  reinforce: 'Reinforce',
};

export const ACTION_HELP: Record<ActionKind, string> = {
  spawn: 'Place a new piece on one of your spawn slots, empty or already holding your stack. Enemy stacks block a slot.',
  move: 'Move one of your stacks one cell, or jump it over an adjacent stack to the empty cell beyond.',
  merge: 'Move one of your stacks onto an adjacent stack of yours. They combine.',
  strike: 'One of your stacks knocks one piece off an adjacent enemy stack.',
  reinforce: 'Add one piece to any stack you control.',
};

export type Action =
  | { kind: 'spawn'; to: number }
  | { kind: 'move'; from: number; to: number; jump: boolean }
  | { kind: 'merge'; from: number; to: number }
  | { kind: 'strike'; from: number; to: number }
  | { kind: 'reinforce'; to: number };

export interface Settings {
  /** Mass of the steel plate, in piece-weights. */
  boardMass: number;
  /** Half the width of the square pivot pipe, in cell heights. */
  pipeHalfWidth: number;
  /** Pieces each player starts with on each spawn slot. */
  startingPieces: number;
  /** When on, a die must be used if it has any legal action; passing is only for dead dice. */
  forcedMoves: boolean;
}

// Rough physical estimate: ~3 cm cells, 1 cm plate, 0.5 cm pieces and a
// 1-inch pipe gives a plate of ~145 piece-weights and a half-width of ~0.42.
// Bot playtests at that weight mostly stalemated, because both sides keep
// cancelling each other's torque. These lighter defaults let games end
// (median ~19 rounds between greedy bots) and stay adjustable in the UI.
export const DEFAULT_SETTINGS: Settings = {
  boardMass: 40,
  pipeHalfWidth: 0.25,
  startingPieces: 1,
  forcedMoves: false,
};

export interface Die {
  face: DieFace;
  used: boolean;
}

export interface GameState {
  settings: Settings;
  stacks: (Stack | null)[];
  turn: Player;
  turnNumber: number;
  phase: 'roll' | 'act' | 'over';
  dice: Die[];
  loser: Player | null;
  log: string[];
}

export const other = (player: Player): Player => (player === 'red' ? 'blue' : 'red');
export const playerName = (player: Player) => (player === 'red' ? 'Red' : 'Blue');

export function newGame(settings: Settings = DEFAULT_SETTINGS): GameState {
  const stacks: (Stack | null)[] = CELLS.map(() => null);
  if (settings.startingPieces > 0) {
    for (const player of ['red', 'blue'] as const) {
      for (const id of SPAWNS[player]) stacks[id] = { owner: player, count: settings.startingPieces };
    }
  }
  return {
    settings,
    stacks,
    turn: 'red',
    turnNumber: 1,
    phase: 'roll',
    dice: [],
    loser: null,
    log: ['Red to roll.'],
  };
}

// ---------- Balance ----------

export interface Balance {
  /** Signed torque in piece-weight × cell heights. Positive leans toward Blue (bottom). */
  torque: number;
  /** Torque needed to tip the plate off the flat top of the pipe. */
  threshold: number;
  /** torque / threshold, in [-1, 1] while the board stands. */
  ratio: number;
  totalPieces: number;
}

/**
 * The plate sits on the flat top of a square pipe. It tips once the combined
 * centre of mass moves past the pipe edge: |Σ mᵢ·yᵢ| ≥ halfWidth · (plate + Σ mᵢ).
 */
export function balance(state: Pick<GameState, 'stacks' | 'settings'>): Balance {
  let torque = 0;
  let totalPieces = 0;
  state.stacks.forEach((stack, id) => {
    if (!stack) return;
    torque += stack.count * leverArm(id);
    totalPieces += stack.count;
  });
  const threshold = state.settings.pipeHalfWidth * (state.settings.boardMass + totalPieces);
  return { torque, threshold, ratio: threshold > 0 ? torque / threshold : 0, totalPieces };
}

/** Which player the board has tipped toward (that player loses), if any. */
export function tippedToward(state: Pick<GameState, 'stacks' | 'settings'>): Player | null {
  const { ratio } = balance(state);
  if (ratio >= 1) return 'blue';
  if (ratio <= -1) return 'red';
  return null;
}

// ---------- Legal actions ----------

export function allowedKinds(face: DieFace): ActionKind[] {
  const meaning = DIE_ACTIONS[face];
  return meaning === 'wild' ? ['spawn', 'move', 'merge', 'strike', 'reinforce'] : [meaning];
}

export function legalActions(state: GameState, kind: ActionKind): Action[] {
  const me = state.turn;
  const { stacks } = state;
  const mine = stacks.flatMap((stack, id) => (stack?.owner === me ? [id] : []));
  const actions: Action[] = [];

  switch (kind) {
    case 'spawn':
      for (const id of SPAWNS[me]) if (!stacks[id] || stacks[id]!.owner === me) actions.push({ kind, to: id });
      break;
    case 'reinforce':
      for (const id of mine) actions.push({ kind, to: id });
      break;
    case 'move':
      for (const from of mine) {
        DIRECTIONS.forEach((_, dir) => {
          const near = step(from, dir);
          if (near === undefined) return;
          if (!stacks[near]) {
            actions.push({ kind, from, to: near, jump: false });
            return;
          }
          const far = step(from, dir, 2);
          if (far !== undefined && !stacks[far]) actions.push({ kind, from, to: far, jump: true });
        });
      }
      break;
    case 'merge':
      for (const from of mine) {
        for (const to of neighbors(from)) if (stacks[to]?.owner === me) actions.push({ kind, from, to });
      }
      break;
    case 'strike':
      for (const from of mine) {
        for (const to of neighbors(from)) if (stacks[to] && stacks[to]!.owner !== me) actions.push({ kind, from, to });
      }
      break;
  }
  return actions;
}

export function sameAction(a: Action, b: Action): boolean {
  return (
    a.kind === b.kind &&
    a.to === b.to &&
    ('from' in a ? a.from : -1) === ('from' in b ? b.from : -1)
  );
}

// ---------- Transitions ----------

export function roll(state: GameState, random: () => number = Math.random): GameState {
  if (state.phase !== 'roll') throw new Error('Not time to roll.');
  const face = () => (Math.floor(random() * 6) + 1) as DieFace;
  const dice: Die[] = [
    { face: face(), used: false },
    { face: face(), used: false },
  ];
  return {
    ...state,
    phase: 'act',
    dice,
    log: [...state.log, `${playerName(state.turn)} rolled ${dice[0].face} and ${dice[1].face}.`],
  };
}

/** Apply an action without validation or turn bookkeeping. Used for previews too. */
export function resolveStacks(stacks: (Stack | null)[], player: Player, action: Action): (Stack | null)[] {
  const next = stacks.slice();
  switch (action.kind) {
    case 'spawn':
      next[action.to] = { owner: player, count: (next[action.to]?.count ?? 0) + 1 };
      break;
    case 'reinforce':
      next[action.to] = { ...next[action.to]!, count: next[action.to]!.count + 1 };
      break;
    case 'move':
      next[action.to] = next[action.from];
      next[action.from] = null;
      break;
    case 'merge':
      next[action.to] = { owner: player, count: next[action.to]!.count + next[action.from]!.count };
      next[action.from] = null;
      break;
    case 'strike': {
      const target = next[action.to]!;
      next[action.to] = target.count > 1 ? { ...target, count: target.count - 1 } : null;
      break;
    }
  }
  return next;
}

function describe(action: Action, stacks: (Stack | null)[]): string {
  const size = (id: number) => stacks[id]?.count ?? 0;
  switch (action.kind) {
    case 'spawn':
      return 'spawned a piece';
    case 'reinforce':
      return `reinforced a stack to ${size(action.to) + 1}`;
    case 'move':
      return `${action.jump ? 'jumped' : 'moved'} a stack of ${size(action.from)}`;
    case 'merge':
      return `merged into a stack of ${size(action.to) + size(action.from)}`;
    case 'strike':
      return size(action.to) > 1 ? `struck an enemy stack down to ${size(action.to) - 1}` : 'knocked out an enemy piece';
  }
}

export function applyAction(state: GameState, dieIndex: number, action: Action): GameState {
  if (state.phase !== 'act') throw new Error('No dice to use.');
  const die = state.dice[dieIndex];
  if (!die || die.used) throw new Error('That die is not available.');
  if (!allowedKinds(die.face).includes(action.kind)) throw new Error('That die does not allow this action.');
  if (!legalActions(state, action.kind).some((legal) => sameAction(legal, action))) throw new Error('Illegal action.');

  const stacks = resolveStacks(state.stacks, state.turn, action);
  const dice = state.dice.map((d, i) => (i === dieIndex ? { ...d, used: true } : d));
  const log = [...state.log, `${playerName(state.turn)} ${describe(action, state.stacks)} (die ${die.face}).`];
  return settle({ ...state, stacks, dice, log });
}

/** Whether a die has any legal action for the player to move. */
export function dieIsPlayable(state: GameState, dieIndex: number): boolean {
  const die = state.dice[dieIndex];
  return !!die && allowedKinds(die.face).some((kind) => legalActions(state, kind).length > 0);
}

export function canPass(state: GameState, dieIndex: number): boolean {
  return !state.settings.forcedMoves || !dieIsPlayable(state, dieIndex);
}

export function skipDie(state: GameState, dieIndex: number): GameState {
  if (state.phase !== 'act') throw new Error('No dice to skip.');
  const die = state.dice[dieIndex];
  if (!die || die.used) throw new Error('That die is not available.');
  if (!canPass(state, dieIndex)) throw new Error('Forced moves are on: this die has a legal action.');
  const dice = state.dice.map((d, i) => (i === dieIndex ? { ...d, used: true } : d));
  return settle({ ...state, dice, log: [...state.log, `${playerName(state.turn)} passed on a ${die.face}.`] });
}

function settle(state: GameState): GameState {
  const loser = tippedToward(state);
  if (loser) {
    return {
      ...state,
      phase: 'over',
      loser,
      log: [...state.log, `The board tipped toward ${playerName(loser)}. ${playerName(other(loser))} wins!`],
    };
  }
  if (state.dice.every((d) => d.used)) {
    const turn = other(state.turn);
    return {
      ...state,
      turn,
      turnNumber: turn === 'red' ? state.turnNumber + 1 : state.turnNumber,
      phase: 'roll',
      dice: [],
      log: [...state.log, `${playerName(turn)} to roll.`],
    };
  }
  return state;
}
