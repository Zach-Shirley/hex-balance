import { describe, expect, it } from 'vitest';
import { cellAt } from '../src/board';
import { botIntent, type BotLevel } from '../src/bot';
import { DEFAULT_SETTINGS, applyAction, balance, chooseCombo, newGame, roll, skipDie, type GameState } from '../src/rules';
import type { Intent } from '../src/net';

/** A seeded random source so failures are reproducible. */
function seeded(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
}

function apply(s: GameState, it: Intent, random: () => number): GameState {
  switch (it.type) {
    case 'roll':
      return roll(s, random);
    case 'act':
      return applyAction(s, it.die, it.action);
    case 'pass':
      return skipDie(s, it.die);
    case 'choose':
      return chooseCombo(s, it.face);
    case 'new':
      throw new Error('bots never restart');
  }
}

describe('bot', () => {
  it.each<BotLevel>(['easy', 'medium', 'hard'])('%s only ever picks legal moves, through whole games', (level) => {
    const random = seeded(7);
    for (const settings of [DEFAULT_SETTINGS, { ...DEFAULT_SETTINGS, towerBreak: true, overheat: true, forcedMoves: true }]) {
      let s = newGame(settings, random);
      const steps = level === 'hard' ? 120 : 400;
      for (let i = 0; i < steps && s.phase !== 'over'; i++) s = apply(s, botIntent(s, level, random), random);
    }
  }, 120_000);

  it('takes a winning move when one is there', () => {
    // A Red stack of 3 deep in Blue's half: one reinforce makes 4, which tips the board toward Blue.
    const s0 = newGame({ ...DEFAULT_SETTINGS, startingPieces: 0 });
    const stacks = s0.stacks.slice();
    stacks[cellAt(3, 13)!] = { owner: 'red', count: 3 };
    const s: GameState = { ...s0, stacks, phase: 'act', dice: [{ face: 5, used: false }] };
    expect(balance(s).ratio).toBeLessThan(1);
    for (const level of ['medium', 'hard'] as BotLevel[]) {
      expect(apply(s, botIntent(s, level), Math.random).loser).toBe('blue');
    }
  });

  it('never tips the board toward itself when it has a safe choice', () => {
    // Red is one piece from losing: reinforcing its own near-edge stack would tip it.
    const s0 = newGame({ ...DEFAULT_SETTINGS, startingPieces: 0 });
    const stacks = s0.stacks.slice();
    stacks[cellAt(4, 0)!] = { owner: 'red', count: 3 };
    stacks[cellAt(4, 10)!] = { owner: 'red', count: 1 };
    const s: GameState = { ...s0, stacks, phase: 'act', dice: [{ face: 5, used: false }] };
    expect(applyAction(s, 0, { kind: 'reinforce', to: cellAt(4, 0)! }).loser).toBe('red');
    for (const level of ['easy', 'medium', 'hard'] as BotLevel[]) {
      for (let i = 0; i < 20; i++) {
        const next = apply(s, botIntent(s, level), Math.random);
        expect(next.loser).not.toBe('red');
      }
    }
  });
});
