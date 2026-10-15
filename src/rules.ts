import { CELLS, DIRECTIONS, SPAWNS, leverArm, neighbors, step, type Player } from './board';

export type { Player } from './board';

export interface Stack {
  owner: Player;
  count: number;
}

export type ActionKind = 'spawn' | 'move' | 'merge' | 'strike' | 'reinforce' | 'convert';
export type DieFace = 1 | 2 | 3 | 4 | 5 | 6;
export type DieAction = ActionKind | 'wild';

/** Recovered die meanings. 4 (strike) is a best guess; 6 is wild. Convert only comes from combos. */
export const DIE_ACTIONS: Record<DieFace, DieAction> = {
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
  convert: 'Convert',
};

export const ACTION_HELP: Record<ActionKind, string> = {
  spawn: 'Place a new piece on one of your spawn slots, empty or already holding your stack. Enemy stacks block a slot.',
  move: 'Move one of your stacks one cell, or jump it over an adjacent stack to the empty cell beyond.',
  merge: 'Move one of your stacks onto an adjacent stack of yours. They combine.',
  strike: 'One of your stacks knocks one piece off an adjacent enemy stack.',
  reinforce: 'Add one piece to any stack you control.',
  convert: `Take over an adjacent enemy stack of up to ${3} pieces. It becomes yours where it stands.`,
};

/** Wild dice offer the five basic actions; convert is never wild. */
const WILD_KINDS: ActionKind[] = ['spawn', 'move', 'merge', 'strike', 'reinforce'];
/** Largest enemy stack a convert can take over. */
export const CONVERT_MAX = 3;

export type Action =
  | { kind: 'spawn'; to: number }
  | { kind: 'move'; from: number; to: number; jump: boolean }
  | { kind: 'merge'; from: number; to: number }
  | { kind: 'strike'; from: number; to: number }
  | { kind: 'reinforce'; to: number }
  | { kind: 'convert'; from: number; to: number };

export interface Settings {
  /** Mass of the steel plate, in piece-weights. */
  boardMass: number;
  /** Half the width of the square pivot pipe, in cell heights. */
  pipeHalfWidth: number;
  /** Pieces each player starts with on each spawn slot. */
  startingPieces: number;
  /** When on, a die must be used if it has any legal action; passing is only for dead dice. */
  forcedMoves: boolean;
  /** Experiment: doubles (and triples) trigger combos. */
  doubleCombos: boolean;
  /** Experiment: roll this many dice each turn (2 or 3). */
  diceCount: number;
  /** Experiment: most pieces a player may have on the board at once (0 = no limit). */
  pieceLimit: number;
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
  doubleCombos: false,
  diceCount: 2,
  pieceLimit: 0,
};

export interface Die {
  face: DieFace;
  used: boolean;
  /** Overrides the face's normal action (set by combos). */
  action?: DieAction;
  /** Must be used if it has any legal move, whatever the forced-moves setting says. */
  forced?: boolean;
  /** Extra die granted by a combo. */
  bonus?: boolean;
}

export interface Combo {
  name: string;
  text: string;
  tone: 'good' | 'bad' | 'mixed';
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
  /** The combo triggered by the current roll, if any. */
  combo?: Combo | null;
  /** After these dice are used, the same player rolls again. */
  bonusRoll?: boolean;
  /** The current roll is a bonus roll: combos still apply, but cannot grant another roll. */
  isBonusRoll?: boolean;
  /** Triple sixes: the player is choosing which double combo to take. */
  comboChoice?: boolean;
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
    combo: null,
    bonusRoll: false,
    isBonusRoll: false,
    comboChoice: false,
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

export function piecesOf(state: Pick<GameState, 'stacks'>, player: Player): number {
  return state.stacks.reduce((sum, s) => sum + (s?.owner === player ? s.count : 0), 0);
}

// ---------- Dice and combos ----------

export const dieAction = (die: Pick<Die, 'face' | 'action'>): DieAction => die.action ?? DIE_ACTIONS[die.face];

export function allowedKinds(die: Pick<Die, 'face' | 'action'>): ActionKind[] {
  const meaning = dieAction(die);
  return meaning === 'wild' ? WILD_KINDS : [meaning];
}

const make = (face: DieFace, action: DieAction, extra: Partial<Die> = {}): Die => ({ face, used: false, action, ...extra });

/** What a pair of matching dice turns into when combos are on. */
export const DOUBLE_COMBOS: Record<DieFace, { combo: Combo; dice: (f: DieFace) => Die[]; bonusRoll?: boolean }> = {
  1: {
    combo: { name: 'Snake eyes', text: 'Three forced spawns on your own edge.', tone: 'bad' },
    dice: (f) => [make(f, 'spawn', { forced: true }), make(f, 'spawn', { forced: true }), make(f, 'spawn', { forced: true, bonus: true })],
  },
  2: {
    combo: { name: 'Stampede', text: 'Four moves.', tone: 'good' },
    dice: (f) => [make(f, 'move'), make(f, 'move'), make(f, 'move', { bonus: true }), make(f, 'move', { bonus: true })],
  },
  3: {
    combo: { name: 'Weld', text: 'Two merges and a free move.', tone: 'good' },
    dice: (f) => [make(f, 'merge'), make(f, 'merge'), make(f, 'move', { bonus: true })],
  },
  4: {
    combo: { name: 'Convert', text: `Both strikes become one convert: take over an adjacent enemy stack of up to ${CONVERT_MAX}.`, tone: 'mixed' },
    dice: (f) => [make(f, 'convert')],
  },
  5: {
    combo: { name: 'Supply drop', text: 'Three reinforcements, and you must use them all.', tone: 'mixed' },
    dice: (f) => [make(f, 'reinforce', { forced: true }), make(f, 'reinforce', { forced: true }), make(f, 'reinforce', { forced: true, bonus: true })],
  },
  6: {
    combo: { name: 'Jackpot', text: 'Two wilds, then roll again.', tone: 'good' },
    dice: (f) => [make(f, 'wild'), make(f, 'wild')],
    bonusRoll: true,
  },
};

/** Three of a kind (three-dice mode with combos on). */
export const TRIPLE_COMBOS: Record<DieFace, { combo: Combo; dice: (f: DieFace) => Die[]; bonusRoll?: boolean; choice?: boolean }> = {
  1: {
    combo: { name: 'Cave-in', text: 'Five forced spawns on your own edge. Brace yourself.', tone: 'bad' },
    dice: (f) => Array.from({ length: 5 }, (_, i) => make(f, 'spawn', { forced: true, bonus: i > 2 })),
  },
  2: {
    combo: { name: 'Cavalry charge', text: 'Four moves and a wild, then roll again.', tone: 'good' },
    dice: (f) => [...DOUBLE_COMBOS[2].dice(f), make(f, 'wild', { bonus: true })],
    bonusRoll: true,
  },
  3: {
    combo: { name: 'Forge', text: 'Two merges, a free move and a wild, then roll again.', tone: 'good' },
    dice: (f) => [...DOUBLE_COMBOS[3].dice(f), make(f, 'wild', { bonus: true })],
    bonusRoll: true,
  },
  4: {
    combo: { name: 'Uprising', text: 'Two converts, then roll again.', tone: 'good' },
    dice: (f) => [make(f, 'convert'), make(f, 'convert', { bonus: true })],
    bonusRoll: true,
  },
  5: {
    combo: { name: 'Fortify', text: 'Three forced reinforcements and a wild, then roll again.', tone: 'mixed' },
    dice: (f) => [...DOUBLE_COMBOS[5].dice(f), make(f, 'wild', { bonus: true })],
    bonusRoll: true,
  },
  6: {
    combo: { name: 'Mother lode', text: 'Pick any double combo, then roll again.', tone: 'good' },
    dice: () => [],
    bonusRoll: true,
    choice: true,
  },
};

/** Double combos a Mother lode player may pick. */
export const CHOOSABLE_COMBOS: DieFace[] = [2, 3, 4, 5, 6];

/**
 * Turn rolled faces into the dice a player actually gets, applying combos. A pair is any
 * two dice showing the same face, wherever they sit in the roll.
 */
export function buildDice(
  faces: DieFace[],
  combos: boolean,
): { dice: Die[]; combo: Combo | null; bonusRoll: boolean; choice: boolean } {
  const plain = (f: DieFace): Die => ({ face: f, used: false });
  if (!combos) return { dice: faces.map(plain), combo: null, bonusRoll: false, choice: false };
  const counts = new Map<DieFace, number>();
  for (const f of faces) counts.set(f, (counts.get(f) ?? 0) + 1);
  const triple = [...counts].find(([, n]) => n >= 3)?.[0];
  if (triple) {
    const t = TRIPLE_COMBOS[triple];
    return { dice: t.dice(triple), combo: t.combo, bonusRoll: !!t.bonusRoll, choice: !!t.choice };
  }
  const pair = [...counts].find(([, n]) => n === 2)?.[0];
  if (pair) {
    const d = DOUBLE_COMBOS[pair];
    const rest = faces.filter((f) => f !== pair).map(plain);
    return { dice: [...d.dice(pair), ...rest], combo: d.combo, bonusRoll: !!d.bonusRoll, choice: false };
  }
  return { dice: faces.map(plain), combo: null, bonusRoll: false, choice: false };
}

// ---------- Legal actions ----------

export function legalActions(state: GameState, kind: ActionKind): Action[] {
  const me = state.turn;
  const { stacks } = state;
  const mine = stacks.flatMap((stack, id) => (stack?.owner === me ? [id] : []));
  const limit = state.settings.pieceLimit > 0 ? state.settings.pieceLimit : Infinity;
  const room = limit - piecesOf(state, me);
  const actions: Action[] = [];

  switch (kind) {
    case 'spawn':
      if (room < 1) break;
      for (const id of SPAWNS[me]) if (!stacks[id] || stacks[id]!.owner === me) actions.push({ kind, to: id });
      break;
    case 'reinforce':
      if (room < 1) break;
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
    case 'convert':
      for (const from of mine) {
        for (const to of neighbors(from)) {
          const t = stacks[to];
          if (t && t.owner !== me && t.count <= CONVERT_MAX && t.count <= room && !actions.some((a) => a.to === to)) {
            actions.push({ kind, from, to });
          }
        }
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
  const count = state.settings.diceCount === 3 ? 3 : 2;
  const faces = Array.from({ length: count }, () => (Math.floor(random() * 6) + 1) as DieFace);
  const built = buildDice(faces, state.settings.doubleCombos);
  // Combos apply on bonus rolls too, but a bonus roll never earns another one.
  const capped = !!state.isBonusRoll && built.bonusRoll;
  const combo = built.combo && capped ? { ...built.combo, text: `${built.combo.text.replace(/,? then roll again\.?/, '.')} (No extra roll: this is already a bonus roll.)` } : built.combo;
  const who = playerName(state.turn);
  const log = [...state.log, `${who} ${state.isBonusRoll ? 'bonus-rolled' : 'rolled'} ${faces.join(', ')}.`];
  if (combo) log.push(`${combo.name}! ${combo.text}`);
  return { ...state, phase: 'act', dice: built.dice, combo, bonusRoll: built.bonusRoll && !capped, comboChoice: built.choice, log };
}

/** Mother lode: take the chosen double combo's dice. */
export function chooseCombo(state: GameState, face: DieFace): GameState {
  if (state.phase !== 'act' || !state.comboChoice) throw new Error('No combo to choose.');
  if (!CHOOSABLE_COMBOS.includes(face)) throw new Error('That combo cannot be chosen.');
  const pick = DOUBLE_COMBOS[face];
  return {
    ...state,
    dice: pick.dice(face),
    comboChoice: false,
    combo: { name: `Mother lode: ${pick.combo.name}`, text: pick.combo.text.replace(/,? then roll again\.?/, '.'), tone: 'good' },
    log: [...state.log, `${playerName(state.turn)} chose ${pick.combo.name}.`],
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
    case 'convert':
      next[action.to] = { ...next[action.to]!, owner: player };
      break;
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
    case 'convert':
      return `converted an enemy stack of ${size(action.to)}`;
  }
}

export function applyAction(state: GameState, dieIndex: number, action: Action): GameState {
  if (state.phase !== 'act' || state.comboChoice) throw new Error('No dice to use.');
  const die = state.dice[dieIndex];
  if (!die || die.used) throw new Error('That die is not available.');
  if (!allowedKinds(die).includes(action.kind)) throw new Error('That die does not allow this action.');
  if (!legalActions(state, action.kind).some((legal) => sameAction(legal, action))) throw new Error('Illegal action.');

  const stacks = resolveStacks(state.stacks, state.turn, action);
  const dice = state.dice.map((d, i) => (i === dieIndex ? { ...d, used: true } : d));
  const log = [...state.log, `${playerName(state.turn)} ${describe(action, state.stacks)} (die ${die.face}).`];
  return settle({ ...state, stacks, dice, log });
}

/** Whether a die has any legal action for the player to move. */
export function dieIsPlayable(state: GameState, dieIndex: number): boolean {
  const die = state.dice[dieIndex];
  return !!die && allowedKinds(die).some((kind) => legalActions(state, kind).length > 0);
}

export interface PlayableAction {
  die: number;
  action: Action;
}

/**
 * Every action the current player can take with any unused die. Each action appears
 * once; forced dice are spent first, and a specific die is preferred over a wild one.
 */
export function playableActions(state: GameState): PlayableAction[] {
  if (state.phase !== 'act') return [];
  const rank = (d: Die) => (d.forced ? 0 : dieAction(d) === 'wild' ? 2 : 1);
  const order = state.dice
    .map((die, i) => ({ die, i }))
    .filter(({ die }) => !die.used)
    .sort((a, b) => rank(a.die) - rank(b.die));
  const out: PlayableAction[] = [];
  for (const { die, i } of order) {
    for (const kind of allowedKinds(die)) {
      for (const action of legalActions(state, kind)) {
        if (!out.some((p) => sameAction(p.action, action))) out.push({ die: i, action });
      }
    }
  }
  return out;
}

export function canPass(state: GameState, dieIndex: number): boolean {
  const forced = state.settings.forcedMoves || !!state.dice[dieIndex]?.forced;
  return !forced || !dieIsPlayable(state, dieIndex);
}

export function skipDie(state: GameState, dieIndex: number): GameState {
  if (state.phase !== 'act' || state.comboChoice) throw new Error('No dice to skip.');
  const die = state.dice[dieIndex];
  if (!die || die.used) throw new Error('That die is not available.');
  if (!canPass(state, dieIndex)) throw new Error('This die is forced: it has a legal action.');
  const dice = state.dice.map((d, i) => (i === dieIndex ? { ...d, used: true } : d));
  const note = dieIsPlayable(state, dieIndex) ? `passed on a ${die.face}` : `had no legal move for a ${die.face}`;
  return settle({ ...state, dice, log: [...state.log, `${playerName(state.turn)} ${note}.`] });
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
    if (state.bonusRoll) {
      return {
        ...state,
        phase: 'roll',
        dice: [],
        combo: null,
        bonusRoll: false,
        comboChoice: false,
        isBonusRoll: true,
        log: [...state.log, `${playerName(state.turn)} gets a bonus roll.`],
      };
    }
    const turn = other(state.turn);
    return {
      ...state,
      turn,
      turnNumber: turn === 'red' ? state.turnNumber + 1 : state.turnNumber,
      phase: 'roll',
      dice: [],
      combo: null,
      bonusRoll: false,
      comboChoice: false,
      isBonusRoll: false,
      log: [...state.log, `${playerName(turn)} to roll.`],
    };
  }
  return state;
}
