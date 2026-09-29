# Cyber-Heist

Browser social-deduction game for 6 to 30 players on a video call, each on their own PC. Everyone works
at a bank; a few are secret Black Hats diverting money to mule accounts. Credentials are shared 4-digit
codes, and the logs name the credential's owner rather than the person who typed it. Two racing progress
bars decide the game: the bank's settled payments against the Black Hats' stolen money.

This repo currently contains:

1. **`src/engine/`** the rules engine. Pure TypeScript, no Firebase, no DOM. Every action is
   `applyAction(state, action, now) -> { state, result }`, so the same code will later run inside a
   Cloud Function as the authority.
2. **`src/sandbox/`** a local single-browser UI. One person can play every seat by switching players in
   the yellow bar. Use it to feel the rules before any networking exists.

Firebase, lobby and real multiplayer come next (see "Roadmap").

## Run it

```bash
npm install
npm run dev        # sandbox at http://localhost:5173  (add ?seed=7 to pick a game)
npm test           # engine tests (node:test via tsx)
npm run typecheck
```

## The game in brief

- **Roles** (counts scale with the table): Personal Bankers look after their own customers, act on
  their requests and start payments; Accounts & Receivables score risk, verify account changes and
  settle; IT Specialists run the Firewall, logs and credentials; one Bank Manager oversees everything.
  Each player's profile has a job description with their tools and the rules that matter to them.
- **Black Hats** (a third of the table) have normal jobs as cover, plus a hidden host (`10.66.6.6`) with
  a message board, a list of mule accounts and tool kits. Stronger tools are easier for the bank to
  trace.
- **Money:** every account has a balance. Customers are small, mid-sized or wealthy, and a payment the
  paying account cannot cover fails at settlement. Money moves at once, so a reversal only works while
  the account paid still holds it.
- **Customers wait:** every request has a deadline (2 minutes, 1 if urgent). Customers chase halfway, complain
  to the Bank Manager when a deadline passes, and walk away for the day after a second miss. Obvious
  phishing messages turn up among the requests too.
- **The heist:** a payment lands in the payee's primary account at the moment it settles, so making a
  mule account a customer's primary diverts every payment to them.
- **Time:** 20 minutes, running through a working day (slow morning, lunch rush, busy end of day, close
  of business). New work arrives faster or slower accordingly.
- **Winning:** the Black Hats win the moment they divert their goal. The bank wins at close of business if
  it met its target, or at once if every Black Hat is terminated (all their credentials revoked, or their
  IP revoked) or the unregistered host is shut down. If time runs out with neither goal met, or one of
  the bank's own systems is shut down, everybody loses. The end screen shows both teams, what they made,
  and anyone who embezzled.

Full rules and tuning: [docs/RULES.md](docs/RULES.md).

## Playing the sandbox

- The **yellow bar** at the top is sandbox tooling. Everything below it is the player screen.
- You start as Jeremy, who has **master access** (a whole-system credential for every system).
  Switch seats with **Viewing as**. Each seat keeps its own open windows.
- Set the table size with **players** (6-30) and start a **New game**; the seed makes a game
  repeatable.
- The header shows the time of day, how busy it is, the game clock ("07:42 / 20:00", the same time the
  logs use) and the bank's progress.
- The player screen is an employee sidebar plus a simulated desktop. Click a system to open a
  window, then a module (each tile shows your access to it). Windows can be moved, resized,
  minimized, maximized and navigated with back/forward or the address bar (e.g.
  `10.0.0.30/settlement`).
- A module page has three parts: **Credential** (pick one you hold, or "Manual code" to type any
  code: that is how guessing and using someone else's credential works), **Commands** (cards), and
  the window's **Terminal**, which keeps its history while you stay in one system.
- **My workstation** in the taskbar holds your profile and job description, credentials, activity log
  and messages.
- **The bell** at the right of a page's breadcrumbs switches its notifications on or off (write access
  only). They pop up at the bottom right, above the taskbar, and vanish after 5s or a tap.
- **Ground truth** in the yellow bar shows who really did what next to what the logs say.
- **Auto-process routine payments** is a debug bot that settles low-risk automatic payments so a single
  tester is not buried in paperwork. Turn it off for a stricter game. Risky payments are always left
  for humans.
- **Show allegiances** reveals the Black Hats in the player list.

Things worth trying first:

- As a Personal Banker, add one of the Target Ledger accounts (see Ground truth) to one of your
  customers as their primary account. Then, as Accounts & Receivables, risk check the next payment to
  that customer; approve it as a Personal Banker; settle it as Accounts & Receivables.
- Type a colleague's code into a function you are not entitled to, then read the Master Log as an IT
  Specialist or the Bank Manager and **Trace** the entry.
- As a Black Hat, open the unregistered host and try a kit tool. Watch the Master Log's alerts, then
  trace the entry the alert points at.

## Layout

```
src/engine/
  types.ts        data model (plain JSON, Firestore-friendly)
  catalog.ts      systems > modules > functions, roles and their credentials, player-count formulas, tuning
  setup.ts        createGame: roles, allegiances, credentials, customers, scaled targets and rates
  engine.ts       applyAction / tick: auth, scope, offline, blocks, logging, arrivals
  ending.ts       terminations, end conditions and the end-screen summary
  handlers.ts     one handler per catalog function (incl. the Black Hat tools and their exposure)
  bank.ts         risk scoring, settlement, reversal, automatic payments, debug auto-processor
  requests.ts     client requests and banker assignment
  notify.ts       the page bells: who gets a pop-up notification about what
  pacing.ts       time of day and how fast new work arrives
  jobs.ts         job descriptions shown in each profile
  views.ts        getPlayerView: the only data a given player may see
  engine.test.ts  tests
src/sandbox/      UI
docs/RULES.md     the rules as implemented, assumptions, tuning knobs
docs/BACKLOG.md   agreed work not built yet, deferred and rejected ideas
```

To add a mechanic: describe it in `catalog.ts`, add a handler in `handlers.ts`, add a test, and update
`docs/RULES.md`.

## Roadmap

1. Play the sandbox, tune `DEFAULT_CONFIG` in `catalog.ts` and the pacing in `pacing.ts`.
2. Firebase layer: new Firebase project, anonymous auth, Firestore emulator for dev.
   Data layout: `games/{id}` public state, `games/{id}/players/{uid}` public player info,
   `games/{id}/private/{uid}` allegiance and other owner-only data.
   Systems, logs and the hidden host stay server-only; players only see results of their own actions.
   A callable Cloud Function `submitAction` wraps `applyAction`.
3. Lobby (create / join / host / start), then real multiplayer across devices.
4. Game features agreed but not built yet, and the deferred list: see [docs/BACKLOG.md](docs/BACKLOG.md).
