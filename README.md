# Cyber-Heist

Browser social-deduction game: bank employees, secret allegiances, shared 4-digit credentials,
and logs that name the credential owner rather than the person who typed the code.

This repo currently contains:

1. **`src/engine/`** the rules engine. Pure TypeScript, no Firebase, no DOM. Every action is
   `applyAction(state, action, now) -> { state, result }`, so the same code will later run inside a
   Cloud Function as the authority.
2. **`src/sandbox/`** a local single-browser UI. One person can play all 10 seats by switching
   players on the left. Use it to feel the rules before any networking exists.

Firebase, lobby and real multiplayer come next (see "Roadmap").

## Run it

```bash
npm install
npm run dev        # sandbox at http://localhost:5173  (add ?seed=7 to pick a game)
npm test           # engine tests (node:test via tsx)
npm run typecheck
```

## Playing the sandbox

- Click a player on the left to sit at their workstation. Their credentials, private info,
  personal activity log and messages are on the right.
- Pick a function, confirm the 4-digit code (auto-filled from a credential you hold), press Run.
  You can type any code: that is how guessing and using someone else's credential works.
- **Ground truth (spoilers)** at the bottom shows who really did what next to what the logs say.
- **Auto-process routine payments** is a debug bot that settles low-risk NPC payments so a single
  tester is not buried in paperwork. Turn it off for a stricter game. Risky payments are always left
  for humans.
- **Show allegiances** reveals the Black Hats in the player list.

Things worth trying first:

- As a Personal Banker, edit a beneficiary to one of the Target Ledger accounts (see Ground truth),
  then as an Accounts & Receivables player, risk check, approve and settle a payment to it.
- Type a colleague's code into a function you are not entitled to, then read the Master Log as an
  analyst and Trace the entry.
- As an IT Specialist, use `Connect to a host` with `10.66.6.6`, then create yourself a credential
  for the unregistered host.

## Layout

```
src/engine/
  types.ts        data model (plain JSON, Firestore-friendly)
  catalog.ts      systems > modules > functions, roles, default tuning
  setup.ts        createGame: roles, allegiances, credentials, bank data, info packets
  engine.ts       applyAction / tick: auth, scope, offline, encryption, logging, win checks
  handlers.ts     one handler per catalog function
  bank.ts         risk scoring, settlement, reversal, NPC traffic, debug auto-processor
  views.ts        getPlayerView: the only data a given player may see
  engine.test.ts  16 tests
src/sandbox/      UI
docs/RULES.md     rule decisions, assumptions, tuning knobs
```

To add a mechanic: describe it in `catalog.ts`, add a handler in `handlers.ts`, add a test.

## Roadmap

1. Play the sandbox, tune `DEFAULT_CONFIG` in `catalog.ts`.
2. Firebase layer: new Firebase project, anonymous auth, Firestore emulator for dev.
   Data layout: `games/{id}` public state, `games/{id}/players/{uid}` public player info,
   `games/{id}/private/{uid}` allegiance, packets and Personal Node (owner-read only).
   Systems, logs and the hidden host stay server-only; players only see results of their own actions.
   A callable Cloud Function `submitAction` wraps `applyAction`.
3. Lobby (create / join / host / start), then real multiplayer across devices.
4. Deferred until the core is fun: Personal Node hacking, fake or deleted logs, credential spoofing,
   quarantine, neutral players, multiple Black Hat objectives, more roles and departments.
