# Backlog

Agreed or discussed work that is not built yet. Rules as they stand today are in [RULES.md](RULES.md).
Move an item out of here when it ships. Firebase, the lobby and real multiplayer are on the README roadmap.

## Loose ends in shipped features

- **Removing planted users.** Infiltration / Create user plants a fake employee, but there is no way to
  remove one: White Hats can only revoke its credentials (which terminates it once it has any).

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

## Playtest watch list

Built, but the numbers or the balance are a first guess.

- **Roles.** Only IT Specialists hold Firewall write, so only they can revoke an IP or a system, and at
  6-7 players there is just one. Personal Bankers hold both Customer Records write and Payment Queue
  write, so one banker can divert a customer and start payments to them (verification and risk sit with
  other roles). Employee Records write (reset a lockout) is IT-only.
- **Economy** (see RULES.md > Win conditions). Targets ($15M per player, $1M per Black Hat), volume
  (automatic capped at 80% of the target, about 1.1x offered in total) and request rate (one per banker
  every 90s) scale with the table. To check:
  - the bank must act on requests to win: is the request workload right with a 1.1x margin?
  - wealth tiers ($250k-$2M / $5M-$15M / $30M-$60M) and the 40%-of-balance cap on payment sizes: small
    customers' requests are worth little to the bank;
  - the amount factors in `scaledConfig` (0.87 automatic, 0.45 requested) were measured by simulation;
    re-measure if payment sizing or tiers change;
  - the hacker target grows with Black Hats, but their chances per payment do not;
  - the 20-minute timer (was 40), and time-of-day pacing (busy = 4x slow).
- **Endings.** At close of business the bank wins if it met its target; otherwise both sides lose, so
  Black Hats short of their goal may prefer to stall the bank rather than steal. Terminating every Black
  Hat, or revoking the unregistered host, wins at once for the White Hats; a wrong IP revocation
  permanently removes a White Hat. A losing White Hat side may prefer to shut the bank down. Watch whether
  any of this is too swingy.
- **Limits.** The 30-player cap keeps workstation IPs (10.1.0.11 upward) inside one subnet; past 30 also
  needs more than 42 customer names.

## Deferred (from the original design)

Personal Node hacking, credential spoofing, quarantine, neutral players, multiple Black Hat objectives,
more roles and departments, function- or system-level encryption (encryption layers are switched off).

## Rejected

- Forwarding Client Requests between bankers; "mark as read" on requests.
- A "reset everything" button that undoes revocations (they stay permanent).
- Dropdowns or quick-fill buttons for game data (beneficiaries, amounts): players look things up and type.
