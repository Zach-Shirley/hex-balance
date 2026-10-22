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

/**
 * How good the board is for `me`, roughly in "tenths of the way to tipping". The core is
 * the balance ratio; being close to tipping toward yourself is punished extra because the
 * opponent only needs a small push, and stacks you control on the far side count a little
 * as future leverage (they can be reinforced).
 */
export function evaluate(state: GameState, me: Player): number {
  if (state.phase === 'over') return state.loser === me ? -WIN : WIN;
  const sign = me === 'red' ? 1 : -1;
  const r = balance(state).ratio * sign; // > 0: the board leans toward the opponent
  let score = r * 10;
  if (r < 0) score -= 18 * (-r) ** 3; // danger grows fast near the edge
  else score += 8 * r ** 3;

  let leverage = 0;
  let exposure = 0;
  state.stacks.forEach((stack, id) => {
    if (!stack) return;
    const arm = leverArm(id) * sign; // > 0: on the opponent's half
    if (stack.owner === me) {
      if (arm > 0) leverage += Math.min(arm, 3.5) * 0.25;
    } else if (arm < 0) {
      exposure += Math.min(-arm, 3.5) * 0.25;
    }
  });
  // Enemy stacks parked on my spawn slots stop me spawning.
  for (const id of SPAWNS[me]) if (state.stacks[id] && state.stacks[id]!.owner !== me) exposure += 0.3;
  score += 0.25 * (leverage - exposure);
  if (state.phase === 'roll' && state.turn === me) score += 1.2; // a bonus roll is worth something
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
