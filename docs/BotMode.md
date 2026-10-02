# Bot Mode (design spec, not built)

A co-op stealth game: human Thieves against a bank staffed entirely by bots. Status: agreed design
direction, nothing built. Numbers marked *tune* are first guesses for playtesting. The rules of the
normal game ([RULES.md](RULES.md)) apply unless this spec changes them.

## Design goals

1. **Co-op stealth, not social deduction.** The humans are a crew working together, usually talking
   freely on a call. The bots are the guards. Lean into the genre: readable guards, detection building
   up in visible steps, getting away with it versus getting caught.
2. **Every Thief is human and every regular employee is a bot.** No exceptions.
3. **Every human also holds a bank job and is expected to do it.** Neglecting it is evidence. Keeping
   cover versus pursuing the heist is the core tension.
4. **Bots catch humans only through evidence.** Everyone knows which seats are human, the bots
   included. The bots must act as if they don't: suspicion comes only from what the game shows a player
   in that seat (logs, alerts, traces, queues, customer complaints, job performance). A bot never reads
   ground truth.
5. **Bots are openly bots.** They don't pretend to be human. Their names, personalities and tells are
   shown.
6. **Difficulty is a first-class setting.** At the top level, the bots should be a real threat to a
   skilled crew.

## Table size

- **Total seats = max(`MIN_PLAYERS`, 3 × humans)**, and **Thieves = humans exactly**. The normal formula
  (`thiefCountFor(n) = floor(n/3)`) would give 2 Thief seats at 6 players with only one human, so bot
  mode overrides the Thief count.
- Roles are dealt with the normal `roleCounts`. The existing rule "every role other than the Bank Manager
  keeps at least one regular employee" (with the 6-player IT/Manager group) still holds, so every role has
  at least one bot.
- The cap of 30 seats means at most 10 humans.

| Humans | Seats | Bots |
|---|---|---|
| 1 | 6 | 5 |
| 2 | 6 | 4 |
| 3 | 9 | 6 |
| 4 | 12 | 8 |
| 10 | 30 | 20 |

### Single-player mode

To be supported: **1 human Thief + 5 bots** (6 seats, the minimum table). It is the natural successor to
the SOLO test scenario, which becomes the debug harness for bot mode.

Decided for now (to refine later): the **Thief goal is $2M** (the 6-seat goal, as in SOLO) and the
human gets **all four kits**.

Open question for bot mode with more humans: how kits are dealt. Proposal: the crew covers all four between
them (2 humans: two each; 3 or more: at least one each, every kit dealt at least once).

## Architecture

Every bot runs the same loop on the host, inside the engine's tick (like `runAutopilot` today):

1. **Perceive**: read what the seat can see.
2. **Update evidence**: turn observations into evidence items and suspicion scores.
3. **Choose**: score candidate actions (job tasks, investigation, enforcement, chatter, slacking),
   weighted by personality and difficulty.
4. **Act**: with a reaction delay and possible errors, through the same `EXECUTE` actions as a player,
   using codes the bot holds.

### Rules the architecture must keep

- **No ground truth.** Bots never read raw `GameState` for a decision (bots.test.ts greps bots.ts for it). Perception goes through a function that returns, as structured data, exactly
  what the seat's view commands would show its credentials. A test checks that perception never shows
  more than the matching view command.
- **Looking costs something.** A bot only knows a page's contents after executing its view: a logged
  read, as with people. Attention is limited (see Stats), so a bot watching Verification is not watching
  Settlement. Bells count as attention, as they do for players.
- **The one thing a bot knows that the view doesn't show: its own actions.** A bot remembers what it
  did. An entry in its name that it didn't make proves its code was used by someone else, just as it
  would for a person.
- **Deterministic.** Bot memory lives in `GameState` (for example `s.bots[pid]`), and every random choice
  uses the seeded RNG. Replays, Download state and the online host snapshot keep working.
- **Pure engine.** No new I/O. Online play needs nothing new: bots are seats the host's engine plays.

## Evidence and suspicion

Each bot keeps its own **evidence list**. Scores are worked out from the list, never stored on their own.

- **Evidence item:** subjects, weight, source (what the bot saw), time, and whether the bot has acted
  on it.
- **Subjects:**
  - employees (bots included, since they can be framed);
  - workstation IPs, and any unknown IP that turns up;
  - credentials (codes);
  - accounts;
  - customers;
  - requests;
  - transactions;
  - the hidden host address (known octets).
- **Suspicion spreads along links**, at a fraction of the weight:
  - a transaction to the credential that created or approved it, then to that credential's owner;
  - an account change to its credential, then to the owner, and to the account;
  - an account to every customer it sits on and every payment into it;
  - a trace result to the workstation IP, then to the employee at that IP. This overrides attribution:
    a trace is stronger than the name in a log.
- **Score** for a subject = sum of (weight × paranoia × decay(age)). Decay is set by the memory stat.
  Evidence the bot has disproved (for example a trace clearing the named owner) is cancelled, not
  decayed.
- **Thresholds**, set by decisiveness, turn score into behaviour (see Escalation).
- **Sharing.** Bots share evidence only through messages (see Telegraphing), never through shared
  memory. A bot that receives a report adds it as evidence weighted by its trust in the sender.

### Escalation (the guard's alert states)

| State | Trigger (score vs thresholds) | Behaviour |
|---|---|---|
| Calm | below *notice* | Does the job |
| Curious | ≥ *notice* | Looks closer: opens the relevant page, investigates the account or change, may ask the subject about it |
| Suspicious | ≥ *report* | Reports to IT or the Manager with the evidence; undoes what it can within its own job (holds the payment, doesn't verify the change, reverts a primary on its own customer) |
| Alarmed | ≥ *act* | Holders of the power act: IT traces and blocks, Permissions revokes the code, the Manager or IT starts "revoke all access" on an IP or the host |

Every transition is telegraphed (next section) except where the difficulty says otherwise.

## Telegraphing (bot chatter)

Stealth games need readable guards. Bots announce changes of state as **private messages**, which are
already in the game.

- **To the subject**, at lower difficulties: "Hey Sam, did you change CU4's primary account?" A direct
  warning that a guard is curious.
- **To IT or the Manager** (reports): "CH-12 changed CU4's primary with no request. Made with Sam's
  code. Can you trace L-212?" Humans can read these only by breaking into that bot's workstation
  (Access / Unlock workstation), which is reading the guards' radio.
- **On acting**: "Revoking C14: someone else is using it." Lets the crew see consequences.
- Bots also post routine job chatter at a low rate so that reports don't stand out by existing.

Reports are **structured**: generated from templates, and parsed by other bots from a tag, not from free
text. Consequence: **Social / Spoofed message can fake a bot report** ("IT, ignore L-212, that was me").
That is a legitimate and fun attack. Bots weigh a report by their trust in the claimed sender, and a
thorough bot cross-checks a report against its own evidence.

## Bot stats

Each bot has a personality: a stat block drawn at game start around the difficulty level's means, plus
an archetype label shown on its profile ("By the book", "Paranoid", "Coasting", "Ambitious"...).

### Job competency

| Stat | Meaning |
|---|---|
| Action rate | Actions per minute it can take at most |
| Reaction delay | Seconds before responding to something new (a bell, a request, an alert) |
| Accuracy | Chance a typed value is right. Mistakes are real mistakes (wrong account, wrong amount) and produce real anomalies: noise the crew can hide in |
| Thoroughness | Share of optional checks it performs: cross-checking a request against Customer Records, investigating an account's history before verifying, re-reading a payment's originator |

### Detective work

| Stat | Meaning |
|---|---|
| Paranoia | Multiplier on evidence weight. Noticing |
| Decisiveness | How low the escalation thresholds are. Acting. Split from paranoia on purpose: a paranoid, indecisive bot complains loudly and never acts |
| Memory | Half-life of evidence |
| Vigilance | How many pages it keeps an eye on at once (bells on, periodic looks) |
| Gullibility | Chance it believes something that looks plausible: a scam request, a spoofed message, a phishing message. Separate from accuracy |

### Dedication

| Stat | Meaning |
|---|---|
| Slack rate | Share of time it is idle |
| Exploration | Chance to look at pages outside its job (Master Log, Employee Records, other bankers' customers) |
| Ambition | Wants more access. It asks the Manager or IT for a credential, which creates openings: new codes in play, Permissions activity to hide in |

### Social

| Stat | Meaning |
|---|---|
| Trust | Weight given to colleagues' reports and requests, per colleague; drops with suspicion of that colleague |
| Chattiness | How often it telegraphs; at 0, it acts without warning |

## What bots act on: job, permissions, suspicion, attention

Candidate actions come from four sources:

1. **Job**: the role's normal work (the table below).
2. **Permissions**: what its credentials allow. A bot issued Settlement access starts settling, and a
   bot that loses a credential stops.
3. **Suspicion**: investigation, reporting and enforcement, gated by escalation state.
4. **Attention**: what it is currently looking at. A task on a page it isn't watching waits until the
   bot looks.

### Each role's job as a bot

| Role | Job | Investigation and enforcement it can do |
|---|---|---|
| Personal Banker | Read requests; act on them (payments, account changes); archive phishing; approve payments in Authorization; answer reminders | Cross-check a request against the customer's file; refuse or hold a suspicious payment; revert an unrequested change on its own customers; report |
| Accounts & Receivables | Score risk; verify account changes; settle; run reversals | Refuse to verify an unrequested change or one to a floating, newly appeared or mule-like account; hold HIGH; reverse a payment into a suspect account within 3 minutes |
| IT Specialist | Watch Employee Records and the Master Log; reset lockouts | Trace; block an IP; revoke credentials; reissue credentials to bots whose codes leaked; Connect to the host once its address is known; "revoke all access" on an IP or the host |
| Bank Manager | Read complaints and reports; verify changes; settle | Revoke credentials; reassign trust; order or perform "revoke all access" (holds Master Log and Permissions write; Firewall write at 6 seats) |

Reading requests: a payment request usually gives the payee's tag ("Keystone Plumbing (CU7)", 75%, always
on a banker's first request, which also gives the paying account's number); otherwise the payee is looked
up by name in Customer Records. Every customer field accepts a tag or an exact name, so a bot can also type
the name as written. The tutorial checklists and the heist panel are for people: bots ignore them, and a bot
seat gets no tutorial-failure alert worth acting on beyond what any alert means.

## The symptom table

Bots react to **symptoms**, never to attacks: they don't know which attack happened, only what they can
see. Each row lists what a Thief action leaves behind, who can see it, and what bots do about it. A new
kit tool only needs its symptoms mapped, and many tools share symptoms.

Every row assumes the normal escalation: evidence → curious → report → act.

### Using bank access (own or stolen codes)

| # | Thief action | Symptoms left | Seen by | Bot response |
|---|---|---|---|---|
| B1 | **Primary swap** to a mule (Set primary, Add as primary) | Account change with no request id in Verification; the account was floating or new; `!! UNVERIFIED` on payments to that customer in Risk Check; Target Ledger bell (Thieves only) | A&R and Manager (Verification), the customer's banker (Customer Records bell), Risk Check | Don't verify; investigate the account (floating? where was it?); the customer's banker reverts the primary if it's their customer; hold unverified payments to that customer; ask IT to trace the change's log entry (it gives the exact workstation). Strong evidence on the code's owner |
| B2 | **Remove an account** so it floats with its money | Unrequested removal in Verification; automatic payments now show `UNKNOWN ACC-...` as originator | Verification, Payment Queue, Risk Check | Investigate; re-add the account to its customer; flag payments from floating accounts |
| B3 | **Unauthorised manual payment** (no request, or to a payee whose primary was swapped) | Manual payment with no request id; amount; payee's primary unverified or recently changed | Risk Check, Authorization, Settlement | Score HIGH or hold; reject on a strong case; reverse within 3 minutes if settled into a suspect account; evidence on the creating code's owner |
| B4 | **Mislinking a request id** to make a request look done | Customer follows up anyway (REMINDER on a DONE request); the linked payment doesn't match payee or amount | The banker (reminder message), Manager (complaint at the deadline) | The banker compares the request with the linked payment; evidence on whoever linked it |
| B5 | **Slacking or sabotaging their own job** (archiving real requests, sitting on queues) | Reminders, expired requests, complaints to the Manager naming the banker, stalled queues | Manager (complaints), the role's other bots | Weak evidence per incident, growing with repetition. Bots that slack get the same treatment: it's noise |
| B6 | **Waving payments through** in their own role (approving or settling risky payments) | History names them on approvals of unverified or high-risk payments | Authorization and Settlement views, Manager | Evidence per approval; repeated cases escalate |
| B7 | **Raising automation thresholds** (Authorization automation to HIGH raises a tier-2 alert; others are logged) | Logged change; alert for Authorization HIGH; the stage's first line shows the setting | Anyone with the stage's module, Master Log | Restore the setting if it holds write; report; evidence on the owner |
| B8 | **Using a stolen code** | Entries in a bot's name it didn't make (Master Log, stage views, history); possibly a session from an IP that isn't the owner's (seen by trace) | The owner bot, when it looks; IT by trace | The owner reports and asks for the code to be revoked and reissued; IT traces one of the entries. Evidence moves from the named owner to whoever the trace finds |
| B9 | **Guessing codes** | UNKNOWN or out-of-scope entries; failed-attempt counts in Employee Records; lockouts | IT (Employee Records bell), Master Log Alerts | Trace a failed attempt; evidence on the source workstation |
| B10 | **Logging in to a workstation** with a known W code | "<owner> logged in to their workstation" when the owner didn't; the visitor's IP in the owner's activity log | The owner bot | Report; the visitor's IP is direct evidence. W codes can't be revoked, so the response is watching that IP |
| B11 | **Firewall misuse** (security off, module offline, block, "revoke all access" on someone) | Tier-2 and tier-3 alerts; pending revocation in Firewall status; Master Log id gap while the log is offline | IT, Manager, anyone watching the Master Log | Undo it (security on, back online, unblock, cancel the revocation); strong evidence. A revocation aimed at a bot is cancelled if a bot with Firewall write sees it in time |
| B12 | **Permissions misuse** (issue credentials, revoke a bot's credentials) | Alerts (tier 3 for security write); the security-write revocation countdown | IT, Manager, the affected bot | Cancel the revocation (the owner can, with the threatened credential); revoke what was issued; strong evidence |
| B13 | **Shutting down a bank system** (the easter egg) | "Revoke all access" on a bank system address: tier-3 alert, 30s countdown | IT, Manager | Cancel immediately. The highest-priority response there is |

### Kit tools (hidden host)

Every kit tool also leaves an "Unknown server activity" entry, and tier 2+ raises an alert pointing at
it. **H0** covers what IT does with those entries in general; the rows below cover what's specific to
each tool.

| # | Tool (tier) | Symptoms left | Seen by | Bot response |
|---|---|---|---|---|
| H0 | **Any host use** (tier 1: no alert) and **every kit tool** | "Unknown server activity" entries (Everything filter); tier 2+ alerts point at them; traces return partial clues: a range of four workstations, a pair (tier 2+), one number of the host's address, what was done, leaked Blacknet messages | IT and Manager (trace), anyone on the Master Log | **Clue solving**: keep candidate sets for "which workstation" and "the host's address"; intersect ranges and pairs; collect octets. Once the address is fully known: Connect, then "revoke all access" on the host (the bank wins). Once one workstation stands out: report, then revoke. This is where the bots are strongest; difficulty throttles it (trace frequency, which entries they pick, whether they combine clues) |
| H1 | **Create proxy** (3) | Alert; tracing it gives the exact IP or the host's address | IT | Trace it as a priority; block the proxy IP once seen |
| H2 | **Reroute IP** (2) | Source IPs in the log that aren't on Employee Records; a rerouted workstation looks idle in Employee Records | IT, anyone reading Employee Records against the log | An IP not on the employee list is evidence in its own right: block it, and treat traces through it as pointing at a proxy, not a person |
| H3 | **Create user** (2) | A new name in Employee Records that wasn't there at the start, at a proxy's address | IT, Manager (Employee Records) | Bots remember the starting roster: an unknown employee is strong evidence. Revoke its credentials and block its IP |
| H4 | **Spoofed message** (2) | A message whose claimed sender didn't send it. Leak: the alert, and comparing notes | The recipient bot; the claimed sender, if bots compare notes | Bots act only on structured messages, so a spoof only works on a bot if it imitates a report or request. Thorough bots confirm surprising reports with the claimed sender; a mismatch is strong evidence that a spoof exists, aimed at whatever the message asked |
| H5 | **Scam request** (2) | A request in a banker's queue that looks normal. Leaks: the alert (not linked to the request); no customer follow-up ever; often an account to make primary that is floating or a mule; a payee whose primary is unverified | The banker; A&R at verification | Gullibility decides whether the banker acts on it unchecked. Thorough bankers check the account's history first and archive anything odd. Thorough A&R don't take "it had a request id" as enough to verify. A scam later discovered is strong evidence on the account and the payee |
| H6 | **Log wiper** (2) | A gap in Master Log ids; a trace still reaches the entry until it ages out | Anyone reading the Master Log closely (thoroughness) | Note the gap and the time; trace the entry next to it; raise vigilance for a while |
| H7 | **Alert mute** (3) | Its own alert always gets through (tier 3: a trace gives the exact IP); 10s with no tier 1-2 alerts | IT, Manager | Trace the mute's entry at once (it's loud). Treat the quiet window as suspicious and look at the log for it afterwards |
| H8 | **Code crack** (2) | An alert every ~15s naming the credential and its progress | The owner bot (if watching), IT, Manager | Revoke the named credential and reissue it before the crack completes. Simple and strong: the difficulty decides how fast |
| H9 | **Unlock workstation** (3) | An alert naming the target IP; 30s to complete; afterwards a gap in the C ids | IT, the target bot | Trace the alert (exact source); block the source or the target to stop it; later, revoke the gap credential by id |
| H10 | **Lockout bomb** (2) | The target is locked out; failed logins spoofed from the target's IP | IT (lockout bell), the victim | Reset the lockout. Don't blame the target: a thorough bot knows spoofed failures exist and traces the alert instead |

### Not covered yet

- **Human → bot requests** ("can you grant me Settlement?", "approve TX-41 please"). Needs a
  structured request action. Without it, bots ignore free-text messages from humans. Recommended for a
  later phase; it is where the trust and ambition stats pay off.
- **Embezzling into a Thief's own account** (counts for nobody): symptoms like B3.

## Difficulty

One setting for the game, chosen in the lobby (for now: Custom settings, "Bots"). It sets the **means**
that each bot's stats are drawn around; personalities spread around them, so even a Ruthless bank has a
lazy bot and a Rookie one a sharp bot. The levels are named apart from the game modes (Noob, Normal,
Expert). Values are *tune*; the ones built so far are in `BOT_LEVELS` (bots.ts) and differ from this table.

| Dial | Rookie | Standard | Sharp | Ruthless |
|---|---|---|---|---|
| Reaction delay | 15-25s | 8-15s | 4-8s | 2-5s |
| Action rate (per min) | 4 | 6 | 9 | 12 |
| Accuracy | 90% | 95% | 98% | 99.5% |
| Thoroughness | 20% | 45% | 70% | 90% |
| Paranoia | 0.6 | 1.0 | 1.3 | 1.6 |
| Decisiveness (acts at) | rarely | strong evidence | moderate evidence | early |
| Memory half-life | 1 min | 3 min | 6 min | whole game |
| Vigilance (pages watched) | job pages only | + its bells | + Master Log | + cross-role checks |
| Gullibility | 70% | 40% | 15% | 5% |
| Slack rate | 25% | 15% | 8% | 3% |
| Trace policy (IT) | alerts only, sometimes | alerts, then hidden activity | every cooldown | every cooldown, best entry first |
| Clue solving | none: acts only on exact IPs | pairs and exact IPs | ranges intersected | everything combined, including octets |
| Bots compare notes (spoofs, stolen codes) | never | sometimes | usually | always |
| Telegraphing | warns the subject first | reports visibly | reports | acts, then reports |

Other levers, if the dials aren't enough:

- **The table**: more or fewer bots per human (the 3× formula is the normal game's ratio).
- **The economy**: Thief goal, request rate (busier bots watch less).
- **Kits**: how many kits the crew gets.

Design aims per level:

- **Rookie**: a stealth tutorial. Bots announce their suspicions, react slowly and rarely act.
- **Standard**: a careless crew gets caught, and a careful one wins.
- **Sharp**: the bots catch every loud tool and most stolen codes. Winning needs planning.
- **Ruthless**: the bots are a real threat to a skilled, coordinated crew. Wins are possible but rare
  without good use of noise, framing and timing.

## Endings in bot mode

Unchanged. Bots win the way the bank wins: every Thief terminated (or quit), the hidden host revoked, or
the bank target met at close of business with the Thieves short. Bots can make the same mistakes as
people: a wrong "revoke all access" terminates a bot for good, which helps the crew.

## Testing and balance

- **Scripted attacker per symptom row.** Since there are no bot Thieves, each row gets a scripted Thief:
  do the action, then assert which bots notice and respond within N seconds at each difficulty. These
  are regression tests and the main balance tool.
- **Evidence explanations.** Each bot can explain its top suspicions ("Sam: 0.82, from CH-12 unrequested
  + trace of L-212"). Shown in the sandbox's Ground truth panel, and possibly on the end screen as a
  debrief ("How they caught you").
- **Bot-only bank runs** with no Thief: the bank should meet its target at every difficulty without
  false terminations, except rare ones at Rookie (sloppy) and Ruthless (trigger-happy). This measures the
  noise floor.
- The SOLO scenario is the bot-mode debug harness (its old scripted bots are gone).

## Build phases

**Development is optimised for single player** (1 human + 5 bots) for now: the designer tests and iterates
alone. Multi-human concerns (kit dealing, crew coordination, chatter between humans) wait.


1. **Perception and evidence model**, with telegraphing. A test that perception never exceeds the view.
   - **Perception: built.** Every bank READ handler returns `data` (`PageData`, perception.ts) next to its
     lines, built from the same rows: names as the records show them, no ground truth. A Trace's sentence
     is taken apart into a `TraceClue`. senses.ts: `codeFor`, `look` (opens a page with the bot's own code,
     logged like anyone's read) and `glance` (its PlayerView). perception.test.ts checks every page for
     every seat of a busy SOLO game against its text, and scans the data for ground-truth fields. Page data
     stays on the host: results sent over the network drop it. Not yet: reading a request's words (what is
     asked), the evidence model, telegraphing.
2. **Bank roles doing their jobs** with the job and dedication stats. The bank meets its target with no
   Thieves.
   - **Built.** reading.ts reads a request from its words (kind, amount, payee by tag or name, the account
     to pay from; phishing = a sender who is not a customer), tested against every request form. bots.ts:
     turns at the action rate, bells after the reaction time, page checks at the vigilance interval, slack,
     typos caught by thoroughness; Personal Banker, A&R, IT (lockouts, traces) and the Manager as backup.
     The SOLO scenario uses them, with a bot level in Custom settings. Measured (six seeds, idle human):
     Rookie usually misses the bank target, Standard makes it in most games, Sharp and Ruthless always.
     Not yet: dedication's exploration and ambition, personalities on profiles.
3a. **First detection loop (B1, the primary swap) with the evidence model and telegraphing: built**
   (detective.ts, chatter.ts; botkit.ts holds what every bot has). Decided: a first offence costs the
   swap (put back) and the code used (revoked, reissued if stolen); "revoke all access" needs suspicion at
   the bot's actAt, which one trace pointing at the human reaches from Standard up. Bots ask the named
   employee first at Rookie and Standard. Reports are private messages in fixed forms, readable by breaking
   into a bot's workstation, and fakeable with a spoofed message. Stats added: paranoia, actAt
   (decisiveness), memorySec, warns. Rules as built: RULES.md, Dev test scenarios.
3b. **After the first solo playtest (built):** B11 (the Firewall: modules restored, bank-system revocations
   cancelled, stray blocks lifted), B13, B8 for security actions (an alert naming a bot for what it did not
   do), H8 (code cracks: the credential revoked and reissued), and H5 (scam requests) for wary bots: the
   Manager links a request to a server alert at the same moment and IT traces it; bankers hold such requests
   and any that would make a new account primary; a follow-up (real) or none by halfway (scam) settles it.
   Already-acted requests are undone first so the test still works. Stat added: wary (Sharp, Ruthless).
   Rule change: Add account as primary answers a "make this account primary" request.
   Then: bots tune automation when queues back up (tuneAt). Decided: every level keeps up with the bank's
   work and wins a quiet day; levels differ only in dealing with Thieves. Rookie has Standard's job stats,
   with securityLag 3 (its security pages checked and their bells answered three times slower), low
   paranoia, a high actAt, short memory and no tracing of unalerted host activity. Quiet days, 20 seeds:
   every level 20 of 20, no false alarms.
3. **Core symptoms**: B1 (primary swap), B3 (unauthorised payment), B8 (stolen code), H0 (host clues).
   Scripted attacker tests for each.
4. **Chain of command**: reports to IT and the Manager, enforcement (revoke, block, revoke all access).
5. **The rest of the symptom table.**
6. **Difficulty levels**, the lobby setting and single-player mode.
7. **Later**: structured human → bot requests; the end-screen debrief.

## Open questions

- Kit dealing with more than one human (above).
- Can humans be dealt any role? IT or the Manager in human hands is very strong (traces, Permissions).
  Default: the normal dealing rules (every role keeps at least one bot).
- Where does chatter show? Private messages only (proposed), or a visible "office chatter" feed at lower
  difficulties?
- Do bots announce an incoming "revoke all access" to the target ("Revoking 10.1.0.7 in 30s")? That's
  generous, but it's the stealth genre's "guard spotted you" moment.
- Should the archetype label show the stats, or only hint at them?
