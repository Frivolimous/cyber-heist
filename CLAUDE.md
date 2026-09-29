# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Cyber-Heist: a real-time browser social-deduction game (6-30 players over a video call, each on their own
PC). Bank employees keep payments flowing; secret Black Hats divert money to mule accounts. Two racing
progress bars decide it. The repo is a pure rules engine, the game screen with its sandbox, and online play
over Firebase Realtime Database where the host's browser runs the engine.

## Commands

```bash
npm run dev          # start page at http://localhost:5173 (?seed=7: offline sandbox; &net=local: online play between tabs)
npm test             # engine and network tests (node:test via tsx)
npm run typecheck    # tsc --noEmit (strict)
npx tsx --test --test-name-pattern="time of day" src/engine/engine.test.ts   # one test by name
```

There is no linter. Engine tests live in `src/engine/engine.test.ts` (network tests in `src/net/net.test.ts`); its `Sim` helper wraps a seeded game
(`sim.at(sec)`, `sim.run(pid, code, system, module, fn, params)`, `sim.code(pid, system, module)`,
`sim.byRole(role)`, `sim.bankerOf(customerId)`). Games are deterministic per seed, so changing the order of
RNG calls in setup reshuffles every seeded test.

## Architecture

**Engine (`src/engine/`) is pure.** No DOM, no I/O. `applyAction(state, action, now)` returns a NEW state
(structuredClone) plus a result; `tick`/`advanceState` bring the clock forward. All randomness goes
through `rng.ts` (seeded, stored in state). `getPlayerView` (views.ts) is the only thing a player may see;
never hand raw `GameState` to player-facing code.

**Everything a player can do is data in `catalog.ts`**: systems > modules > functions (`fn(...)` with
params and READ/WRITE), plus `ROLES` (starting credentials per role), `roleCounts`/`hackerCount`
(player-count formulas), `MIN_PLAYERS`/`MAX_PLAYERS`, and `DEFAULT_CONFIG`. Each catalog function has one
handler in `handlers.ts` keyed `H['SYSTEM.MODULE.FN']`. `engine.ts` does everything common before a
handler runs: code lookup, scope check, lockouts, firewall blocks, offline modules, logging.

**Attribution is the core mechanic.** A credential = owner + 4-digit code + scope. Anyone who enters a
code acts as its owner: logs, payment history and account changes record the owner (`by`, `byOwner`,
`actor`) while the real player is kept separately (`actualPlayerId`) and only surfaces via Trace or the
sandbox's Ground truth panel. In a handler, `c.owner` is who the records name and `c.actor` is who typed.
Keep both whenever you record something.

**Scaled config.** `createGame` derives `whiteTarget`, `blackTarget`, `npcIntervalSec` and
`requestIntervalSec` from per-player settings via `scaledConfig` (setup.ts); an explicit value in the
game's config overrides the derivation. Arrival times are then bent by time-of-day pacing
(`pacing.ts`: `DAY_PHASES`, `nextArrival`), which keeps the game-wide total unchanged.

**Money.** A payment lands in the beneficiary's primary account *at settlement*, so changing a primary
diverts payments already in flight (the core heist). Settling into a Target Ledger account counts as
stolen; otherwise it counts toward the bank target only if `countsForBank` (bank.ts) agrees: automatic
payments always, manual ones only when they fulfil a linked payment request (same payee and amount).

**Hidden host (`BLACKHAT_DB`, a random address per game: `s.hiddenHost`, read it via `systemAddress`).** Its use never names anyone: it writes an "Unknown server
activity" `HIDDEN_ACCESS` log entry, and Trace returns only partial clues. Black Hat kit tools are
balanced by exposure, not cooldowns: `raiseExposure(c, tier)` tags the entry, and tier 2+ raises an
alert that points at the entry without containing the leak; the trace reveals more the higher the tier.
Adding a kit tool touches: catalog `fns`, a handler that calls `raiseExposure`, `HIDDEN_ACTIVITY` wording
in engine.ts, and a `MODULE_PAGES` entry in the sandbox.

**Game screen and sandbox (`src/sandbox/main.ts`).** The yellow bar at the top is dev tooling (seat switcher, speed,
player count, seed, Ground truth); everything below it is the player's screen. Module pages come from
the `MODULE_PAGES` registry (`commands` renders cards, `run` executes). The unregistered host's windows
get a dark theme and its tool kits a purple one via the `host`/`kit` classes.

**Online play (`src/net/`, `src/play/`).** The host's browser holds the `GameState` and runs the engine;
there are no Cloud Functions (free Spark plan). `HostSession` reads actions from `games/{code}/actions`,
applies each as the sender's seat (never the playerId they sent: `parseAction`), answers in `results`, and
publishes each seated player's `getPlayerView` to `views/{pid}` in JSON-text parts, rewriting only parts
that changed. `database.rules.json` lets a player read only their own view. Because the host sees
everything, a real game's host is a non-playing facilitator. Everything goes through the `Db` interface
(db.ts): Firebase in production, `LocalDb` in tests (memory) and in local mode (localStorage shared by
tabs). The game screen (main.ts) runs in one of three modes set by app.ts in mode.ts: offline, online
sandbox host, or remote seat; on a remote seat there is no `GameState`, so screen code reads only
`view()` and plays actions through `act()`. Anything the screen needs must be in `PlayerView`.

## Design rules to respect

- **Manual lookup and typing is gameplay.** No dropdowns, autocomplete or quick-fill for game data
  (customers, accounts, amounts, IPs, log ids). Selects are fine for the app's own structure (modules,
  roles, modes, durations).
- Personal Bankers are scoped to their own customers and requests; every other role sees all
  (`ownCustomersOnly` in handlers.ts).
- Job descriptions (jobs.ts) derive their numbers from the config; keep them in sync when a rule
  changes.

## Docs

- `docs/RULES.md`: the rules as implemented. Update it whenever behaviour changes.
- `docs/BACKLOG.md`: the single source of truth for agreed-but-unbuilt, deferred and rejected work.
  Move items out when they ship.
- `docs/TO-DO.md` is the designer's own notes: leave it alone.
- `README.md` is the player-facing overview; keep its "game in brief" and sandbox sections current.
