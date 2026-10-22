// Single-player opponent. The bot plays through the real rules engine: it tries the
// sequences of actions its dice allow, scores the board each one leaves, and picks one.
//   easy   – one die at a time, often careless, sometimes just plays something.
//   medium – plans the whole turn; a little noise.
//   hard   – plans the whole turn, then checks how the opponent could answer on each
//            possible roll and picks the plan that holds up best.
// It never sees the hidden breaking-point limit; it assumes a cautious guess instead.

import { SPAWNS, leverArm } from './board';
import {
  CHOOSABLE_COMBOS,
  applyAction,
  balance,
  buildDice,
  canPass,
  chooseCombo,
  other,
  playableActions,
  skipDie,
  DOUBLE_COMBOS,
  allowedKinds,
  legalActions,
  piecesOf,
  type Die,
  type Action,
  type ActionKind,
  type DieFace,
  type GameState,
  type Player,
} from './rules';
import type { Intent } from './net';

export type BotLevel = 'easy' | 'medium' | 'hard';

export const BOT_LEVELS: BotLevel[] = ['easy', 'medium', 'hard'];
export const BOT_NAMES: Record<BotLevel, string> = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };

/** The tower height the bot treats as the breaking point (it can't see the real one). */
const ASSUMED_BREAK = 7;
const WIN = 1000;
/** Rough thinking budget per move, in ms, so big combo turns never stall the game. */
const PLAN_MS = 900;
const REPLY_MS = 1200;

type Rand = () => number;

/** A copy of the state the bot may play out freely: no log, and its guess at the break limit. */
function sandbox(state: GameState): GameState {
  return { ...state, log: [], breakLimit: state.settings.towerBreak ? ASSUMED_BREAK : state.breakLimit };
}

/** Scoring weights (exported so tuning runs can try other values). */
export const WEIGHTS = {
  /** How far (in lever-arm units) a stack is expected to advance over the next few turns. */
  reach: 4,
  /** How much that future advance counts compared with weight already in place. */
  potential: 0.9,
  /** Pieces in play: with none you can only use spawn and wild dice. Diminishing returns. */
  material: 2,
  /** Extra material penalty for having no pieces on the board at all. */
  empty: 2,
  /** Penalty, times the chance the opponent can tip the board on their next roll. */
  threat: 30,
  /** Bonus, times the chance I can tip it on my roll after that. */
  chance: 5,
};

const MAX_ARM = 3.5;

/**
 * How much torque a player's stacks can still add by advancing toward the far edge. A piece
 * at your own edge has the most left to give; one already at the far edge has none. This is
 * why spawning is worth something even though it weighs on your own side right now.
 */
function advancePotential(state: GameState, player: Player): number {
  const sign = player === 'red' ? 1 : -1;
  let total = 0;
  state.stacks.forEach((stack, id) => {
    if (!stack || stack.owner !== player) return;
    const a = leverArm(id) * sign;
    total += stack.count * Math.max(0, Math.min(MAX_ARM, a + WEIGHTS.reach) - a);
  });
  return total;
}

/** Torque an action adds toward `player`'s win (positive = good for them), without playing it. */
function actionGain(state: GameState, player: Player, action: Action): number {
  const sign = player === 'red' ? 1 : -1;
  const arm = (id: number) => leverArm(id) * sign;
  const count = (id: number) => state.stacks[id]?.count ?? 0;
  switch (action.kind) {
    case 'spawn':
    case 'reinforce':
      return arm(action.to);
    case 'move':
    case 'merge':
      return count(action.from) * (arm(action.to) - arm(action.from));
    case 'split':
      return Math.floor(count(action.from) / 2) * (arm(action.to) - arm(action.from));
    case 'strike':
      return -arm(action.to);
    case 'convert':
      return 0;
  }
}

/** The dice each distinct roll gives (combos applied), with its probability. Cached per dice count. */
const ROLL_TABLE = new Map<number, { dice: Die[]; p: number }[]>();
function rollTable(diceCount: number) {
  let table = ROLL_TABLE.get(diceCount);
  if (!table) {
    table = rollOutcomes(diceCount).map(({ faces, p }) => {
      const built = buildDice(faces, true);
      // Mother lode: assume the strongest pick (two wilds).
      return { dice: built.choice ? DOUBLE_COMBOS[6].dice(6) : built.dice, p };
    });
    ROLL_TABLE.set(diceCount, table);
  }
  return table;
}

/**
 * When `player` rolls next: the chance their roll lets them tip the board toward the other
 * side, and the chance a forced combo (snake eyes, supply drop) tips it toward themselves.
 * Each die is credited with its best single action (or its least bad one, if forced).
 */
function rollOdds(state: GameState, player: Player, needed: number, margin: number): { win: number; lose: number } {
  const as: GameState = { ...state, turn: player };
  const best: Partial<Record<ActionKind, number>> = {};
  const forced: Partial<Record<ActionKind, number>> = {};
  for (const kind of ['spawn', 'move', 'merge', 'split', 'strike', 'reinforce'] as ActionKind[]) {
    let top = -Infinity;
    for (const action of legalActions(as, kind)) top = Math.max(top, actionGain(state, player, action));
    best[kind] = Math.max(0, top);
    forced[kind] = top === -Infinity ? 0 : top; // a forced die with no legal move is skipped
  }
  let win = 0;
  let lose = 0;
  for (const { dice, p } of rollTable(state.settings.diceCount)) {
    let push = 0;
    let harm = 0;
    for (const die of dice) {
      const kinds = allowedKinds(die);
      if (die.forced) {
        const g = Math.max(...kinds.map((k) => forced[k] ?? 0));
        push += g;
        harm += Math.min(0, g);
      } else push += Math.max(...kinds.map((k) => best[k] ?? 0));
    }
    if (push >= needed) win += p;
    else if (-harm >= margin) lose += p;
  }
  return { win, lose };
}

/**
 * How good the board is for `me`, roughly in "tenths of the way to tipping". It weighs:
 * the balance now (with extra danger near tipping toward me), what each side's pieces can
 * still do as they advance, and whether either side can tip the board on its next turn.
 */
export function evaluate(state: GameState, me: Player): number {
  if (state.phase === 'over') return state.loser === me ? -WIN : WIN;
  const them = other(me);
  const sign = me === 'red' ? 1 : -1;
  const b = balance(state);
  const r = b.ratio * sign; // > 0: the board leans toward the opponent
  let score = r * 10;
  if (r < 0) score -= 18 * (-r) ** 3; // danger grows fast near the edge
  else score += 8 * r ** 3;

  // Future: pieces in hand are worth what they can still push.
  const theyMoveNext = !(state.phase === 'roll' && state.turn === me);
  const mine = advancePotential(state, me);
  const theirs = advancePotential(state, them) * (theyMoveNext ? 1.15 : 1);
  score += (WEIGHTS.potential * 10 * (mine - theirs)) / b.threshold;

  // Threat: can they tip it toward me on their next roll? Can I tip it on mine after?
  // (Adding pieces also raises the threshold slightly; ignored here.)
  const myMargin = b.threshold + b.torque * sign;
  const theirMargin = b.threshold - b.torque * sign;
  if (theyMoveNext) {
    const theirRoll = rollOdds(state, them, myMargin, theirMargin);
    score -= WEIGHTS.threat * theirRoll.win;
    score += WEIGHTS.threat * theirRoll.lose;
    const myRoll = rollOdds(state, me, theirMargin, myMargin);
    score += WEIGHTS.chance * myRoll.win;
    score -= WEIGHTS.chance * 2 * myRoll.lose;
  } else {
    // Bonus roll: I roll again before they do.
    const myRoll = rollOdds(state, me, theirMargin, myMargin);
    score += WEIGHTS.chance * 2 * myRoll.win;
    score -= WEIGHTS.threat * myRoll.lose;
  }

  // Material: having pieces to act with at all (diminishing, so it never outweighs balance).
  // With none, only spawn and wild dice do anything, so the first piece counts the most.
  const pieces = (p: Player) => {
    const n = piecesOf(state, p);
    return n === 0 ? -WEIGHTS.empty : Math.sqrt(Math.min(n, 9));
  };
  score += WEIGHTS.material * (pieces(me) - pieces(them));

  // Enemy stacks parked on my spawn slots stop me spawning.
  for (const id of SPAWNS[me]) if (state.stacks[id] && state.stacks[id]!.owner !== me) score -= 0.4;
  if (!theyMoveNext) score += 1.2; // a bonus roll is worth something
  return score;
}

interface Plan {
  steps: Intent[];
  end: GameState;
}

/** The legal one-step continuations of a mid-turn state (actions, plus passing a die). */
function continuations(state: GameState): { intent: Intent; next: GameState }[] {
  const out: { intent: Intent; next: GameState }[] = [];
  for (const p of playableActions(state)) {
    try {
      out.push({ intent: { type: 'act', die: p.die, action: p.action }, next: applyAction(state, p.die, p.action) });
    } catch {
      // not playable after all
    }
  }
  const unused = state.dice.flatMap((d, i) => (d.used ? [] : [i]));
  // Passing: one pass option is enough (which die is passed only matters for what stays playable).
  const passable = unused.filter((i) => canPass(state, i));
  for (const i of passable) out.push({ intent: { type: 'pass', die: i }, next: skipDie(state, i) });
  return out;
}

const stillMine = (s: GameState, me: Player) => s.phase === 'act' && s.turn === me && !s.comboChoice;

/** Every distinct way to finish the current set of dice, ending at a roll, a new turn or game over. */
function plans(state: GameState, me: Player, cap = 2000): Plan[] {
  const out: Plan[] = [];
  const deadline = Date.now() + PLAN_MS;
  const seen = new Set<string>();
  const walk = (s: GameState, steps: Intent[]) => {
    if (out.length >= cap || (out.length > 0 && Date.now() > deadline)) return;
    if (!stillMine(s, me)) {
      const key = JSON.stringify([s.stacks, s.phase, s.turn, s.holes]);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ steps, end: s });
      return;
    }
    for (const c of continuations(s)) walk(c.next, [...steps, c.intent]);
  };
  walk(state, []);
  return out;
}

/** The opponent's reply for a given roll, played greedily one die at a time. Returns my score afterwards. */
function greedyReply(state: GameState, me: Player): number {
  const them = other(me);
  let s = state;
  for (let guard = 0; guard < 8 && stillMine(s, them); guard++) {
    let best: GameState | null = null;
    let bestScore = Infinity;
    for (const c of continuations(s)) {
      const v = evaluate(c.next, me);
      if (v < bestScore) {
        bestScore = v;
        best = c.next;
      }
      if (v === -WIN) break;
    }
    if (!best) break;
    s = best;
  }
  return evaluate(s, me);
}

const FACES: DieFace[] = [1, 2, 3, 4, 5, 6];

/** Every distinct roll the opponent could get, with its probability. */
function rollOutcomes(diceCount: number): { faces: DieFace[]; p: number }[] {
  const out = new Map<string, { faces: DieFace[]; p: number }>();
  const add = (faces: DieFace[], p: number) => {
    const key = [...faces].sort().join('');
    const cur = out.get(key);
    if (cur) cur.p += p;
    else out.set(key, { faces, p });
  };
  if (diceCount === 3) {
    for (const a of FACES) for (const b of FACES) for (const c of FACES) add([a, b, c], 1 / 216);
  } else {
    for (const a of FACES) for (const b of FACES) add([a, b], 1 / 36);
  }
  return [...out.values()];
}

/** My expected score after the opponent's next turn, over all their rolls. */
function expectedAfterReply(end: GameState, me: Player): number {
  if (end.phase === 'over') return evaluate(end, me);
  if (end.turn === me) return evaluate(end, me); // bonus roll: still my move
  let total = 0;
  for (const { faces, p } of rollOutcomes(end.settings.diceCount)) {
    const built = buildDice(faces, true);
    let s: GameState = { ...end, phase: 'act', dice: built.dice, comboChoice: built.choice, bonusRoll: false };
    if (s.comboChoice) s = chooseCombo(s, 5); // assume a strong pick (reinforce pair)
    total += p * greedyReply(s, me);
  }
  return total;
}

/** Pick the next intent for the player whose turn it is. */
export function botIntent(real: GameState, level: BotLevel, random: Rand = Math.random): Intent {
  const me = real.turn;
  if (real.phase === 'roll') return { type: 'roll' };
  const state = sandbox(real);

  if (state.comboChoice) {
    if (level === 'easy') return { type: 'choose', face: CHOOSABLE_COMBOS[Math.floor(random() * CHOOSABLE_COMBOS.length)] };
    let best: DieFace = 5;
    let bestScore = -Infinity;
    for (const face of CHOOSABLE_COMBOS) {
      const after = chooseCombo(state, face);
      const top = plans(after, me, 1500).reduce((m, p) => Math.max(m, evaluate(p.end, me)), -Infinity);
      if (top > bestScore) {
        bestScore = top;
        best = face;
      }
    }
    return { type: 'choose', face: best };
  }

  if (level === 'easy') return easyStep(state, me, random);

  const all = plans(state, me);
  if (!all.length) return { type: 'pass', die: Math.max(0, state.dice.findIndex((d) => !d.used)) };

  const scored = all.map((p) => ({ p, v: evaluate(p.end, me) + (level === 'medium' ? (random() - 0.5) * 1.6 : 0) }));
  scored.sort((a, b) => b.v - a.v);
  const winNow = scored.find((s) => s.p.end.phase === 'over' && s.p.end.loser !== me);
  if (winNow) return winNow.p.steps[0];
  if (level === 'medium') return scored[0].p.steps[0];

  // Hard: look at the opponent's answer for the most promising plans.
  const shortlist = scored.filter((s) => s.v > -WIN).slice(0, 10);
  if (!shortlist.length) return scored[0].p.steps[0];
  let best = shortlist[0];
  let bestScore = -Infinity;
  const deadline = Date.now() + REPLY_MS;
  for (const s of shortlist) {
    if (bestScore > -Infinity && Date.now() > deadline) break; // out of time: keep the best checked so far
    const v = expectedAfterReply(s.p.end, me);
    if (v > bestScore) {
      bestScore = v;
      best = s;
    }
  }
  return best.p.steps[0];
}

/** Easy: plays one die at a time, picks loosely, and only avoids throwing the game outright. */
function easyStep(state: GameState, me: Player, random: Rand): Intent {
  const options = continuations(state);
  if (!options.length) return { type: 'pass', die: Math.max(0, state.dice.findIndex((d) => !d.used)) };
  const safe = options.filter((o) => !(o.next.phase === 'over' && o.next.loser === me));
  const pool = safe.length ? safe : options;
  const win = pool.find((o) => o.next.phase === 'over');
  if (win && random() < 0.6) return win.intent;
  if (random() < 0.35) return pool[Math.floor(random() * pool.length)].intent;
  const scored = pool.map((o) => ({ o, v: evaluate(o.next, me) + (random() - 0.5) * 4 }));
  scored.sort((a, b) => b.v - a.v);
  return scored[0].o.intent;
}
