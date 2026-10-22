// Runs the bot off the main thread so the board keeps animating while it thinks.
import { botIntent, type BotLevel } from './bot';
import type { GameState } from './rules';

self.onmessage = (event: MessageEvent<{ id: number; state: GameState; level: BotLevel }>) => {
  const { id, state, level } = event.data;
  try {
    self.postMessage({ id, intent: botIntent(state, level) });
  } catch (err) {
    self.postMessage({ id, intent: null, error: String(err) });
  }
};
