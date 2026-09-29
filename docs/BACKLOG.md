# Backlog

Agreed or discussed work that is not built yet. Rules as they stand today are in [RULES.md](RULES.md).
Move an item out of here when it ships.

## Bank and customers

- **"We never asked for this."** When a scam request is acted on, the real customer could write back
  confused. Discussed, not agreed.
- **Customer senders and spoofing.** Customers now write personal messages ("Cody (Cobalt Payroll)"), so
  a Social / Spoofed message posing as a customer looks normal, and a made-up sender name is no longer
  an easy tell. Watch in playtests; the spoof tool may want a customer-sender option.
- **Scam client requests.** Some incoming requests are fraud, e.g. a fake "our supplier changed banks,
  make account X their primary", like real business email compromise. Needs customers to have a known
  contact to verify against.

## Security

- **Server module** (a separate Security module, not part of the Firewall). Access: IT Specialist
  (write), Bank Manager (probably read, like the Firewall).
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
    kinds: set primary / add & primary / add / remove). No free text: it is worded from the same form messages as
    real requests (the operative sees the wording). Looks like a normal request in the queue and adds
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

- **Planted users and IPs.** Infiltration / Create user accepts an IP already used by a real
  workstation; lookups by IP then pick one arbitrarily. Decide whether to reject used IPs or keep it as a
  framing trick.
- **Role balance to watch in playtests.** Roles were replaced 2026-09-29 (see RULES.md > Roles). Things
  to check: only IT Specialists hold Firewall write, so only they can start "revoke all access"
  (the nuclear option), and at 6-7 players there is just one; Personal Bankers now hold both Customer Records write and Payment Queue write,
  so one banker can divert a customer and start payments to them (verification and risk sit with other
  roles); Employee Records write (reset a lockout) is IT-only.
- **Economy balance** (retuned for balances 2026-09-29, numbers are a first guess). Targets ($15M per
  player, $1M per Black Hat), volume (automatic capped at 80% of the target, about 1.1x offered in total)
  and request rate (one per banker every 90s) all scale with the table; see RULES.md > Win conditions.
  To check in playtests:
  - automatic traffic alone is below the bank target at every size, so the bank must act on requests to
    win: is the request workload right? The margin is now tight (about 1.1x offered).
  - wealth tiers ($250k-$2M / $5M-$15M / $30M-$60M) and the 40%-of-balance cap on payment sizes: small
    customers mostly make small payments, so their requests are worth less to the bank;
  - the amount factors in `scaledConfig` (0.87 automatic, 0.45 requested) were measured by simulation;
    re-measure if payment sizing or tiers change;
  - the hacker target grows with Black Hats, but their chances per payment do not change;
  - the 20-minute timer is new (was 40);
  - time-of-day pacing (busy = 4x slow) is a first guess, and automatic payments follow it too; the
    in-game clock (08:30 upward, used in logs) no longer shows in the header and does not match the
    time-of-day names.
  The 30-player cap keeps workstation IPs (10.1.0.11 upward) well inside one subnet; raising it past
  ~244 would need a new IP scheme. Raising it past 30 also needs more than 42 customer names.
- **Timer.** At the end of the clock the Black Hats win by default. With the nuclear option, a losing
  White Hat side may prefer to shut the bank down; check in playtests.

## Deferred (from the original design)

Personal Node hacking, credential spoofing, quarantine, neutral players, multiple Black Hat objectives,
more roles and departments, function- or system-level encryption (encryption layers are switched off).

## Rejected

- Forwarding Client Requests between bankers; "mark as read" on requests.
- A "reset everything" button that undoes revocations (they stay permanent).
- Dropdowns or quick-fill buttons for game data (beneficiaries, amounts): players look things up and type.
