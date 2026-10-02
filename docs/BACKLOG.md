# Backlog

Agreed or discussed work that is not built yet. Rules as they stand today are in [RULES.md](RULES.md).
Move an item out of here when it ships. Firebase, the lobby and real multiplayer are on the README roadmap.

## Bot mode

- **Bot mode and single player** (co-op stealth: every Thief human, every regular employee a bot, with
  difficulty levels; single player is 1 human + 5 bots). In progress: bots that do their jobs and catch the primary swap (steps 2-3) run the solo Thief
  test; the rest of the symptom table is next. The spec, symptom table and build phases are in [BotMode.md](BotMode.md).
- **Bots that wait for a trace.** A human's trace now takes `traceDelaySec` (10s) and lands later; a bot's is
  still instant (handlers.ts TRACE: `c.actor.bot`), keeping the engine busy for the trace time plus the
  cooldown so its rhythm is unchanged. Bots should start a trace, remember it, and read the answer when it
  lands (from their own view's `kitJobs`), like a human. The same goes for any other timed tool a bot uses,
  including the timed Security writes (engine.ts `SECURITY_DELAY`: a bot's are instant for now, `p.bot`).

## Loose ends in shipped features

- **Remove the watcher link before any public release** (dev only: `?watch=`, host.ts `publishWatch`, the
  `watch` database rule, the host screen's Dev tools link).

- **Online play follow-ups.** Not built yet: a player cannot leave a running game; the host cannot also
  play; a player who closes the tab while waiting in the lobby stays listed. Rooms made before the
  automatic cleanup (a room index, 2026-09-29) have to be deleted by hand in the Firebase console.

- **Switched off: credential sharing and the Credential Cache** (`CREDENTIAL_SHARING_ENABLED`,
  `CREDENTIAL_CACHE_ENABLED` in catalog.ts; the code remains). They were not working well: the Share
  action, keeping a credential after typing its code, and the host module listing regular employee credentials
  held by operatives. Fix or delete.

- **Removing planted users.** Infiltration / Create user plants a fake employee, but there is no way to
  remove one: regular employees can only revoke its credentials (which terminates it once it has any).

- **Console follow-ups.** Not in the first version: live monitors (Master Log, Blacknet) that refresh in
  the console; `load` on a workstation or proxy address (it says "not a system"); tab completion of command
  names. Engine messages that say "watch its progress here" read oddly in the console.

## Bank and customers

- **Spoofing a customer.** Customers write personal messages ("Cody (Cobalt Payroll)"), so Social /
  Spoofed message could get a customer-sender option. Watch in playtests first.
- **"We never asked for this."** When a scam request is acted on, the real customer could write back
  confused. Discussed, not agreed.

## Security

- **Server module** (a separate Security module, not part of the Firewall). Access: IT Specialist
  (write), Bank Manager (probably read, like the Firewall).
  - **Network reboot**: every bank system goes offline for about 30s, then comes back with defaults
    (all modules online, security on, temporary blocks cleared). Does not undo revocations or any data
    (accounts, credentials). Logged, with a short countdown that can be cancelled, like "revoke all
    access". Build only if cleaning up after sabotage feels tedious rather than tense in playtests.
  - **Server status** and anything else: to be fleshed out if needed.

## Thief tools

- **Add a delay and a progress gauge to the other Thief tools**, like Code crack and Unlock workstation
  (a progress bar in the tool card, its button disabled while it runs, the result printed in the terminal
  when it ends). Which tools, and how long each takes: to decide.

## Playtest watch list

Built, but the numbers or the balance are a first guess.

- **Roles.** Personal Bankers hold both Customer Records write and Payment Queue
  write, so one banker can divert a customer and start payments to them (verification and risk sit with
  other roles). Employee Records write (reset a lockout) is IT-only.
- **Economy** (see RULES.md > Win conditions). Targets ($15M per player, $1M per Thief), volume
  (automatic capped at 80% of the target, about 1.15-1.2x offered in total) and request rate (one per banker
  every 90s) scale with the table. Automatic payments are many and small ($165k-$1.32M), requests fewer
  and big (x2.18). To check:
  - the bank must act on requests to win: is the request workload right with a ~1.15x margin?
  - payment automation defaults ($1M scoring and settlement, approve LOW): how much work is left for people?
  - small customers going broke: a request can take up to ~87% of an account, and money drifts to the
    wealthy. If too many customers can only ask to add accounts, raise the small tier (e.g. $0.5M-$3M);
  - the Master Log gets a "Batch processor queued" line per automatic payment (~120 a game at 10 players):
    good cover for the Thieves, or just noise?
  - the amount factors in `scaledConfig` (0.94 automatic, 0.39 requested) were measured by simulation;
    re-measure if payment sizing or tiers change;
  - the Thieves' target grows with their number, but their chances per payment do not;
  - the 20-minute timer (was 40), and time-of-day pacing (busy = 4x slow).
- **Endings.** Every ending goes to the Thieves if their goal is met when it fires; meeting it never
  ends the game by itself, so a secured team either holds on to close of business or quits (every Thief
  out ends it at once). Otherwise, at close of business the bank wins if it met its target and both sides
  lose if not, so Thieves short of their goal may prefer to stall the bank rather than steal. Every Thief
  out, or revoking the unregistered host, wins at once for the bank; a wrong IP revocation permanently
  removes a regular employee. Regular employees who are losing may prefer to shut the bank down. Watch:
  whether this is too swingy; whether secured Thieves quitting (one by one, each goodbye exposing them)
  feels good or rushed; whether anyone finds the bank-shutdown easter egg.
- **Limits.** Workstation IPs are random in 10.1.0.2-254, so the subnet is not the limit any more; past
  30 players the game needs more than 42 customer names.
- **Workstation logins.** A W login can never be revoked, so once it is shared or read off a workstation
  that access is permanent. Watch whether that feels unfair; a "change your login" action would fix it.
  Unlock workstation (tier 3, 30s, stopped by a block on either end) is a first guess.

## Visual polish (maybes)

Suggested, not agreed. Pick up if a playtest shows the need.

- **Result flash:** new terminal lines flash briefly, green for OK and red for FAILED, so a mistake is
  noticed even when the terminal is busy.
- **Taskbar attention:** a minimized or background window's taskbar button pulses when its bell rings.
- **Hidden host styling:** faint scanlines or a flicker when an unregistered host window opens.
- **Alerts that land:** a tier 3-4 alert flashes the Master Log window (or its taskbar button) red.

## Deferred (from the original design)

Personal Node hacking, credential spoofing, quarantine, neutral players, multiple Thief objectives,
more roles and departments, function- or system-level encryption (encryption layers are switched off).

## Rejected

- Forwarding Client Requests between bankers; "mark as read" on requests.
- A "reset everything" button that undoes revocations (they stay permanent).
- Dropdowns or quick-fill buttons for game data (beneficiaries, amounts): players look things up and type.
