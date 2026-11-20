# Hex Balance

**Status: playable prototype.** You can play it against a bot (easy, medium or hard), hot-seat on one device, or online between two devices. The rules are reconstructed from memory and still change as it gets played.

**Live:** https://hex-balance.vercel.app

![Hex Balance against the hard bot: the hexagonal plate on its pivot, a picked-up stack with its moves marked, the balance gauge and the dice panel](docs/screenshot.jpg)

| Title | Phone |
| --- | --- |
| ![The start menu](docs/after-title.jpg) | ![The game at phone width, with the dice panel pinned to the bottom](docs/after-phone.jpg) |

The look was redone on 2026-11-20. Before:

| Game, before | Title, before |
| --- | --- |
| ![The earlier Neon style: grey pieces with thin coloured outlines](docs/before-game.jpg) | ![The earlier title screen](docs/before-title.jpg) |

Zach Shirley and a best friend designed and built Hex Balance as a physical game in high school, and Zach rebuilt it as a web game in a couple of days with an AI coding agent. The original board was a hexagonal steel plate resting on a square pipe across its middle. Each player owns the half on their side of the pipe, and you roll dice to add, move, merge and knock over stacks of steel pieces. Weight far from the pipe counts more. If the plate tips toward you, you lose. "Hex Balance" is a working title, because nobody remembers what the original was called.

## How to play

- On your turn, roll two dice. Each die is one action, and you use them in any order:
  - 1: spawn
  - 2: move or jump
  - 3: merge or split
  - 4: strike
  - 5: reinforce
  - 6: wild
- Doubles trigger combos. Some help (Stampede gives four moves). Some hurt (Snake eyes forces three spawns on your own edge).
- Tap a highlighted stack to pick it up and see where it can go, or tap a spawn slot to spawn. The meter beside the board shows how close each side is to tipping, and hovering a move previews where the meter would land. Dice with no legal move are skipped automatically.
The game opens on a start menu. **Start game** leads to a setup screen with these choices:
- **Opponent:** two players on one device, or an Easy, Medium or Hard bot. Against a bot you play Red and move first.
- **Rules and experiments:**
  - plate mass and starting pieces;
  - forced moves;
  - experiments: three dice, overheating spawns, a hidden "breaking point" tower height, and a piece limit.
- **Play a friend online:** **Create online room** starts a room with those rules and gives you an invite link for a friend on another device.

During a game, **Menu** returns to the start screen, where you can continue the current game or set up a new one.

The full rules and combo table are in the in-game **Rules** panel.

## Run locally

```bash
npm install
npm run dev     # http://127.0.0.1:5340
npm test        # rules and bot tests (Vitest)
npm run build   # typecheck + production bundle
```

## Deployment

Hosted on Vercel at https://hex-balance.vercel.app. Pushes to `main` on GitHub (https://github.com/Zach-Shirley/hex-balance) deploy to production automatically through Vercel's Git integration. It is a static Vite build, with no backend of its own.

## Verification

**Automated tests:** 35 Vitest tests.
- `tests/rules.test.ts` covers:
  - board geometry and neighbours;
  - the balance and tipping maths;
  - every action type, combos, passing and forced dice;
  - overheat, and the breaking point (one shared hidden limit; only growing a tower can break it).
- `tests/bot.test.ts` checks that:
  - each bot level plays only legal moves through whole games, including with experiments on;
  - each bot takes a win when one is there;
  - no bot tips the board toward itself when it has a safe choice;
  - a bot with no pieces spawns instead of passing.

**Simulations:**
- The engine was fuzzed with about 87,000 random actions to check the breaking-point rule; it never let a tower stand above the limit.
- The bots were checked with bot-vs-bot tournaments:

| Matchup (default settings, alternating colours) | Result |
| --- | --- |
| Medium vs Easy | 27–3 |
| Hard vs Medium | 20–9 |
| Medium vs a scripted "rusher" (build one tall stack and march it across) | 30–7 |
| Hard vs the rusher | 23–6 |

**Checked by hand in a desktop browser:**
- local play against each bot level;
- the online room in two tabs, locally and on the live site;
- the phone-width layout, in a 375 px emulated viewport.

**Re-checked after the 2026-11-20 visual redo** (locally, with no console errors):
- a game against the Hard bot played by tapping the board, through to the bot's win and the result card;
- a hot-seat game through to a tip-over and the result card;
- an online room in two tabs: both sides connected, the host's turn passed and the guest rolled;
- the title, setup and game screens at desktop width and at 375 px.

**Not tested:**
- online play between two different home networks;
- real phones and tablets (only emulated);
- the bots against people other than Zach (Zach did beat an earlier Medium; that led to the current version);
- the bots under three dice, breaking point and forced moves since the latest bot revision. In an earlier version, Hard's edge over Medium nearly disappeared with three dice (6–5).

## Known limitations

- The rules are a best-effort reconstruction. Die 4 (strike) is a guess, and the movement, spawning and starting-piece details are assumptions (see the table below).
- **Online play** has no accounts and no server of its own. It uses PeerJS's free public servers, so it depends on their uptime. The host's tab must stay open, and the guest has to trust the host's dice.
- **The bots** play Blue only. They are tuned against each other, not against people. On big combo turns they think for up to about 2 seconds.

## How it was built

The web version was rebuilt in a couple of days in October 2026. Zach described the original game from memory: the board, the pivot, the dice meanings and how the balance worked. He supplied a photo of the etched plate, from which the 52-cell layout was counted.

| Element | Source |
| --- | --- |
| 52-cell board: 9 columns of 2, 5, 8, 7, 8, 7, 8, 5, 2 flat-top cells | Counted from Zach's photo of the plate |
| Pivot on a square pipe across the middle; tipping toward you loses | Zach's description |
| Three spawn slots on each player's outer edge | Zach's description |
| Roll two dice and use each one as an action | Zach's description |
| 1 spawn, 2 move, 3 merge, 5 reinforce, 6 wild | Zach's recollection |
| 4 = strike (knock one piece off an adjacent enemy stack) | Zach's best guess; unconfirmed |
| Enemy stacks on your spawn slots block spawning | Zach's description |
| Move = one step, or jump over one adjacent stack | Assumed (combines the remembered "move" and "jump") |
| Spawn may add to your own stack on a spawn slot | Assumed |
| One starting piece per spawn slot | Assumed |
| Tipping model and default weights | Assumed; tuned by simulation (below) |

From there, the game grew through rounds of Zach playing it and giving direction:
- the angled 3D-style view;
- online play so two devices could play;
- shake as the plate nears tipping;
- combos as a core rule, and merge/split on the 3;
- the experiments;
- two visual styles, later replaced by a single look (below);
- the single-player bots.

**Locked rules (2026-10-15):**
- Pipe half-width 0.5 and plate mass 20.
- Doubles combos are core: 11 Snake eyes, 22 Stampede, 33 Weld, 44 Convert, 55 Supply drop, 66 Jackpot.
- 3 is merge or split.
- Online, only the host changes settings.

**Weight model:** each piece weighs 1, and a stack's torque is its piece count times its distance from the pipe in cell heights. The plate rests on the flat top of a square pipe, so it tips once the combined centre of mass passes the pipe's edge:

```
|Σ pieces × distance|  ≥  pipeHalfWidth × (plateMass + total pieces)
```

A physical estimate of the real plate (about 145 piece-weights, half-width about 0.42) almost never produced a finished game in greedy-bot playtests, because the two sides kept cancelling each other out. The lighter plate keeps games to around 14 rounds; at mass 20, 86% of greedy-bot games finished.

**The bots** (`src/bot.ts`) play through the same rules engine as people. They try the action sequences their dice allow and score each resulting board on four things:
- the balance now;
- how much push each side's pieces still have as they advance;
- the odds, over every possible next roll (including forced combos), that someone can tip the board;
- having pieces in play at all.

Passing on a die that still has a legal move also costs the bot something, because the opponent keeps building while it waits. That cost was added on 2026-10-22, after Zach saw the bot sit on its lead and pass turn after turn.

Easy plays one die at a time and is often random. Medium plans its whole turn. Hard also checks every possible opponent reply roll. The bots run in a Web Worker so the board keeps animating.

**Visual redo (2026-11-20):** Zach asked for the visuals to be redone and left the style to the agent. The game now has one look, "crimson steel":
- **Pieces** are in their owner's colour, so you can tell whose stack is whose at a glance. Before, they were grey with a thin coloured outline.
- **The plate** has recessed cells, a faint tint on each player's half, and a dotted line scribed along the pivot.
- **The stand** is solid steel with a pool of light on the floor under it.
- **The gauge** shows the percentage on its marker, with hatched bands for the last 20% before tipping.
- **Player chips** above and below the board show who is to move, their piece count and how close their side is to tipping.
- **Callouts** stamp combos, breakthroughs and overheats over the board.
- **Amber** is kept for "your move": the main button on each screen and the stacks you can pick up.
- **Type** is Unbounded for display and Inter for text.

The earlier Neon and Forge styles were retired in the redo, along with the Style picker. The 3D "Foundry" arena (Three.js), archived on 2026-10-19, was removed from the code at the same time. All three remain in the history at git tag `foundry-archive`.

## Code

- `src/board.ts`: board geometry, neighbours, spawn slots, lever arms
- `src/rules.ts`: game state, legal actions, dice, combos, balance and tipping (pure, no DOM)
- `src/view3d.ts`: 2.5D projection of the plate, pipe and stacks into SVG
- `src/bot.ts`, `src/botWorker.ts`: single-player bots and the worker they run in
- `src/net.ts`: PeerJS host/guest sessions
- `src/main.ts`, `src/style.css`: UI, dice panel, balance meter, animation, panels

## AI assistance and Zach's role

The code was written with an AI coding agent (Claude Code). Zach's part:
- He supplied the original game, the board photo and the rule recollections.
- He made the design calls: the pipe width, combos as core, which experiments to try, the early visual direction, and archiving the 3D style. For the 2026-11-20 visual redo he set the brief (make it look better, keep the board and animations that work) and left the art direction to the agent.
- He playtested and reported problems. The breaking point felt inconsistent, the board vanished, and the Medium bot never spawned and lost to a tall-stack rush. Each report led to a fix.

The agent did the implementation, the tests, the simulations and the bot tuning.

## Attribution

- Fonts: Unbounded and Inter, loaded from Google Fonts, both under the SIL Open Font License.
- Libraries:
  - PeerJS (MIT) for online play;
  - Vite, TypeScript and Vitest for building and testing.
- No third-party art assets are used.

## License

No license yet. All rights reserved; the source is public to read.
