# Backlog

Agreed or discussed work that is not built yet. Rules as they stand today are in [RULES.md](RULES.md).
Move an item out of here when it ships.

## Bank and customers

- **Customer balances.** Balances per account; settling a payment debits the originator account it was
  paid from (`originAccount` / `debitedFrom`); a payment fails if funds are short. Opens up draining a
  specific customer, or an "unusual originator" risk signal.
- **Client needs and reminders.** Customers have needs; unmet requests send reminders and escalate;
  fulfilled or ignored requests may feed the bank's progress bar. Requests already keep the asked-for
  details (payee, amount, account) hidden, so a payment linked to a request can be checked against it.
- **Scam client requests.** Some incoming requests are fraud, e.g. a fake "our supplier changed banks,
  make account X their primary", like real business email compromise. Needs customers to have a known
  contact to verify against.

## Security

- **Server module** (a separate Security module, not part of the Firewall). Access: IT Specialist,
  Security Analyst, Systems Administrator.
  - **Network reboot**: every bank system goes offline for about 30s, then comes back with defaults
    (all modules online, security on, temporary blocks cleared). Does not undo revocations or any data
    (accounts, credentials). Logged, with a short countdown that can be cancelled, like "revoke all
    access". Build only if cleaning up after sabotage feels tedious rather than tense in playtests.
  - **Server status** and anything else: to be fleshed out if needed.
- **Alert / notification system (phase 2).** Broadcasts to players (e.g. a revocation countdown, a
  module switched to open access). Today these only appear in the Master Log and Firewall status.

## Black Hats

Agreed 2026-09-28. The Black Hat tool list itself is kept by the designer and not written up here.

- **Tools for the kits.** The kits exist (Infiltration, Social, Cleanup, Access; see RULES.md). Each tool
  is a function in a kit module plus a handler, like the rest of the game. Shipped so far:
  - _Infiltration / Reroute IP_ — for 10/30/60s all your activity appears from a typed IP (Master Log
    source IPs, Traces, and Employee Records "last activity" all follow it); routing stays on your real
    workstation. Duration sets the exposure tier (10s→2, 30s→3, 60s→4).
  - _Infiltration / Create user_ — plant a fake employee (typed name, one of the 5 roles, typed IP). It
    becomes a real `Player` (flagged `fake`, poses as White staff), shows in Employee Records and the
    Permissions "issue to" list, and can be issued credentials. Instant tool, fixed exposure tier 2.
    Not a sandbox seat. No way to remove a planted user yet (White Hats can only revoke its credentials).

  - _Social / Spoofed message_ — a private message that appears from another employee (typed To / from /
    text). Lands only in the recipient's inbox, never the impersonated sender's history, so comparing
    notes exposes it; made-up names render as typed (not in the roster, so easier to spot). Tier 2.
  - _Social / Scam request_ — plant a fake Client Request from a customer to their banker (account-redirect
    kinds: set primary / add & primary / add / remove). Looks like a normal request in the queue and adds
    the usual "Client request received" system log; the leak is the hidden-host tier-2 alert. Payment-type
    scam requests (payee + amount) are an easy follow-up if wanted.
  - _Cleanup / Log wiper_ (tier 2) — delete one Master Log entry. It drops out of the log view leaving a
    visible id gap (looks like an offline gap), but stays in `s.logs` flagged `deleted`, so a Trace still
    reaches it until it ages out.
  - _Cleanup / Alert mute_ (tier 3) — suppress the bank's alerts for 10s. Alerts now carry a `tier` (1-4);
    while `s.alertMuteUntil` is in the future, tier 1-2 alerts are dropped at creation. Tier 3-4 (exact-IP
    and host-code exposures, encryption bypass) and the mute's own tier-3 alert always get through, so a
    mute can't cancel the loud end of the exposure system.
  - _Access / Code crack_ (tier 2) — pick a module; a background process (`s.cracks`, advanced from the
    engine's time loop) recovers one digit of a random covering credential every ~15s (~1 min for all
    four). Each reveal leaves a tier-2 "Unknown server activity" entry and a `CODE_CRACK` alert pointing
    at it (credential + owner + progress, no source clue); the operative sees the code assemble in their activity log and learns the credential on
    completion. Aborts if the credential is revoked or the operative's workstation is blocked.
  - _Access / Lockout bomb_ (tier 2) — spoof `lockoutAfterFails` failed logins pinned on the target's own
    IP so their anti-brute-force lockout trips (`lockoutSec`). Counter: reset the lockout in Employee
    Records. Pure disruption.

  All four kits (Infiltration, Social, Cleanup, Access) now have tools.
- **Balance by exposure, not limits.** No cooldowns and no limited charges. Instead, stronger Black Hat
  actions leak more about the operative who acted. The alert itself names nothing; the leak is in the
  **trace** of the action's "Unknown server activity" entry, which escalates with the tier. Implemented as
  `raiseExposure(c, tier)` in handlers.ts (tags the entry with `exposure`) — reuse it for every new kit tool:
  - tier 1: no alert; a trace of the entry gives one vague clue (range of four IPs, real + decoy pair,
    one number of the server's address, or what was done);
  - tier 2: "Suspicious server activity" alert linking to the entry; its trace gives one vague clue;
  - tier 3: "Intrusion alert" linking to the entry; its trace gives one exact fact, picked at random —
    the operative's workstation IP or the server's address;
  - tier 4: "Critical breach" alert linking to the entry; its trace gives the operative's exact IP and a
    working host credential code (their own).
  Tier 2+ traces are always about the real operative, never a rerouted IP (tier 1 follows the recorded
  source, so a reroute fools it). Each trace re-rolls its clue. Tools with a duration pick their tier by
  the duration chosen.
- **Host Log alerts for exposure.** Done: every tier 2+ alert also writes an alerting Host Log entry naming
  the log entry and what a trace of it would give away, so operatives can react (e.g. wipe it) first.

## Roles and balance

- **Roles and permissions review** (do this before writing job descriptions). Candidate new role:
  **Bank Manager**, not designed yet. Temporary choices to revisit:
  - IT Specialists hold a read-only credential for all of Client Data (so they can view every customer).
  - Only Accounts & Receivables can create payments, so bankers need someone else to carry out
    payment requests.
  - Personal Bankers hold the heist-critical Customer Records write (scoped to their own customers).
  - Anyone with Firewall write can start a "revoke all access" (the nuclear option); only the Systems
    Administrator starts with it.
- **Timer.** At the end of the clock the Black Hats win by default. With the nuclear option, a losing
  White Hat side may prefer to shut the bank down; check in playtests.

## Under consideration

- **Remove info packets** (the private facts dealt to each player at the start, shown in My workstation >
  Profile). Not decided yet. Today they are the main source of:
  - the hidden host's address (two Security facts give it in full) and the digits of one operative's
    host code;
  - two customers' original primary accounts and two mule (target) accounts;
  - one operative's workstation IP and the number of operatives;
  - rules hints (trace limits, lockouts, verification, risk scoring).

  Without them, the address comes only from trace clues and players; host codes only from guessing,
  sharing or a Black Hat's workstation. Some rules hints may need another home (e.g. a help page).
- **Job descriptions** (proposed replacement for info packets; wait for the roles and permissions review): each role gets a job description in
  My workstation (a "Job" tab): what you do, your tools (the modules you have access to), who you depend
  on (e.g. bankers need Accounts & Receivables to create payments), and the rules that matter for your
  job. Black Hats get a separate secret section (objective, hidden host address, how to act unseen); it
  lives on their workstation, so a White Hat who logs in to it can find it. General rules ("logs name
  the credential owner") could go in a short shared "How the bank works" section.

## Deferred (from the original design)

Personal Node hacking, credential spoofing, quarantine, neutral players, multiple Black Hat objectives,
more roles and departments, function- or system-level encryption (encryption layers are switched off).

## Rejected

- Forwarding Client Requests between bankers; "mark as read" on requests.
- A "reset everything" button that undoes revocations (they stay permanent).
- Dropdowns or quick-fill buttons for game data (beneficiaries, amounts): players look things up and type.
