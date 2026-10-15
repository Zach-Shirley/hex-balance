import './style.css';
import {
  ACTION_HELP,
  ACTION_LABELS,
  DEFAULT_SETTINGS,
  DIE_ACTIONS,
  allowedKinds,
  applyAction,
  balance,
  legalActions,
  newGame,
  playerName,
  resolveStacks,
  roll,
  skipDie,
  canPass,
  other,
  type Action,
  type ActionKind,
  type DieFace,
  type GameState,
  type Player,
  type Settings,
} from './rules';
import { renderBoard } from './view3d';
import { GuestSession, HostSession, newRoomCode, type Intent, type NetStatus } from './net';

// ---------- State ----------

interface Ui {
  die: number | null;
  kind: ActionKind | null;
  from: number | null;
}

interface Online {
  mode: 'local' | 'host' | 'guest';
  code: string | null;
  status: NetStatus | null;
  detail: string | null;
}

let state: GameState = newGame(loadSettings());
let ui: Ui = { die: null, kind: null, from: null };
let online: Online = { mode: 'local', code: null, status: null, detail: null };
let host: HostSession | null = null;
let guest: GuestSession | null = null;
/** Camera yaw in radians: 0 views from Blue's edge, π from Red's. Online players view from their own edge. */
let viewYaw = 0;
let targetYaw = 0;
let yawAnim: number | null = null;
const flipped = () => Math.cos(targetYaw) < 0;

const myColor = (): Player | null => (online.mode === 'host' ? 'red' : online.mode === 'guest' ? 'blue' : null);
const canAct = () => state.phase !== 'over' && (myColor() === null || state.turn === myColor());

function loadSettings(): Settings {
  try {
    const saved = JSON.parse(localStorage.getItem('hex-balance-settings') ?? 'null');
    if (saved) return { ...DEFAULT_SETTINGS, ...saved };
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

const needsSource = (kind: ActionKind) => kind === 'move' || kind === 'merge' || kind === 'strike';

function currentLegal(): Action[] {
  return ui.kind ? legalActions(state, ui.kind) : [];
}

function sources(): Set<number> {
  if (!ui.kind || !needsSource(ui.kind)) return new Set();
  return new Set(currentLegal().map((a) => ('from' in a ? a.from : -1)));
}

function targets(): Action[] {
  if (!ui.kind) return [];
  if (needsSource(ui.kind)) return ui.from === null ? [] : currentLegal().filter((a) => 'from' in a && a.from === ui.from);
  return currentLegal();
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
  }
}

function setState(next: GameState) {
  state = next;
  ui = { die: null, kind: null, from: null };
  saveHostState();
  host?.send(state);
  render();
}

function dispatch(intent: Intent) {
  if (online.mode === 'guest') {
    guest?.send(intent);
    ui = { die: null, kind: null, from: null };
    render();
    return;
  }
  try {
    setState(resolveIntent(state, intent));
  } catch (err) {
    console.warn('Rejected intent', intent, err);
  }
}

/** The host applies the guest's intents only on Blue's turn (or to restart a finished game). */
function onGuestIntent(intent: Intent) {
  const allowed = intent.type === 'new' ? state.phase === 'over' : state.turn === 'blue';
  if (!allowed) return host?.send(state);
  try {
    setState(resolveIntent(state, intent));
  } catch {
    host?.send(state);
  }
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
    if (saved) state = saved;
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
      state = next;
      ui = { die: null, kind: null, from: null };
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

// ---------- UI handlers ----------

function selectDie(index: number) {
  const die = state.dice[index];
  if (!canAct() || !die || die.used || state.phase !== 'act') return;
  const kinds = allowedKinds(die.face);
  ui = { die: index, kind: kinds.length === 1 ? kinds[0] : null, from: null };
  render();
}

function selectKind(kind: ActionKind) {
  if (ui.die === null) return;
  ui = { ...ui, kind, from: null };
  render();
}

function onCellClick(id: number) {
  if (!canAct() || state.phase !== 'act' || ui.die === null || !ui.kind) return;
  const target = targets().find((a) => a.to === id);
  if (target) return dispatch({ type: 'act', die: ui.die, action: target });
  if (needsSource(ui.kind) && sources().has(id)) {
    ui = { ...ui, from: ui.from === id ? null : id };
  } else {
    ui = { ...ui, from: null };
  }
  render();
}

function previewRatio(action: Action | null): number | null {
  if (!action) return null;
  return balance({ settings: state.settings, stacks: resolveStacks(state.stacks, state.turn, action) }).ratio;
}

// ---------- Board animation ----------

const app = document.querySelector<HTMLDivElement>('#app')!;
let shownLean = 0;
let leanAnim: number | null = null;

/** Radians. A small lean while standing (visual only), a big one once it tips. */
function targetLean(): number {
  if (state.phase === 'over') return state.loser === 'blue' ? 0.5 : -0.5;
  return Math.max(-1, Math.min(1, balance(state).ratio)) * 0.1;
}

function drawBoard() {
  const host = app.querySelector<HTMLElement>('.board-host');
  if (!host) return;
  const view = renderBoard({
    stacks: state.stacks,
    pipeHalfWidth: state.settings.pipeHalfWidth,
    lean: shownLean,
    yaw: viewYaw,
    sources: canAct() ? sources() : new Set(),
    targets: canAct() ? new Map(targets().map((a) => [a.to, a.kind])) : new Map(),
    from: ui.from,
  });
  host.innerHTML = view.under + view.board;

  // Near tipping, rock only the plate and its stacks about the pipe, toward the sinking side.
  const ratio = balance(state).ratio;
  const board = host.querySelector<SVGElement>('.board');
  if (board && state.phase !== 'over' && Math.abs(ratio) >= 0.8 && yawAnim === null) {
    const sinking: Player = ratio > 0 ? 'blue' : 'red';
    const near: Player = Math.cos(viewYaw) < 0 ? 'red' : 'blue';
    const severity = Math.min(1, (Math.abs(ratio) - 0.8) / 0.2);
    // Positive rotateX lifts the near edge, so sinking the near edge needs a negative angle.
    const deg = (0.5 + 1.1 * severity) * (sinking === near ? -1 : 1);
    board.style.setProperty('--sway', `${deg.toFixed(2)}deg`);
    board.style.transformOrigin = `50% ${view.pivotPct.toFixed(1)}%`;
    board.classList.add('swaying');
  }
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
    drawBoard();
    leanAnim = t < 1 ? requestAnimationFrame(frame) : null;
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

function dicePanel(): string {
  if (state.phase === 'over') return '';
  const mine = canAct();
  if (state.phase === 'roll') {
    return mine
      ? `<button class="roll-btn turn-${state.turn}" data-act="roll">Roll dice <kbd>Space</kbd></button>`
      : `<div class="waiting turn-${state.turn}">Waiting for ${playerName(state.turn)} to roll…</div>`;
  }
  const dice = state.dice
    .map((die, i) => {
      const meaning = DIE_ACTIONS[die.face];
      const playable = allowedKinds(die.face).some((k) => legalActions(state, k).length > 0);
      const classes = ['die', die.used ? 'used' : '', ui.die === i ? 'selected' : '', !die.used && !playable ? 'dead' : '']
        .filter(Boolean)
        .join(' ');
      return `<div class="${classes}">
        <button class="die-btn" data-die="${i}" ${die.used || !mine ? 'disabled' : ''}>
          ${dieFace(die.face)}
          <span class="die-label">${meaning === 'wild' ? 'Wild' : ACTION_LABELS[meaning]}</span>
          ${!die.used && !playable ? '<span class="die-note">no legal move</span>' : ''}
        </button>
        ${die.used ? '<span class="die-used">used</span>' : mine && canPass(state, i) ? `<button class="pass-btn" data-pass="${i}">Pass</button>` : ''}
      </div>`;
    })
    .join('');

  let chooser = '';
  if (mine && ui.die !== null && DIE_ACTIONS[state.dice[ui.die].face] === 'wild') {
    chooser = `<div class="wild-choices">${(Object.keys(ACTION_LABELS) as ActionKind[])
      .map((k) => {
        const n = legalActions(state, k).length;
        return `<button class="chip ${ui.kind === k ? 'active' : ''}" data-kind="${k}" ${n ? '' : 'disabled'}>${ACTION_LABELS[k]}</button>`;
      })
      .join('')}</div>`;
  }
  return `<div class="dice-row">${dice}</div>${chooser}`;
}

function hint(): string {
  if (state.phase === 'over') return `Game over: the board tipped toward ${playerName(state.loser!)}. Start a new game to play again.`;
  if (!canAct()) return `${playerName(state.turn)} is playing. You'll see their moves here.`;
  if (state.phase === 'roll') return `${myColor() ? 'Your' : `${playerName(state.turn)}'s`} turn. Roll two dice; each die is one action.`;
  if (ui.die === null) {
    return state.settings.forcedMoves
      ? 'Pick a die to use it. Forced moves are on: you can only pass on a die with no legal move.'
      : 'Pick a die to use it, or pass on it.';
  }
  if (!ui.kind) return 'Wild die: choose any action.';
  const legal = currentLegal();
  if (!legal.length) return `No legal ${ACTION_LABELS[ui.kind].toLowerCase()} right now. Pass on this die or pick the other one.`;
  if (needsSource(ui.kind) && ui.from === null) return `${ACTION_HELP[ui.kind]} Choose one of your highlighted stacks.`;
  if (needsSource(ui.kind)) return 'Now choose a highlighted destination. Click the stack again to change it.';
  return `${ACTION_HELP[ui.kind]} Choose a highlighted cell.`;
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

function settingsPanel(): string {
  if (online.mode === 'guest') return '';
  const s = state.settings;
  const edgePieces = Math.ceil((s.pipeHalfWidth * s.boardMass) / (3.5 - s.pipeHalfWidth));
  return `<details class="panel settings">
    <summary>Weight settings</summary>
    <label>Plate mass <span>(piece-weights)</span><input type="number" name="boardMass" min="0" step="5" value="${s.boardMass}" /></label>
    <label>Pipe half-width <span>(cell heights)</span><input type="number" name="pipeHalfWidth" min="0.05" step="0.05" value="${s.pipeHalfWidth}" /></label>
    <label>Starting pieces per spawn slot<input type="number" name="startingPieces" min="0" max="5" step="1" value="${s.startingPieces}" /></label>
    <label class="check"><input type="checkbox" name="forcedMoves" ${s.forcedMoves ? 'checked' : ''} /><span><strong>Forced moves</strong>: you must use a die if it has any legal move, even a bad one</span></label>
    <p class="muted">With these values, about ${edgePieces} unopposed pieces on a far edge tip the board.</p>
    <button class="ghost-btn" data-act="apply-settings">Apply and restart</button>
  </details>`;
}

function rulesPanel(): string {
  const rows = ([1, 2, 3, 4, 5, 6] as DieFace[])
    .map((f) => {
      const m = DIE_ACTIONS[f];
      return `<tr><td>${f}</td><td>${m === 'wild' ? 'Wild' : ACTION_LABELS[m]}</td><td>${m === 'wild' ? 'Any of the actions above.' : ACTION_HELP[m]}</td></tr>`;
    })
    .join('');
  return `<details class="panel rules">
    <summary>Rules</summary>
    <p>The plate balances on a square pipe across its middle. Each player owns the half on their side of the pipe, with three spawn slots on its outer edge. Weight far from the pipe counts more. If the board tips toward you, you lose — so push your stacks onto your opponent's side.</p>
    <table>${rows}</table>
    <p class="muted">Each turn roll two dice and use each one once, in any order, or pass on it. Enemy stacks block movement, and an enemy stack on your spawn slot stops you spawning there. The board can tip after any action, including toward the player who moved.</p>
  </details>`;
}

function resultCard(): string {
  if (state.phase !== 'over') return '';
  const winner = other(state.loser!);
  const me = myColor();
  const title = me ? (winner === me ? 'You win' : 'You lose') : `${playerName(winner)} wins`;
  return `<div class="result"><div class="result-card"><h2 class="c-${winner}">${title}</h2><p>The board tipped toward ${playerName(state.loser!)}.</p><button class="roll-btn turn-${winner}" data-act="new">Play again</button></div></div>`;
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
        <div class="panel actions-panel">
          ${dicePanel()}
          <p class="hint">${hint()}</p>
        </div>
        ${onlinePanel()}
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
}

// ---------- Events ----------

app.addEventListener('click', (event) => {
  const el = event.target as HTMLElement;
  const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'roll') return canAct() && dispatch({ type: 'roll' });
  if (act === 'new') {
    if (online.mode === 'guest' && state.phase !== 'over') return;
    return dispatch({ type: 'new' });
  }
  if (act === 'rotate') {
    return rotateView();
  }
  if (act === 'host') return startHost();
  if (act === 'leave') return leaveOnline();
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
    const read = (name: string) => Number(app.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value);
    const settings: Settings = {
      boardMass: Math.max(0, read('boardMass') || 0),
      pipeHalfWidth: Math.max(0.05, read('pipeHalfWidth') || DEFAULT_SETTINGS.pipeHalfWidth),
      startingPieces: Math.max(0, Math.min(5, Math.round(read('startingPieces') || 0))),
      forcedMoves: app.querySelector<HTMLInputElement>('input[name="forcedMoves"]')!.checked,
    };
    saveSettings(settings);
    return setState(newGame(settings));
  }
  const die = el.closest<HTMLElement>('[data-die]')?.dataset.die;
  if (die !== undefined) return selectDie(Number(die));
  const pass = el.closest<HTMLElement>('[data-pass]')?.dataset.pass;
  if (pass !== undefined) return canAct() && dispatch({ type: 'pass', die: Number(pass) });
  const kind = el.closest<HTMLElement>('[data-kind]')?.dataset.kind;
  if (kind) return selectKind(kind as ActionKind);
  const cell = el.closest<SVGElement>('[data-id]')?.dataset.id;
  if (cell !== undefined) return onCellClick(Number(cell));
});

// Hovering a destination previews where the balance marker would land.
app.addEventListener('mouseover', (event) => {
  const ghost = app.querySelector<HTMLElement>('.meter-ghost');
  if (!ghost) return;
  const cell = (event.target as Element).closest<SVGElement>('[data-id]')?.dataset.id;
  const action = cell === undefined || !canAct() ? null : (targets().find((a) => a.to === Number(cell)) ?? null);
  const ratio = previewRatio(action);
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
  } else if (event.code === 'Escape') {
    ui = { die: null, kind: null, from: null };
    render();
  } else if (event.key === '1' || event.key === '2') {
    selectDie(Number(event.key) - 1);
  }
});

// ---------- Boot ----------

const params = new URLSearchParams(location.search);
const joinCode = params.get('join')?.toUpperCase();
const hostCode = params.get('host')?.toUpperCase();
if (joinCode) startGuest(joinCode);
else if (hostCode) startHost(hostCode, true);
else render();
