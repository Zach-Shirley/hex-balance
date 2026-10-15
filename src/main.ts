import './style.css';
import {
  ACTION_HELP,
  DEFAULT_SETTINGS,
  DIE_ACTIONS,
  DOUBLE_COMBOS,
  TRIPLE_COMBOS,
  CONVERT_MAX,
  PIPE_HALF_WIDTH,
  OVERHEAT_AT,
  OVERHEAT_TURNS,
  BREAK_MIN,
  BREAK_MAX,
  dieLabel,
  normalizeSettings,
  CHOOSABLE_COMBOS,
  chooseCombo,
  applyAction,
  canPass,
  dieAction,
  balance,
  dieIsPlayable,
  newGame,
  playableActions,
  playerName,
  resolveStacks,
  roll,
  skipDie,
  other,
  type Action,
  type ActionKind,
  type DieFace,
  type GameState,
  type PlayableAction,
  type Player,
  type Settings,
} from './rules';
import { renderBoard, type Theme } from './view3d';
import { GuestSession, HostSession, newRoomCode, type Intent, type NetStatus } from './net';

// ---------- State ----------

interface Online {
  mode: 'local' | 'host' | 'guest';
  code: string | null;
  status: NetStatus | null;
  detail: string | null;
}

let state: GameState = newGame(loadSettings());
/** The stack the player has picked up, if any. Everything else is derived from the dice. */
let selected: number | null = null;
/** When a picked-up stack can both move and split onto the same tiles, which one a tap does. */
let splitMode = false;
let online: Online = { mode: 'local', code: null, status: null, detail: null };
let host: HostSession | null = null;
let guest: GuestSession | null = null;
/** Camera yaw in radians: 0 views from Blue's edge, π from Red's. Online players view from their own edge. */
let viewYaw = 0;
let targetYaw = 0;
let yawAnim: number | null = null;
const flipped = () => Math.cos(targetYaw) < 0;

/** Visual theme; a per-device preference, not part of the game state. */
let theme: Theme = loadTheme();

function loadTheme(): Theme {
  try {
    return localStorage.getItem('hex-balance-theme') === 'forge' ? 'forge' : 'neon';
  } catch {
    return 'neon';
  }
}

function setTheme(next: Theme) {
  theme = next;
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('hex-balance-theme', next);
  } catch {
    // preference lasts for this visit only
  }
  render();
}
document.documentElement.dataset.theme = theme;

const myColor = (): Player | null => (online.mode === 'host' ? 'red' : online.mode === 'guest' ? 'blue' : null);
const canAct = () => state.phase !== 'over' && (myColor() === null || state.turn === myColor());
const gameInProgress = () => state.phase !== 'over' && state.log.length > 1;

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem('hex-balance-settings') ?? 'null');
    if (saved) return normalizeSettings(saved);
  } catch {
    // fall through to defaults
  }
  return DEFAULT_SETTINGS;
}

function saveSettings(settings: Settings) {
  try {
    localStorage.setItem('hex-balance-settings', JSON.stringify(settings));
  } catch {
    // storage unavailable; settings still apply for this session
  }
}

const hostKey = (code: string) => `hex-balance-host-${code}`;

function saveHostState() {
  if (online.mode !== 'host' || !online.code) return;
  try {
    localStorage.setItem(hostKey(online.code), JSON.stringify(state));
  } catch {
    // a reload will start a fresh game instead of resuming
  }
}

function loadHostState(code: string): GameState | null {
  try {
    return JSON.parse(localStorage.getItem(hostKey(code)) ?? 'null');
  } catch {
    return null;
  }
}

// ---------- What the player can do right now ----------

const playable = (): PlayableAction[] => (canAct() ? playableActions(state) : []);
const fromOf = (a: Action) => ('from' in a ? a.from : null);
/** Spawn and reinforce act on a cell directly; move, merge and strike start from a stack. */
const inPlace = (a: Action) => a.kind === 'spawn' || a.kind === 'reinforce';

/** Highlights for the board: stacks you can pick up, and destinations with their action kind. */
function boardHints(): { sources: Set<number>; targets: Map<number, ActionKind> } {
  const acts = playable();
  const sources = new Set<number>();
  const targets = new Map<number, ActionKind>();
  if (selected !== null) {
    for (const { action } of selectedOptions()) targets.set(action.to, action.kind);
    return { sources, targets };
  }
  for (const { action } of acts) {
    const from = fromOf(action);
    if (from !== null) sources.add(from);
    else if (state.stacks[action.to]) sources.add(action.to);
    else targets.set(action.to, action.kind); // spawning on an empty slot is a single tap
  }
  return { sources, targets };
}

/** Whether the picked-up stack has both moves and splits available (they share tiles). */
function canMoveAndSplit(): boolean {
  if (selected === null) return false;
  const kinds = new Set(playable().filter((p) => fromOf(p.action) === selected).map((p) => p.action.kind));
  return kinds.has('move') && kinds.has('split');
}

/** Actions from the picked-up stack; where a move and a split share a tile, only the chosen one. */
function selectedOptions(): PlayableAction[] {
  const acts = playable().filter((p) => fromOf(p.action) === selected);
  if (!canMoveAndSplit()) return acts;
  const hidden = splitMode ? 'move' : 'split';
  const shown = splitMode ? 'split' : 'move';
  return acts.filter((p) => p.action.kind !== hidden || !acts.some((q) => q.action.kind === shown && q.action.to === p.action.to));
}

/** In-place actions offered on the selected stack (shown as buttons above it). */
function selectedInPlace(): PlayableAction[] {
  if (selected === null) return [];
  return playable().filter((p) => inPlace(p.action) && p.action.to === selected);
}

// ---------- Intents (shared by local play, the host and the guest) ----------

function resolveIntent(current: GameState, intent: Intent): GameState {
  switch (intent.type) {
    case 'roll':
      return roll(current);
    case 'act':
      return applyAction(current, intent.die, intent.action);
    case 'pass':
      return skipDie(current, intent.die);
    case 'new':
      return newGame(current.settings);
    case 'choose':
      return chooseCombo(current, intent.face);
  }
}

function setState(next: GameState) {
  state = next;
  selected = null;
  saveHostState();
  host?.send(state);
  render();
}

function dispatch(intent: Intent) {
  if (online.mode === 'guest') {
    guest?.send(intent);
    selected = null;
    render();
    return;
  }
  try {
    setState(resolveIntent(state, intent));
  } catch (err) {
    console.warn('Rejected intent', intent, err);
  }
}

/** Pass every unused die (one message per die so the host can validate each). */
function passRemaining() {
  const unused = state.dice.flatMap((d, i) => (d.used ? [] : [i]));
  if (online.mode === 'guest') {
    for (const i of unused) guest?.send({ type: 'pass', die: i });
    return;
  }
  try {
    setState(unused.reduce((s, i) => (s.phase === 'act' ? skipDie(s, i) : s), state));
  } catch (err) {
    console.warn('Could not pass', err);
  }
}

/** The host applies the guest's intents only on Blue's turn (or to restart a finished game). */
function onGuestIntent(intent: Intent) {
  // Only the host restarts or changes settings; the guest may only play Blue's turns.
  const allowed = intent.type !== 'new' && state.turn === 'blue';
  if (!allowed) return host?.send(state);
  try {
    setState(resolveIntent(state, intent));
  } catch {
    host?.send(state);
  }
}

// ---------- Auto-pass when no die can be used ----------

const AUTO_PASS_MS = 1700;
let autoPassTimer: ReturnType<typeof setTimeout> | null = null;
let autoPassKey = '';

function remainingDiceDead(): boolean {
  if (state.phase !== 'act') return false;
  const unused = state.dice.flatMap((d, i) => (d.used ? [] : [i]));
  return unused.length > 0 && unused.every((i) => !dieIsPlayable(state, i));
}

function scheduleAutoPass() {
  const key = `${state.turnNumber}|${state.turn}|${JSON.stringify(state.dice)}|${state.log.length}`;
  if (!canAct() || !remainingDiceDead()) {
    if (autoPassTimer) clearTimeout(autoPassTimer);
    autoPassTimer = null;
    autoPassKey = '';
    return;
  }
  if (key === autoPassKey) return;
  if (autoPassTimer) clearTimeout(autoPassTimer);
  autoPassKey = key;
  autoPassTimer = setTimeout(() => {
    autoPassTimer = null;
    if (remainingDiceDead() && canAct()) passRemaining();
  }, AUTO_PASS_MS);
}

// ---------- Online sessions ----------

function setStatus(status: NetStatus, detail?: string) {
  online = { ...online, status, detail: detail ?? null };
  render();
}

function startHost(code = newRoomCode(), resume = false) {
  leaveOnline(false);
  if (resume) {
    const saved = loadHostState(code);
    if (saved) state = { ...saved, settings: normalizeSettings(saved.settings) };
  } else {
    state = newGame(state.settings);
  }
  online = { mode: 'host', code, status: 'starting', detail: null };
  setYaw(Math.PI);
  history.replaceState(null, '', `?host=${code}`);
  saveHostState();
  host = new HostSession(code, { onStatus: setStatus, onIntent: onGuestIntent, getState: () => state });
  render();
}

function startGuest(code: string) {
  leaveOnline(false);
  online = { mode: 'guest', code, status: 'starting', detail: null };
  setYaw(0);
  history.replaceState(null, '', `?join=${code}`);
  guest = new GuestSession(code, {
    onStatus: setStatus,
    onState: (next) => {
      state = { ...next, settings: normalizeSettings(next.settings) };
      selected = null;
      render();
    },
  });
  render();
}

function leaveOnline(rerender = true) {
  host?.destroy();
  guest?.destroy();
  host = null;
  guest = null;
  if (online.mode !== 'local') {
    online = { mode: 'local', code: null, status: null, detail: null };
    setYaw(0);
    history.replaceState(null, '', location.pathname);
    if (rerender) {
      state = newGame(state.settings);
      render();
    }
  }
}

const canShare = () => typeof navigator.share === 'function' && matchMedia('(hover: none)').matches;
const inviteLink = () => `${location.origin}${location.pathname}?join=${online.code}`;

// ---------- Board input ----------

function onCellTap(id: number) {
  if (!canAct() || state.phase !== 'act') return;
  const acts = playable();

  // With a stack picked up, a highlighted destination performs that action.
  if (selected !== null) {
    const hit = selectedOptions().find((p) => p.action.to === id);
    if (hit) return dispatch({ type: 'act', die: hit.die, action: hit.action });
    if (id === selected) {
      selected = null;
      return render();
    }
  }

  // Spawning on an empty slot is a single tap.
  if (!state.stacks[id]) {
    const spawn = acts.find((p) => p.action.kind === 'spawn' && p.action.to === id);
    if (spawn && selected === null) return dispatch({ type: 'act', die: spawn.die, action: spawn.action });
    selected = null;
    return render();
  }

  // Tapping one of your stacks: act immediately when there is exactly one thing to do with it,
  // otherwise pick it up and show its options.
  const fromHere = acts.filter((p) => fromOf(p.action) === id);
  const onHere = acts.filter((p) => inPlace(p.action) && p.action.to === id);
  if (!fromHere.length && onHere.length === 1) return dispatch({ type: 'act', die: onHere[0].die, action: onHere[0].action });
  selected = fromHere.length || onHere.length ? id : null;
  splitMode = false;
  render();
}

function previewRatio(action: Action | null): number | null {
  if (!action) return null;
  return balance({ settings: state.settings, stacks: resolveStacks(state.stacks, state.turn, action) }).ratio;
}

/** The action a tap on this cell would perform right now, for the balance preview. */
function actionForCell(id: number): Action | null {
  const acts = playable();
  if (selected !== null) return selectedOptions().find((p) => p.action.to === id)?.action ?? null;
  if (!state.stacks[id]) return acts.find((p) => p.action.kind === 'spawn' && p.action.to === id)?.action ?? null;
  const fromHere = acts.filter((p) => fromOf(p.action) === id);
  const onHere = acts.filter((p) => inPlace(p.action) && p.action.to === id);
  return !fromHere.length && onHere.length === 1 ? onHere[0].action : null;
}

// ---------- Board animation ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
let shownLean = 0;
let leanAnim: number | null = null;
let shakeLean = 0;
let shakeRaf: number | null = null;
let lastShakeFrame = 0;

/** Radians. A small lean while standing (visual only), a big one once it tips. */
function targetLean(): number {
  if (state.phase === 'over') return state.loser === 'blue' ? 0.5 : -0.5;
  return Math.max(-1, Math.min(1, balance(state).ratio)) * 0.1;
}

function drawBoard() {
  const host = app.querySelector<HTMLElement>('.board-host');
  if (!host) return;
  const hints = boardHints();
  const view = renderBoard({
    stacks: state.stacks,
    pipeHalfWidth: PIPE_HALF_WIDTH,
    holes: new Set(state.holes ?? []),
    heat: state.settings.overheat ? new Map(Object.entries(state.heat ?? {}).map(([k, v]) => [Number(k), v])) : new Map(),
    lean: shownLean + shakeLean,
    yaw: viewYaw,
    theme,
    sources: hints.sources,
    targets: hints.targets,
    from: selected,
  });
  host.innerHTML = view.under + view.board;
}

/**
 * Between 80% and 100% of the way to tipping, the plate trembles about the pipe toward
 * the sinking side. It is redrawn in 3D (about 30 frames a second) so only the plate and
 * its stacks move; the pipe and stands stay still.
 */
function updateShake() {
  const ratio = balance(state).ratio;
  const active = state.phase !== 'over' && Math.abs(ratio) >= 0.8;
  if (!active) {
    if (shakeRaf !== null) cancelAnimationFrame(shakeRaf);
    shakeRaf = null;
    if (shakeLean !== 0) {
      shakeLean = 0;
      drawBoard();
    }
    return;
  }
  if (shakeRaf !== null) return;
  const frame = (now: number) => {
    shakeRaf = requestAnimationFrame(frame);
    if (now - lastShakeFrame < 33 || leanAnim !== null || yawAnim !== null) return;
    lastShakeFrame = now;
    const r = balance(state).ratio;
    const severity = Math.min(1, Math.max(0, (Math.abs(r) - 0.8) / 0.2));
    const amp = 0.02 + 0.02 * severity;
    const t = now / 1000;
    // A slow rock toward the drop with a fine tremor on top; never leans back past level.
    const wave = 0.55 + 0.37 * Math.sin(t * 2 * Math.PI * 1.1) + 0.08 * Math.sin(t * 2 * Math.PI * 5.5);
    shakeLean = Math.sign(r) * amp * wave;
    drawBoard();
  };
  shakeRaf = requestAnimationFrame(frame);
}

function setYaw(yaw: number) {
  if (yawAnim !== null) cancelAnimationFrame(yawAnim);
  yawAnim = null;
  viewYaw = targetYaw = yaw;
}

/** Spin the table half a turn so the other player's edge is nearest. */
function rotateView() {
  if (yawAnim !== null) cancelAnimationFrame(yawAnim);
  const start = viewYaw;
  targetYaw = Math.round(targetYaw / Math.PI + 1) * Math.PI;
  const end = targetYaw;
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / 650);
    const eased = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    viewYaw = start + (end - start) * eased;
    if (t < 1) {
      yawAnim = requestAnimationFrame(frame);
      drawBoard();
    } else {
      yawAnim = null;
      viewYaw = targetYaw = end % (2 * Math.PI);
      render();
    }
  };
  yawAnim = requestAnimationFrame(frame);
}

function animateLean() {
  if (leanAnim !== null) cancelAnimationFrame(leanAnim);
  const start = shownLean;
  const end = targetLean();
  if (Math.abs(end - start) < 1e-4) {
    shownLean = end;
    leanAnim = null;
    drawBoard();
    return;
  }
  const tipping = state.phase === 'over';
  const duration = tipping ? 900 : 450;
  const t0 = performance.now();
  const frame = (now: number) => {
    const t = Math.min(1, (now - t0) / duration);
    const eased = tipping ? t * t * t : 1 - Math.pow(1 - t, 3);
    shownLean = start + (end - start) * eased;
    leanAnim = t < 1 ? requestAnimationFrame(frame) : null;
    drawBoard();
  };
  leanAnim = requestAnimationFrame(frame);
}

// ---------- Rendering ----------

const PIPS: Record<DieFace, [number, number][]> = {
  1: [[50, 50]],
  2: [[28, 28], [72, 72]],
  3: [[28, 28], [50, 50], [72, 72]],
  4: [[28, 28], [72, 28], [28, 72], [72, 72]],
  5: [[28, 28], [72, 28], [50, 50], [28, 72], [72, 72]],
  6: [[28, 26], [72, 26], [28, 50], [72, 50], [28, 74], [72, 74]],
};

const dieFace = (face: DieFace) =>
  `<svg viewBox="0 0 100 100" class="die-face"><rect x="4" y="4" width="92" height="92" rx="20" />${PIPS[face]
    .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="9" />`)
    .join('')}</svg>`;

/** The dice are a display: they show which actions are available this turn. */
function dicePanel(): string {
  if (state.phase === 'over') return '';
  const mine = canAct();
  if (state.phase === 'roll') {
    const ev = eventBanner();
    if (ev) return ev + (mine ? `<button class="roll-btn turn-${state.turn}" data-act="roll">${state.isBonusRoll ? 'Bonus roll!' : 'Roll dice'} <kbd>Space</kbd></button>` : `<div class="waiting turn-${state.turn}">Waiting for ${playerName(state.turn)} to roll…</div>`);
    return mine
      ? `<button class="roll-btn turn-${state.turn}" data-act="roll">${state.isBonusRoll ? 'Bonus roll!' : 'Roll dice'} <kbd>Space</kbd></button>`
      : `<div class="waiting turn-${state.turn}">Waiting for ${playerName(state.turn)} to roll…</div>`;
  }
  if (state.comboChoice) {
    const banner = state.combo ? `<div class="combo combo-good"><strong>${state.combo.name}!</strong> ${state.combo.text}</div>` : '';
    if (!mine) return `${banner}<div class="waiting turn-${state.turn}">${playerName(state.turn)} is choosing a combo…</div>`;
    return `${banner}<div class="combo-choice">${CHOOSABLE_COMBOS.map((f) => {
      const c = DOUBLE_COMBOS[f].combo;
      return `<button class="choice-btn tone-${c.tone}" data-choose="${f}">${dieFace(f)}<span><strong>${c.name}</strong><small>${c.text.replace(/,? then roll again\.?/, '.')}</small></span></button>`;
    }).join('')}</div>`;
  }
  const dice = state.dice
    .map((die, i) => {
      const meaning = dieAction(die);
      const dead = !die.used && !dieIsPlayable(state, i);
      const status = die.used ? 'used' : dead ? 'no legal move' : die.forced ? 'forced' : die.bonus ? 'bonus' : 'available';
      return `<div class="die ${die.used ? 'used' : ''} ${dead ? 'dead' : ''} ${die.forced ? 'forced' : ''} ${die.bonus ? 'bonus' : ''} kind-${meaning}">
        ${dieFace(die.face)}
        <span class="die-text"><span class="die-label">${dieLabel(meaning)}</span><span class="die-status">${status}</span></span>
      </div>`;
    })
    .join('');
  const unused = state.dice.flatMap((d, i) => (d.used ? [] : [i]));
  const endTurn =
    mine && !remainingDiceDead() && unused.every((i) => canPass(state, i))
      ? `<button class="ghost-btn end-turn" data-act="end-turn">End turn</button>`
      : '';
  const banner = state.combo
    ? `<div class="combo combo-${state.combo.tone}"><strong>${state.combo.name}!</strong> ${state.combo.text}</div>`
    : '';
  const modes = canMoveAndSplit() && mine
    ? `<div class="mode-row"><button class="mode-btn ${splitMode ? '' : 'active'}" data-mode="move">Move whole stack</button><button class="mode-btn k-split ${splitMode ? 'active' : ''}" data-mode="split">Split off ${Math.floor((state.stacks[selected!]?.count ?? 0) / 2)}</button></div>`
    : '';
  return `${banner}${eventBanner()}<div class="dice-row dice-${state.dice.length > 3 ? 'many' : state.dice.length}">${dice}</div>${modes}${inPlaceButtons()}${endTurn}`;
}

/** Overheats and breakthroughs from the last action, shown until the next one. */
function eventBanner(): string {
  return state.event ? `<div class="combo combo-bad event">${state.event}</div>` : '';
}

const KIND_WORD: Record<ActionKind, string> = {
  split: '<span class="k-split">½ split</span>',
  spawn: '<span class="k-spawn">+ spawn</span>',
  move: '<span class="k-move">● move</span>',
  merge: '<span class="k-merge">merge</span>',
  strike: '<span class="k-strike">✕ strike</span>',
  reinforce: '<span class="k-reinforce">+1 reinforce</span>',
  convert: '<span class="k-convert">⟳ convert</span>',
};

function hint(): string {
  if (state.phase === 'over') return `Game over: the board tipped toward ${playerName(state.loser!)}. Start a new game to play again.`;
  if (!canAct()) return `${playerName(state.turn)} is playing. You'll see their moves here.`;
  if (state.phase === 'roll') return `${myColor() ? 'Your' : `${playerName(state.turn)}'s`} turn. Roll two dice; each die is one action.`;
  if (state.comboChoice) return 'Mother lode: pick the double combo you want. You roll again after using it.';
  if (remainingDiceDead()) return 'No legal move for the remaining dice. Passing the turn…';
  if (selected !== null) {
    const kinds = [...new Set(playable().filter((p) => fromOf(p.action) === selected).map((p) => p.action.kind))];
    const tiles = kinds.length ? `Tap a marked tile: ${kinds.map((k) => KIND_WORD[k]).join(' · ')}.` : '';
    const buttons = selectedInPlace().length ? ' Or use the button above.' : '';
    return `Stack picked up. ${tiles}${buttons} Tap the stack again to put it down.`;
  }
  const kinds = [...new Set(playable().map((p) => p.action.kind))];
  return `Tap a highlighted stack or spawn slot. Available: ${kinds.map((k) => KIND_WORD[k]).join(' · ')}`;
}

/**
 * Actions that stay on the picked-up stack (reinforce, spawn onto it). They live in the
 * action panel rather than over the board so they never cover a destination tile.
 */
function inPlaceButtons(): string {
  const opts = selectedInPlace();
  if (!opts.length) return '';
  return `<div class="inplace-row">${opts
    .map(
      (p) =>
        `<button class="pop-btn k-${p.action.kind}" data-inplace="${p.action.kind}">${p.action.kind === 'reinforce' ? '+1 Reinforce this stack' : '+1 Spawn onto this stack'}</button>`,
    )
    .join('')}</div>`;
}

/** Meter position (percent from the top) for a balance ratio; the marker moves toward the winning player's end. */
function meterPos(ratio: number): number {
  const towardFar = (flipped() ? -1 : 1) * Math.max(-1, Math.min(1, ratio)); // ratio > 0 means Red is winning
  return 50 - towardFar * 50;
}

function balanceStatus(): string {
  const b = balance(state);
  const leader = Math.abs(b.ratio) < 0.02 ? null : b.ratio > 0 ? 'red' : 'blue';
  const sinking = leader ? other(leader) : null;
  const status = state.loser
    ? `The board tipped toward <strong class="c-${state.loser}">${playerName(state.loser)}</strong>`
    : leader
      ? `<strong class="c-${leader}">${playerName(leader)}</strong> is winning: ${playerName(sinking!)}'s side is ${Math.round(Math.abs(b.ratio) * 100)}% of the way to tipping`
      : 'Level';
  return `<div class="balance">
    <div class="balance-status">${status}</div>
    <div class="balance-meta">Torque ${b.torque.toFixed(1)} of ${b.threshold.toFixed(1)} · ${b.totalPieces} pieces on the board</div>
  </div>`;
}

/** Vertical meter beside the board, oriented like the board: each player's end sits on their side. */
function meter(far: Player, near: Player): string {
  const pos = meterPos(balance(state).ratio);
  return `<div class="meter" aria-label="Balance meter">
    <span class="meter-label c-${far}">${playerName(far)}<br />wins</span>
    <div class="meter-track" style="background: linear-gradient(180deg, var(--${far}) 0%, rgba(255, 255, 255, 0.06) 50%, var(--${near}) 100%)">
      <div class="meter-danger top"></div><div class="meter-danger bottom"></div>
      <div class="meter-center"></div>
      <div class="meter-ghost" style="top:${pos}%"></div>
      <div class="meter-marker" style="top:${pos}%"></div>
    </div>
    <span class="meter-label c-${near}">${playerName(near)}<br />wins</span>
  </div>`;
}

const STATUS_TEXT: Record<NetStatus, string> = {
  starting: 'Opening the room…',
  waiting: 'Waiting for your friend to open the link.',
  connecting: 'Connecting…',
  connected: 'Connected',
  disconnected: 'Disconnected',
  full: 'This room already has two players.',
  error: 'Connection problem',
};

function onlinePanel(): string {
  if (online.mode === 'local') {
    // Hidden mid-game so a stray tap can't throw away the current game.
    if (gameInProgress()) return '';
    return `<div class="panel online">
      <h3>Online</h3>
      <p class="muted">Playing hot-seat on this device. Create a room to play a friend on another device: you are Red, they are Blue.</p>
      <button class="ghost-btn wide" data-act="host">Create online room</button>
    </div>`;
  }
  const s = online.status ? STATUS_TEXT[online.status] : '';
  const good = online.status === 'connected';
  const opponent = online.mode === 'host' ? (good ? 'Your friend is connected.' : s) : good ? 'Connected to the host.' : s;
  return `<div class="panel online">
    <h3>Online · room ${online.code}</h3>
    <p>You are <strong class="c-${myColor()}">${playerName(myColor()!)}</strong>.</p>
    <p class="net-status ${good ? 'ok' : 'pending'}"><span class="dot"></span>${opponent}${online.detail ? ` <span class="muted">${online.detail}</span>` : ''}</p>
    ${
      online.mode === 'host'
        ? `<label class="invite">Send this link to your friend<span class="invite-row"><input readonly value="${inviteLink()}" /><button class="ghost-btn" data-act="copy">${canShare() ? 'Share' : 'Copy'}</button></span></label>`
        : ''
    }
    <button class="ghost-btn wide" data-act="leave">Leave online game</button>
  </div>`;
}

function themePanel(): string {
  const opt = (id: Theme, name: string, blurb: string) =>
    `<button class="theme-opt ${theme === id ? 'active' : ''}" data-theme-pick="${id}"><span class="swatch swatch-${id}"></span><span><strong>${name}</strong><small>${blurb}</small></span></button>`;
  return `<div class="panel theme-panel">
    <h3>Style</h3>
    <div class="theme-row">${opt('neon', 'Neon', 'Glowing edges, arcade night')}${opt('forge', 'Forge', 'Riveted iron, 1880s mill')}</div>
  </div>`;
}

function settingsPanel(): string {
  const locked = online.mode === 'guest';
  const off = locked ? 'disabled' : '';
  const s = state.settings;
  const edgePieces = Math.ceil((PIPE_HALF_WIDTH * s.boardMass) / (3.5 - PIPE_HALF_WIDTH));
  const check = (name: string, on: boolean, label: string) =>
    `<label class="check"><input type="checkbox" name="${name}" ${on ? 'checked' : ''} ${off} /><span>${label}</span></label>`;
  return `<details class="panel settings">
    <summary>Settings and experiments</summary>
    ${locked ? '<p class="muted">Only the host can change settings or start a new game.</p>' : ''}
    <h4>Weight</h4>
    <label>Plate mass <span>(piece-weights)</span><input type="number" name="boardMass" min="0" step="5" value="${s.boardMass}" ${off} /></label>
    <label>Starting pieces per spawn slot<input type="number" name="startingPieces" min="0" max="5" step="1" value="${s.startingPieces}" ${off} /></label>
    <p class="muted">Pipe half-width is locked at ${PIPE_HALF_WIDTH}. With these values, about ${edgePieces} unopposed pieces on a far edge tip the board.</p>
    <h4>Rules</h4>
    ${check('forcedMoves', s.forcedMoves, '<strong>Forced moves</strong>: you must use every die that has a legal move, even a bad one')}
    <h4>Experiments</h4>
    ${check('threeDice', s.diceCount === 3, '<strong>Three dice</strong>: roll three dice a turn; three of a kind is a triple combo')}
    ${check('overheat', s.overheat, `<strong>Overheating spawns</strong>: each spawn heats its slot; ${OVERHEAT_AT} heat locks it for your next ${OVERHEAT_TURNS} turns. Slots cool by one each of your turns`)}
    ${check('towerBreak', s.towerBreak, `<strong>Breaking point</strong>: every cell hides a height limit (${BREAK_MIN}-${BREAK_MAX}). Stack past it and the tower punches through, leaving a permanent hole`)}
    <label>Piece limit per player <span>(0 = no limit)</span><input type="number" name="pieceLimit" min="0" max="99" step="1" value="${s.pieceLimit}" ${off} /></label>
    ${locked ? '' : '<button class="ghost-btn" data-act="apply-settings">Apply and restart</button>'}
  </details>`;
}

function comboTable(): string {
  const row = (c: { combo: { name: string; text: string; tone: string } }, dice: string) =>
    `<tr><td>${dice}</td><td class="tone-${c.combo.tone}">${c.combo.name}</td><td>${c.combo.text}</td></tr>`;
  const faces = [1, 2, 3, 4, 5, 6] as DieFace[];
  const doubles = faces.map((f) => row(DOUBLE_COMBOS[f], `${f}${f}`)).join('');
  const triples = state.settings.diceCount === 3 ? faces.map((f) => row(TRIPLE_COMBOS[f], `${f}${f}${f}`)).join('') : '';
  return `<h4>Combos</h4><table class="combos">${doubles}${triples}</table>
    <p class="muted">A pair is any two dice showing the same face, in any position. Convert takes over an adjacent enemy stack of up to ${CONVERT_MAX}. Combos work on bonus rolls too, but a bonus roll never earns another roll.</p>`;
}

function rulesPanel(): string {
  const rows = ([1, 2, 3, 4, 5, 6] as DieFace[])
    .map((f) => {
      const m = DIE_ACTIONS[f];
      const help = m === 'wild' ? 'Any of the actions above.' : m === 'mergesplit' ? `${ACTION_HELP.merge} Or: ${ACTION_HELP.split.toLowerCase()}` : ACTION_HELP[m];
      return `<tr><td>${f}</td><td>${dieLabel(m)}</td><td>${help}</td></tr>`;
    })
    .join('');
  return `<details class="panel rules">
    <summary>Rules</summary>
    <p>The plate balances on a square pipe across its middle. Each player owns the half on their side of the pipe, with three spawn slots on its outer edge. Weight far from the pipe counts more. If the board tips toward you, you lose — so push your stacks onto your opponent's side.</p>
    <table>${rows}</table>
    ${comboTable()}
    ${state.settings.overheat ? `<p class="muted">Overheating spawns: each spawn adds heat to its slot. At ${OVERHEAT_AT} heat the slot locks for your next ${OVERHEAT_TURNS} turns; otherwise it cools by one at the start of each of your turns.</p>` : ''}
    ${state.settings.towerBreak ? `<p class="muted">Breaking point: every cell hides a height limit between ${BREAK_MIN} and ${BREAK_MAX}. A stack taller than its cell's limit falls through and leaves a permanent hole nothing can enter.</p>` : ''}
    ${state.settings.pieceLimit > 0 ? `<p class="muted">Piece limit: each player may have at most ${state.settings.pieceLimit} pieces on the board. Spawn and reinforce stop at the cap.</p>` : ''}
    <p class="muted">Each turn roll ${state.settings.diceCount === 3 ? 'three' : 'two'} dice; each die is one action, used in any order. Tap a stack to pick it up and see where it can go, or tap a spawn slot to spawn. Dice with no legal move are skipped automatically. Enemy stacks block movement, and an enemy stack on your spawn slot stops you spawning there. The board can tip after any action, including toward the player who moved.</p>
  </details>`;
}

function resultCard(): string {
  if (state.phase !== 'over') return '';
  const winner = other(state.loser!);
  const me = myColor();
  const title = me ? (winner === me ? 'You win' : 'You lose') : `${playerName(winner)} wins`;
  return `<div class="result"><div class="result-card"><h2 class="c-${winner}">${title}</h2><p>The board tipped toward ${playerName(state.loser!)}.</p>${
    online.mode === 'guest' ? '<p class="muted">Waiting for the host to start a new game.</p>' : `<button class="roll-btn turn-${winner}" data-act="new">Play again</button>`
  }</div></div>`;
}

function render() {
  const far: Player = flipped() ? 'blue' : 'red';
  const near = other(far);
  const turnText = state.phase === 'over' ? 'Game over' : `Turn ${state.turnNumber} · <strong>${myColor() && state.turn === myColor() ? 'You' : playerName(state.turn)}</strong>`;

  app.innerHTML = `
    <header class="top">
      <h1>Hex Balance</h1>
      <div class="turn turn-${state.turn}">${turnText}</div>
      <button class="ghost-btn" data-act="rotate" title="Turn the board around">Rotate<span class="long"> view</span></button>
      ${online.mode === 'guest' ? '' : '<button class="ghost-btn" data-act="new">New<span class="long"> game</span></button>'}
    </header>
    ${balanceStatus()}
    <main class="layout">
      <section class="stage">
        <div class="side-label c-${far}">${playerName(far)} side</div>
        <div class="stage-row">
          <div class="tilt"><div class="board-host"></div></div>
          ${meter(far, near)}
        </div>
        <div class="side-label c-${near}">${playerName(near)} side</div>
        ${resultCard()}
      </section>
      <aside class="sidebar">
        <div class="panel actions-panel turn-${state.turn}">
          ${dicePanel()}
          <p class="hint">${hint()}</p>
        </div>
        ${onlinePanel()}
        ${themePanel()}
        <div class="panel log"><h3>Log</h3><ol>${state.log
          .slice(-14)
          .reverse()
          .map((l) => `<li>${l}</li>`)
          .join('')}</ol></div>
        ${rulesPanel()}
        ${settingsPanel()}
      </aside>
    </main>`;
  drawBoard();
  animateLean();
  updateShake();
  scheduleAutoPass();
}

// ---------- Events ----------

app.addEventListener('click', (event) => {
  const el = event.target as HTMLElement;
  const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'roll') return canAct() && dispatch({ type: 'roll' });
  if (act === 'new') {
    if (online.mode === 'guest') return;
    if (gameInProgress() && !confirm('Start a new game? The current game will be lost.')) return;
    return dispatch({ type: 'new' });
  }
  if (act === 'rotate') return rotateView();
  const pick = el.closest<HTMLElement>('[data-theme-pick]')?.dataset.themePick;
  if (pick === 'neon' || pick === 'forge') return setTheme(pick);
  if (act === 'host') return startHost();
  if (act === 'leave') {
    if (gameInProgress() && !confirm('Leave the online game? The current game will end.')) return;
    return leaveOnline();
  }
  if (act === 'end-turn') return canAct() && passRemaining();
  const mode = el.closest<HTMLElement>('[data-mode]')?.dataset.mode;
  if (mode) {
    splitMode = mode === 'split';
    return render();
  }
  const choose = el.closest<HTMLElement>('[data-choose]')?.dataset.choose;
  if (choose && canAct() && state.comboChoice) return dispatch({ type: 'choose', face: Number(choose) as DieFace });
  if (act === 'copy') {
    if (canShare()) {
      navigator.share({ title: 'Hex Balance', text: 'Join my Hex Balance game', url: inviteLink() }).catch(() => undefined);
      return;
    }
    navigator.clipboard?.writeText(inviteLink()).catch(() => undefined);
    el.textContent = 'Copied';
    return;
  }
  if (act === 'apply-settings') {
    if (online.mode === 'guest') return;
    const read = (name: string) => Number(app.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value);
    const settings: Settings = {
      boardMass: Math.max(0, read('boardMass') || 0),
      startingPieces: Math.max(0, Math.min(5, Math.round(read('startingPieces') || 0))),
      forcedMoves: app.querySelector<HTMLInputElement>('input[name="forcedMoves"]')!.checked,
      overheat: app.querySelector<HTMLInputElement>('input[name="overheat"]')!.checked,
      towerBreak: app.querySelector<HTMLInputElement>('input[name="towerBreak"]')!.checked,
      diceCount: app.querySelector<HTMLInputElement>('input[name="threeDice"]')!.checked ? 3 : 2,
      pieceLimit: Math.max(0, Math.min(99, Math.round(read('pieceLimit') || 0))),
    };
    saveSettings(settings);
    return setState(newGame(settings));
  }
  const kind = el.closest<HTMLElement>('[data-inplace]')?.dataset.inplace;
  if (kind) {
    const pick = selectedInPlace().find((p) => p.action.kind === kind);
    if (pick) dispatch({ type: 'act', die: pick.die, action: pick.action });
  }
});

// Board taps use pointer events: the plate is redrawn while it shakes, so a click
// (which needs the same element under both press and release) would be unreliable.
let pressAt: { x: number; y: number } | null = null;
app.addEventListener('pointerdown', (event) => {
  pressAt = (event.target as Element).closest('.board') ? { x: event.clientX, y: event.clientY } : null;
});
app.addEventListener('pointerup', (event) => {
  if (!pressAt) return;
  const moved = Math.hypot(event.clientX - pressAt.x, event.clientY - pressAt.y);
  pressAt = null;
  if (moved > 12) return;
  const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest<SVGElement>('.board [data-id]');
  if (hit) onCellTap(Number(hit.dataset.id));
  else if (selected !== null) {
    selected = null;
    render();
  }
});

// Hovering a destination previews where the balance marker would land.
app.addEventListener('mouseover', (event) => {
  const ghost = app.querySelector<HTMLElement>('.meter-ghost');
  if (!ghost) return;
  const cell = (event.target as Element).closest<SVGElement>('[data-id]')?.dataset.id;
  const ratio = previewRatio(cell === undefined ? null : actionForCell(Number(cell)));
  if (ratio === null) {
    ghost.classList.remove('show', 'fatal');
    return;
  }
  ghost.style.top = `${meterPos(ratio)}%`;
  ghost.classList.add('show');
  ghost.classList.toggle('fatal', Math.abs(ratio) >= 1);
});

window.addEventListener('keydown', (event) => {
  if ((event.target as HTMLElement).tagName === 'INPUT') return;
  if (event.code === 'Space' || event.code === 'Enter') {
    if (state.phase === 'roll' && canAct()) {
      event.preventDefault();
      dispatch({ type: 'roll' });
    }
  } else if (event.code === 'Escape' && selected !== null) {
    selected = null;
    render();
  }
});

// ---------- Boot ----------

const params = new URLSearchParams(location.search);
const joinCode = params.get('join')?.toUpperCase();
const hostCode = params.get('host')?.toUpperCase();
if (joinCode) startGuest(joinCode);
else if (hostCode) startHost(hostCode, true);
else render();
