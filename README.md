# Hex Balance

A browser recreation of the steel hexagonal balance game Zach Shirley and a friend built in a high-school metalworking class. "Hex Balance" is a working title; the original name is not known.

The board is a hexagonal steel plate balanced on a square pipe that runs across its middle. Each player owns the half on their side of the pipe. Players add, move, merge and strike stacks of hexagonal steel pieces. If the board tips toward you, you lose.

Status: playable hot-seat on one device, or online between two devices. The rules are a reconstruction from memory and are expected to change.

Live (temporary, approved by Zach on 2026-10-15): https://hex-balance.vercel.app. Vercel project `zach-shirleys-projects/hex-balance`, deployed manually with `vercel deploy --prod`; no Git integration.

## Online play

Click **Create online room**: you play Red and get an invite link (`?join=CODE`) for Blue. The two browsers connect directly over WebRTC using PeerJS. Its free public server only introduces the peers, and its public relay servers carry traffic when a direct path is blocked. The host's browser holds the game state and rolls the dice; the guest sends intended actions, which the host checks before applying them on Blue's turn. A third device gets "room full". The host's game is saved in localStorage under the room code, so reloading `?host=CODE` resumes it and the guest reconnects automatically.

Limits: there are no accounts and no server of our own, and the host must keep their tab open. The guest has to trust the host's dice. Two-tab tests on one machine pass, locally and on the live site; play between two different home networks has not been tested yet.

## Run

```bash
npm install
npm run dev     # http://127.0.0.1:5340
npm test        # rules engine tests
npm run build   # typecheck + production bundle
```

## What came from the original game, and what was assumed

| Element | Source |
| --- | --- |
| 52-cell board: 9 columns of 2, 5, 8, 7, 8, 7, 8, 5, 2 flat-top cells | Counted from Zach's photo of the etched plate |
| Pivot on a square pipe across the middle; tipping toward you loses | Zach's description |
| Three spawn slots on each player's outer edge | Zach's description |
| Roll two dice and use each one as an action | Zach's description |
| 1 spawn, 2 move, 3 merge, 5 reinforce, 6 wild | Zach's recollection |
| 4 = strike (knock one piece off an adjacent enemy stack) | Zach's best guess; unconfirmed |
| Enemy stacks on your spawn slots block spawning | Zach's description |
| Move = one step, or jump over one adjacent stack | Assumed (combines the remembered "move" and "jump") |
| Spawn may add to your own stack on a spawn slot | Assumed, so starting pieces don't make early 1s useless |
| One starting piece per spawn slot | Assumed |
| Dice may be passed; used in any order | Assumed |
| Tipping model and default weights | Assumed; see below |

## Weight model

Each piece weighs 1. A stack's torque is its piece count × its distance from the pipe in cell heights; Red's half is negative and Blue's is positive. The plate rests on the flat top of a square pipe, so it tips once the combined centre of mass passes the pipe's edge:

```
|Σ pieces × distance|  ≥  pipeHalfWidth × (plateMass + total pieces)
```

A rough physical estimate (3 cm cells, 1 cm plate, 0.5 cm pieces, 1-inch pipe) gives a plate of ~145 piece-weights and a half-width of ~0.42 cell heights. In greedy-bot playtests (120 games per setting, capped at 150 rounds), that weight almost never ended: both sides keep cancelling each other's torque.

| Plate mass / pipe half-width | Games that ended | Median rounds |
| --- | --- | --- |
| 120 / 0.35 | 15 / 120 | did not end |
| 60 / 0.25 | 99 / 120 | 34 |
| 40 / 0.25 (default) | 116 / 120 | 19 |

These values can be changed in the in-game **Weight settings** panel.

## Code

- `src/board.ts`: board geometry, neighbours, spawn slots, lever arms
- `src/rules.ts`: game state, legal actions, dice, balance and tipping (pure, no DOM)
- `src/view3d.ts`: 2.5D projection of the plate, pipe and stacks (camera 50 degrees above the near edge; lean rotates the plate about the pipe)
- `src/net.ts`: PeerJS host/guest sessions
- `src/main.ts`, `src/style.css`: UI, dice panel, balance meter, lean and tip animation, online panel
- `tests/rules.test.ts`: geometry, balance and action tests

Built with AI assistance (Claude Code) under Zach's direction; Zach supplied the original game, board photo and rule recollections.
