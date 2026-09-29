# Cyber-Heist

Browser social-deduction game for 6 to 30 players on a video call, each on their own PC. Everyone works
at a bank; a few are secret Black Hats diverting money to mule accounts. Credentials are shared 4-digit
codes, and the logs name the credential's owner rather than the person who typed it. Two racing progress
bars decide the game: the bank's settled payments against the Black Hats' stolen money.

This repo contains:

1. **`src/engine/`** the rules engine. Pure TypeScript, no Firebase, no DOM. Every action is
   `applyAction(state, action, now) -> { state, result }`.
2. **`src/sandbox/`** the game screen, and the sandbox around it: one person can play every seat by
   switching players in the yellow bar.
3. **`src/net/`** and **`src/play/`** online play over Firebase Realtime Database: a lobby, a host screen
   that runs the game, and each player's screen.

## Run it

```bash
npm install
npm run dev        # http://localhost:5173: start page (join, host, sandboxes); ?seed=7 opens the offline sandbox
npm test           # engine and network tests (node:test via tsx)
npm run typecheck
npm run deploy     # build and deploy to Firebase Hosting, with the database rules
```

## Online play

The host's browser runs the game: it holds the whole game, applies every player's actions and sends
each player only their own view (through Firebase Realtime Database). So the host is a facilitator who
does not play, and must keep their tab open until the end (a reload picks up where it left off).

- **Host a game**: the start page's "Open a room" gives a four-letter code. Players open the start page,
  type the code and their name, and wait in the lobby. The host starts once 6 or more are in; roles and
  sides are dealt at random. The host screen shows the clock, the bank's progress, a Pause button, and the
  end screen. A player who reloads comes back to their seat.
- **Online sandbox**: the start page's "Online sandbox", or "Go online" in the offline sandbox's yellow
  bar. It is the sandbox (every seat, speed, ground truth) plus a room: "Open a tester screen" opens a
  screen that plays one seat through the network, with its own seat picker.
- **Offline sandbox**: `?sandbox` or `?seed=7`. No network at all.

**Local mode.** Without a Firebase config (or with `&net=local` in the address), online play runs on a
stand-in that shares games between the tabs of one browser. Good for trying the flow; useless across
devices.

**Setting up Firebase** (once):

1. Create a project in the [Firebase console](https://console.firebase.google.com/). The free Spark plan
   is enough: there are no Cloud Functions.
2. Build > Authentication > Get started > enable **Anonymous**.
3. Build > Realtime Database > Create database (any region, start in locked mode).
4. Project settings > General > Your apps > add a **Web** app. Copy `.env.example` to `.env.local` and
   fill it in from the app's config (the database URL is on the Realtime Database page).
5. `npx firebase-tools login`, then `npx firebase-tools use --add` and pick the project.
6. `npm run deploy:rules` puts the security rules in place (`database.rules.json`: each player can read
   only their own view; only the host reads the actions and the full game). `npm run deploy` also
   publishes the site on Firebase Hosting, so players can join from anywhere.

## The game in brief

- **Roles** (counts scale with the table): Personal Bankers look after their own customers, act on
  their requests and start payments; Accounts & Receivables score risk, verify account changes and
  settle; IT Specialists run the Firewall, logs and credentials; one Bank Manager oversees everything.
  Each player's profile has a job description with their tools and the rules that matter to them.
- **Black Hats** (a third of the table) have normal jobs as cover, plus a hidden host (its address changes every game) with
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
src/sandbox/
  main.ts         the game screen (offline sandbox, online sandbox host, or one remote seat: see mode.ts)
src/net/
  db.ts           the database interface, and its local stand-in (tests, local mode)
  firebaseDb.ts   the same over Firebase Realtime Database (anonymous auth)
  protocol.ts     the data layout under games/{code}, views in parts, action checks
  host.ts         HostSession: applies players' actions, publishes each player's view, saves the game
  client.ts       ClientSession: follows your seat and view, sends actions and waits for the answer
  room.ts         create, join, start
src/play/pages.ts start page, player lobby, the host (facilitator) screen
src/app.ts        entry point: picks the page from the address
database.rules.json   Firebase security rules
docs/RULES.md     the rules as implemented, assumptions, tuning knobs
docs/BACKLOG.md   agreed work not built yet, deferred and rejected ideas
```

To add a mechanic: describe it in `catalog.ts`, add a handler in `handlers.ts`, add a test, and update
`docs/RULES.md`.

## Roadmap

1. Play the sandbox, tune `DEFAULT_CONFIG` in `catalog.ts` and the pacing in `pacing.ts`.
2. Online play: built (see "Online play"). Next: a real playtest across devices.
3. Game features agreed but not built yet, and the deferred list: see [docs/BACKLOG.md](docs/BACKLOG.md).
