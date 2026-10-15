import './style.css';
import { CELLS, CENTER_H, SPAWNS } from './board';
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
  other,
  type Action,
  type ActionKind,
  type DieFace,
  type GameState,
  type Settings,
} from './rules';

// ---------- Geometry for drawing ----------

const R = 34; // cell circumradius in px
const HALF_H = (Math.sqrt(3) / 2) * R; // half the cell height = one `h` unit
const PAD = 26;

const centerOf = (id: number) => ({ x: CELLS[id].col * 1.5 * R, y: CELLS[id].h * HALF_H });

function hexPoints(cx: number, cy: number, r: number): [number, number][] {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as [number, number];
  });
}
const pts = (points: [number, number][]) => points.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

function convexHull(points: [number, number][]): [number, number][] {
  const p = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (const pt of p.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}

const PLATE_HULL = convexHull(CELLS.flatMap((c) => hexPoints(centerOf(c.id).x, centerOf(c.id).y, R)));
const xs = PLATE_HULL.map((p) => p[0]);
const ys = PLATE_HULL.map((p) => p[1]);
const VIEW = {
  x: Math.min(...xs) - PAD - 30,
  y: Math.min(...ys) - PAD - 10,
  w: Math.max(...xs) - Math.min(...xs) + 2 * PAD + 60,
  h: Math.max(...ys) - Math.min(...ys) + 2 * PAD + 20,
};
const PIVOT_Y = CENTER_H * HALF_H;

// ---------- State ----------

interface Ui {
  die: number | null;
  kind: ActionKind | null;
  from: number | null;
}

let state: GameState = newGame(loadSettings());
let ui: Ui = { die: null, kind: null, from: null };

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

function commit(next: GameState) {
  state = next;
  ui = { die: null, kind: null, from: null };
  render();
}

// ---------- Actions from the UI ----------

function onRoll() {
  if (state.phase !== 'roll') return;
  commit(roll(state));
}

function selectDie(index: number) {
  const die = state.dice[index];
  if (!die || die.used || state.phase !== 'act') return;
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
  if (state.phase !== 'act' || ui.die === null || !ui.kind) return;
  const target = targets().find((a) => a.to === id);
  if (target) {
    commit(applyAction(state, ui.die, target));
    return;
  }
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

// ---------- Rendering ----------

const app = document.querySelector<HTMLDivElement>('#app')!;

function boardSvg(): string {
  const src = sources();
  const tgt = new Map(targets().map((a) => [a.to, a]));
  const pipeHalf = Math.max(4, state.settings.pipeHalfWidth * 2 * HALF_H);
  const spawnOwner = new Map<number, string>([
    ...SPAWNS.red.map((id) => [id, 'red'] as [number, string]),
    ...SPAWNS.blue.map((id) => [id, 'blue'] as [number, string]),
  ]);

  const slots = CELLS.map(({ id }) => {
    const { x, y } = centerOf(id);
    const spawn = spawnOwner.get(id);
    const classes = ['slot', spawn ? `spawn spawn-${spawn}` : '', src.has(id) ? 'is-source' : '', tgt.has(id) ? `is-target target-${tgt.get(id)!.kind}` : '', ui.from === id ? 'is-from' : '']
      .filter(Boolean)
      .join(' ');
    return `<g class="${classes}" data-id="${id}">
      <polygon class="slot-hex" points="${pts(hexPoints(x, y, R - 3))}" />
      ${spawn ? `<polygon class="spawn-ring" points="${pts(hexPoints(x, y, R - 6))}" />` : ''}
    </g>`;
  }).join('');

  const pieces = state.stacks
    .map((stack, id) => {
      if (!stack) return '';
      const { x, y } = centerOf(id);
      const layers = Math.min(stack.count, 6);
      const lift = 3;
      // Taller stacks are drawn as offset layers so their height reads at a glance.
      const under = Array.from(
        { length: layers - 1 },
        (_, i) => `<polygon class="piece-layer" points="${pts(hexPoints(x, y - i * lift, R - 7))}" />`,
      ).join('');
      const topY = y - (layers - 1) * lift;
      const classes = ['stack', `owner-${stack.owner}`, src.has(id) ? 'is-source' : '', ui.from === id ? 'is-from' : '', tgt.has(id) ? 'is-target' : '']
        .filter(Boolean)
        .join(' ');
      return `<g class="${classes}" data-id="${id}">
        ${under}
        <polygon class="piece-top" points="${pts(hexPoints(x, topY, R - 7))}" />
        <polygon class="piece-sheen" points="${pts(hexPoints(x, topY, R - 13))}" />
        <text class="piece-count" x="${x}" y="${topY + 6}">${stack.count}</text>
      </g>`;
    })
    .join('');

  const markers = targets()
    .filter((a) => !state.stacks[a.to])
    .map((a) => {
      const { x, y } = centerOf(a.to);
      return `<circle class="target-dot" data-id="${a.to}" cx="${x}" cy="${y}" r="7" />`;
    })
    .join('');

  return `<svg class="board" viewBox="${VIEW.x} ${VIEW.y} ${VIEW.w} ${VIEW.h}" role="img" aria-label="Hexagonal balance board">
    <defs>
      <linearGradient id="plate" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#3a3f47" /><stop offset="0.5" stop-color="#2a2e35" /><stop offset="1" stop-color="#1d2026" />
      </linearGradient>
      <linearGradient id="steel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#e3e7ec" /><stop offset="0.45" stop-color="#aab1ba" /><stop offset="1" stop-color="#7c838d" />
      </linearGradient>
      <linearGradient id="pipe" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#6b7079" /><stop offset="0.5" stop-color="#9aa0a8" /><stop offset="1" stop-color="#4a4e55" />
      </linearGradient>
    </defs>
    <rect class="pipe" x="${VIEW.x + 4}" y="${PIVOT_Y - pipeHalf}" width="${VIEW.w - 8}" height="${pipeHalf * 2}" rx="3" />
    <polygon class="plate" points="${pts(PLATE_HULL)}" stroke-width="${PAD * 2}" />
    <polygon class="plate-face" points="${pts(PLATE_HULL)}" />
    <line class="pivot-line" x1="${VIEW.x + 20}" x2="${VIEW.x + VIEW.w - 20}" y1="${PIVOT_Y}" y2="${PIVOT_Y}" />
    ${slots}
    ${pieces}
    ${markers}
  </svg>`;
}

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
  if (state.phase === 'roll') {
    return `<button class="roll-btn turn-${state.turn}" data-act="roll">Roll dice <kbd>Space</kbd></button>`;
  }
  const dice = state.dice
    .map((die, i) => {
      const meaning = DIE_ACTIONS[die.face];
      const playable = allowedKinds(die.face).some((k) => legalActions(state, k).length > 0);
      const classes = ['die', die.used ? 'used' : '', ui.die === i ? 'selected' : '', !die.used && !playable ? 'dead' : '']
        .filter(Boolean)
        .join(' ');
      return `<div class="${classes}">
        <button class="die-btn" data-die="${i}" ${die.used ? 'disabled' : ''}>
          ${dieFace(die.face)}
          <span class="die-label">${meaning === 'wild' ? 'Wild' : ACTION_LABELS[meaning]}</span>
          ${!die.used && !playable ? '<span class="die-note">no legal move</span>' : ''}
        </button>
        ${die.used ? '<span class="die-used">used</span>' : `<button class="pass-btn" data-pass="${i}">Pass</button>`}
      </div>`;
    })
    .join('');

  let chooser = '';
  if (ui.die !== null && DIE_ACTIONS[state.dice[ui.die].face] === 'wild') {
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
  if (state.phase === 'roll') return `${playerName(state.turn)}'s turn. Roll two dice; each die is one action.`;
  if (ui.die === null) return 'Pick a die to use it, or pass on it.';
  if (!ui.kind) return 'Wild die: choose any action.';
  const legal = currentLegal();
  if (!legal.length) return `No legal ${ACTION_LABELS[ui.kind].toLowerCase()} right now. Pass on this die or pick the other one.`;
  if (needsSource(ui.kind) && ui.from === null) return `${ACTION_HELP[ui.kind]} Choose one of your highlighted stacks.`;
  if (needsSource(ui.kind)) return 'Now choose a highlighted destination. Click the stack again to change it.';
  return `${ACTION_HELP[ui.kind]} Choose a highlighted cell.`;
}

function balanceBar(): string {
  const b = balance(state);
  // Torque toward Blue's side (positive) means Red is winning, so the marker moves toward Red (left).
  const pos = 50 - Math.max(-1, Math.min(1, b.ratio)) * 50;
  const leader = Math.abs(b.ratio) < 0.02 ? null : b.ratio > 0 ? 'red' : 'blue';
  const sinking = leader ? other(leader) : null;
  const status = state.loser
    ? `The board tipped toward <strong class="c-${state.loser}">${playerName(state.loser)}</strong>`
    : leader
    ?`<strong class="c-${leader}">${playerName(leader)}</strong> is winning: ${playerName(sinking!)}'s side is ${Math.round(Math.abs(b.ratio) * 100)}% of the way to tipping`
    : 'Level';
  return `<div class="balance">
    <div class="balance-ends"><span class="c-red">◀ Red wins</span><span class="balance-status">${status}</span><span class="c-blue">Blue wins ▶</span></div>
    <div class="balance-track">
      <div class="balance-danger left"></div><div class="balance-danger right"></div>
      <div class="balance-center"></div>
      <div class="balance-ghost" style="left:${pos}%"></div>
      <div class="balance-marker" style="left:${pos}%"></div>
    </div>
    <div class="balance-meta">Torque ${b.torque.toFixed(1)} of ${b.threshold.toFixed(1)} · ${b.totalPieces} pieces on the board</div>
  </div>`;
}

function settingsPanel(): string {
  const s = state.settings;
  const edgePieces = Math.ceil((s.pipeHalfWidth * s.boardMass) / (3.5 - s.pipeHalfWidth));
  return `<details class="panel settings">
    <summary>Weight settings</summary>
    <label>Plate mass <span>(piece-weights)</span><input type="number" name="boardMass" min="0" step="5" value="${s.boardMass}" /></label>
    <label>Pipe half-width <span>(cell heights)</span><input type="number" name="pipeHalfWidth" min="0.05" step="0.05" value="${s.pipeHalfWidth}" /></label>
    <label>Starting pieces per spawn slot<input type="number" name="startingPieces" min="0" max="5" step="1" value="${s.startingPieces}" /></label>
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
    <p>The plate balances on a square pipe across its middle. Red's half is the top and Blue's half is the bottom. Weight far from the pipe counts more. If the board tips toward you, you lose — so push your stacks onto your opponent's side.</p>
    <table>${rows}</table>
    <p class="muted">Each turn roll two dice and use each one once, in any order, or pass on it. Enemy stacks block movement, and an enemy stack on your spawn slot stops you spawning there. The board can tip after any action, including toward the player who moved.</p>
  </details>`;
}

function render() {
  const b = balance(state);
  // Positive rotateX brings the bottom edge toward the viewer, so negate it to make the heavy side sink away.
  const tiltDeg = state.phase === 'over' ? (state.loser === 'blue' ? -55 : 55) : -b.ratio * 14;
  const shaky = state.phase !== 'over' && Math.abs(b.ratio) >= 0.8;

  app.innerHTML = `
    <header class="top">
      <h1>Hex Balance</h1>
      <div class="turn turn-${state.turn}">${state.phase === 'over' ? 'Game over' : `Turn ${state.turnNumber} · <strong>${playerName(state.turn)}</strong>`}</div>
      <button class="ghost-btn" data-act="new">New game</button>
    </header>
    ${balanceBar()}
    <main class="layout">
      <section class="stage">
        <div class="side-label c-red">Red side · spawns along this edge</div>
        <div class="tilt ${shaky ? 'shaky' : ''} ${state.phase === 'over' ? 'tipped' : ''}" style="transform: perspective(900px) rotateX(${tiltDeg}deg)">
          ${boardSvg()}
        </div>
        <div class="side-label c-blue">Blue side · spawns along this edge</div>
        ${
          state.phase === 'over'
            ? `<div class="result"><div class="result-card"><h2 class="c-${other(state.loser!)}">${playerName(other(state.loser!))} wins</h2><p>The board tipped toward ${playerName(state.loser!)}.</p><button class="roll-btn turn-${other(state.loser!)}" data-act="new">Play again</button></div></div>`
            : ''
        }
      </section>
      <aside class="sidebar">
        <div class="panel actions-panel">
          ${dicePanel()}
          <p class="hint">${hint()}</p>
        </div>
        <div class="panel log"><h3>Log</h3><ol>${state.log
          .slice(-14)
          .reverse()
          .map((l) => `<li>${l}</li>`)
          .join('')}</ol></div>
        ${rulesPanel()}
        ${settingsPanel()}
      </aside>
    </main>`;
}

// ---------- Events ----------

app.addEventListener('click', (event) => {
  const el = event.target as HTMLElement;
  const act = el.closest<HTMLElement>('[data-act]')?.dataset.act;
  if (act === 'roll') return onRoll();
  if (act === 'new') return commit(newGame(state.settings));
  if (act === 'apply-settings') {
    const read = (name: string) => Number(app.querySelector<HTMLInputElement>(`input[name="${name}"]`)!.value);
    const settings: Settings = {
      boardMass: Math.max(0, read('boardMass') || 0),
      pipeHalfWidth: Math.max(0.05, read('pipeHalfWidth') || DEFAULT_SETTINGS.pipeHalfWidth),
      startingPieces: Math.max(0, Math.min(5, Math.round(read('startingPieces') || 0))),
    };
    saveSettings(settings);
    return commit(newGame(settings));
  }
  const die = el.closest<HTMLElement>('[data-die]')?.dataset.die;
  if (die !== undefined) return selectDie(Number(die));
  const pass = el.closest<HTMLElement>('[data-pass]')?.dataset.pass;
  if (pass !== undefined) return commit(skipDie(state, Number(pass)));
  const kind = el.closest<HTMLElement>('[data-kind]')?.dataset.kind;
  if (kind) return selectKind(kind as ActionKind);
  const cell = el.closest<SVGElement>('[data-id]')?.dataset.id;
  if (cell !== undefined) return onCellClick(Number(cell));
});

// Hovering a destination previews where the balance marker would land.
app.addEventListener('mouseover', (event) => {
  const ghost = app.querySelector<HTMLElement>('.balance-ghost');
  if (!ghost) return;
  const cell = (event.target as Element).closest<SVGElement>('[data-id]')?.dataset.id;
  const action = cell === undefined ? null : targets().find((a) => a.to === Number(cell)) ?? null;
  const ratio = previewRatio(action);
  if (ratio === null) {
    ghost.classList.remove('show', 'fatal');
    return;
  }
  ghost.style.left = `${50 - Math.max(-1, Math.min(1, ratio)) * 50}%`;
  ghost.classList.add('show');
  ghost.classList.toggle('fatal', Math.abs(ratio) >= 1);
});

window.addEventListener('keydown', (event) => {
  if ((event.target as HTMLElement).tagName === 'INPUT') return;
  if (event.code === 'Space' || event.code === 'Enter') {
    if (state.phase === 'roll') {
      event.preventDefault();
      onRoll();
    }
  } else if (event.code === 'Escape') {
    ui = { die: null, kind: null, from: null };
    render();
  } else if (event.key === '1' || event.key === '2') {
    selectDie(Number(event.key) - 1);
  }
});

render();
