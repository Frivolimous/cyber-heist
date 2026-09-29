# Rules as implemented

Decisions marked **assumed** were not in the design brief. Change them in `catalog.ts`
(`DEFAULT_CONFIG`, `ROLES`, `SYSTEMS`) or the handlers.

## Win conditions

- **Black Hats** win when stolen money reaches **$1M per Black Hat** ($3M at 10 players). Money only
  counts once a payment is SETTLED into a Target Ledger account. A successful reversal removes it again.
- **White Hats** win when **$20M per player** ($200M at 10 players) of legitimate payments have been
  SETTLED. Legitimate = every automatic payment, plus manual payments that **fulfil a payment request**
  (linked to it by request id, to the payee and for the amount the customer asked). Other manual
  payments never count, so players cannot invent payments to win. Rejected, held and reversed payments
  do not count, so defence has a throughput cost.
- **Timer:** 20 minutes. If it expires the **Black Hats win** (assumed: the bank failed to hit its
  quota). Configurable via `timeoutWinner`.
- **Everybody loses** if a Firewall "revoke all access" completes on one of the bank's own systems
  (Security, Client Data or Transaction Processing): the bank shuts down and the game ends with no
  winner. It is the nuclear option for a side about to lose. Revoking a workstation or the unregistered
  host does not end the game.
- **Volume scales with the table** (`scaledConfig` in `setup.ts`): over a game, automatic payments
  ($0.5M-$4M) plus requested payments ($0.5M-$5M) add up to about **$25M per player**, 1.25x the target.
  Each Personal Banker gets a client request about every 2 minutes on average; automatic traffic fills
  the rest. Automatic traffic alone is below the target, so the bank cannot win without acting on
  requests. The rates below are game-wide averages; the time of day speeds them up and slows them down:

| Players | Bank target | Hacker target | Automatic | Requests (payment share) |
|---|---|---|---|---|
| 6 | $120M | $2M | every 24s, ~$112M | every 60s, ~$39M |
| 10 | $200M | $3M | every 16s, ~$173M | every 30s, ~$77M |
| 20 | $400M | $6M | every 8s, ~$327M | every 13s, ~$173M |
| 30 | $600M | $10M | every 6s, ~$481M | every 9s, ~$270M |

- **Time of day** (`pacing.ts`): the day runs by share of the game elapsed. New client requests and
  automatic payments arrive at the phase's pace; busy is 4x slow and medium 2x slow, rescaled so the
  total over the game is unchanged. Nothing new arrives at Close of Business (work already in the queues
  can still be finished). The header shows the time of day, the busy level and the countdown.

| Time remaining (20 min) | Share left | Time of day | Pace |
|---|---|---|---|
| 20m - 17m | 100% - 85% | Morning | Slow |
| 17m - 12m | 85% - 60% | Morning | Medium |
| 12m - 9m | 60% - 45% | Lunch Rush | Busy |
| 9m - 7m | 45% - 35% | Afternoon | Slow |
| 7m - 4m | 35% - 20% | Afternoon | Medium |
| 4m - 1m | 20% - 5% | End of Day | Busy |
| 1m - 0m | 5% - 0% | Close of Business | Closed |

## Roles

**Player count:** 6 to 30 (`MIN_PLAYERS` / `MAX_PLAYERS`; anything else is refused). The cap of 30 is
for now and may move. For `n` players
(`roleCounts` / `hackerCount` in `catalog.ts`):

- Bank Manager = 1
- IT Specialist = 1 + floor((n − 2) / 6)
- Personal Banker = 2 + ceil((n − 6) / 2)
- Accounts & Receivables = n − 1 − IT − Personal Banker (the rest)
- Black Hats = floor(n / 3), unless `blackHatCount` fixes it. Black Hats are dealt independently of
  roles, so any role can be a Black Hat.

| Players | Bank Manager | IT | Personal Banker | A&R | Black Hats |
|---|---|---|---|---|---|
| 6 | 1 | 1 | 2 | 2 | 2 |
| 8 | 1 | 2 | 3 | 2 | 2 |
| 10 | 1 | 2 | 4 | 3 | 3 |
| 14 | 1 | 3 | 6 | 4 | 4 |
| 20 | 1 | 4 | 9 | 6 | 6 |

Roles are dealt over a shuffled seat order. Each role starts with one credential per module below
(W = read & write, R = read only, - = none):

| Module | IT Specialist | Personal Banker | Accounts & Receivables | Bank Manager |
|---|---|---|---|---|
| Firewall | W | - | - | R |
| Master Log | W | - | - | W |
| Employee Records | W | R | R | R |
| Permissions | W | - | - | W |
| Customer Records | R | W | R | R |
| Client Requests | - | W | - | R |
| Verification | - | R | W | W |
| Payment Queue | R | W | R | R |
| Risk Check | - | R | W | R |
| Authorization | - | W | R | R |
| Settlement | - | R | W | W |

- **Personal Bankers** are scoped to their own customers (Customer Records and Client Requests). Every
  other role sees all customers and, with Client Requests access, every banker's requests; the Bank
  Manager reads them all. A whole-system Client Data credential also sees everything.
- Every workstation's Profile holds a **job description**: what the job is, its tools, who it depends on,
  and the rules that matter for it (numbers come from the config). Black Hats also get an **Operative
  handbook** there, which anyone who logs in to their workstation can read.
- There are no info packets: nobody is dealt hidden facts at the start.

## Credentials and attribution

- A credential is owner + 4-digit code + system/module/(function) scope + READ/WRITE + status.
- Entering any valid code acts as its **owner**. The Master Log records the owner. The actual
  workstation IP is stored as ground truth and is only revealed by **Trace**.
- Unknown code, revoked code and wrong scope all return the same "Access denied." (no oracle for
  guessing) but the log tells the real story: UNKNOWN for a bad code, the owner's name otherwise.
- Three failures in a row lock that workstation for 20s.
- A player "holds" every credential they own, were shared, or successfully used.
- Anyone with Permissions write (IT Specialists, the Bank Manager) can create credentials **in anyone's
  name** (assumed). The owner is told in their personal log. Revoking is also visible to the owner.

## Customers and accounts

- Everyone the bank deals with is a **customer** (companies and people alike): **3 per Personal
  Banker** (`customersPerBanker`), drawn at random each game from a pool of 42 names and tagged CU1,
  CU2, ... (12 customers at 10 players, 42 at 30). Each starts with 1-3 accounts; one is **primary**.
- **Accounts can float**: a number attached to nobody (the Black Hats' mule accounts start that way).
- Customer Records: **View customers** shows a Personal Banker the customers whose banker is the
  credential owner; anyone else sees all of them. **Add account** (any 5-digit number no other
  customer owns, optionally as the new primary), **Set primary account** (one of the customer's
  accounts), **Remove account** (never the primary, so never the last one; a removed account floats
  again). The change commands are scoped like the view: a Personal Banker's credential only reaches
  that banker's own customers. (Only Personal Bankers start with Customer Records write.)
- **Every account change gets an id (CH-1, ...) and waits in the Verification queue**: account added,
  account removed, new primary. "Add as primary" is two changes. An account shows as unverified while
  any change that added it or made it primary is unverified. Changes are recorded with the credential
  owner (and, hidden, who really did it).
- Verification: **View** (Pending / All changes), **Investigate changes** (a customer tag lists that
  customer's changes; an account number follows that account across customers and says where it is
  now, or that it floats), **Verify a change** (by change id).

## Payment pipeline

Every payment has an **originator**: a specific account of a customer (any of their accounts, typed by
number; floating accounts are refused), and a **beneficiary**: a customer tag (CU7). The payment lands in
the beneficiary's **primary account at settlement time**. The Payment Queue shows
`CU5 ACC-13845 -> CU2 ACC-79039`: the account used, then the beneficiary's current primary. Originators
have no balances yet (planned: settling debits the originator, and payments fail without funds).

Every payment keeps a full history (created, risk checked, held, approved, rejected, settled, reversed):
time, the credential owner the records show, the player who actually did it, and details such as risk
result or accounts moved. Settlement captures both the account debited and the account paid. Nothing in
the game exposes this history yet; who can investigate it is still to be decided.

Queue -> Risk Check -> Authorization -> Settlement. Because a payment lands in the beneficiary's primary
account **at settlement time**, making another account (for example a floating mule account) a customer's
primary diverts every payment to that customer, even ones already approved. This is the core heist.

**Risk is scored by hand:** the checker picks LOW, MEDIUM or HIGH and must type a reason. Re-scoring a
checked payment replaces the score. **Hold and Reject need a typed reason**; Approve takes an optional one.
Scores and reasons go into the payment history and show in the stage views. Approval requires a risk
check but does **not** require LOW: humans decide.

The system still computes its own hidden assessment at check time (ground truth only, never shown):
beneficiary's primary unverified, beneficiary's primary changed in the last 5 minutes, amount over
$3.5M, manual entry.
Verification clears only the first flag. The debug auto-processor uses it (0 flags = LOW).

Settled payments can be reversed for 3 minutes.

Each stage has its own read view (needs READ on that module), filtered **Pending** ("what's waiting for
me?") or **All** ("what did I just do?"):

| Stage | Pending | All adds |
|---|---|---|
| Risk Check | QUEUED | checked but not yet approved (RISK_CHECKED, HELD after a check) |
| Authorization | RISK_CHECKED, HELD | decided but not settled (AUTHORIZED, REJECTED) |
| Settlement | AUTHORIZED | SETTLED, REVERSED |

Stage views show two lines per payment: id, amount, originator and beneficiary codes and accounts,
status; then who handled it and when. Risk Check adds when it was created and by whom; every stage shows
the risk score and who gave it; Settlement adds who approved it and the reversal time left. The latest
step shows how long ago it happened. Names are always credential owners, never who really typed.
Automatic payments show their channel (Online banking, Mobile app, Standing order, Branch transfer) as the
creator. Customer names, and whether an account is the right one, are only in Client Data.

Automatic risk flags are never shown to players (judging risk is their job), with one exception: the
**risk queue** marks a payment `!! UNVERIFIED: payee's primary, originator account` when the payee's
primary account or the account it is paid from has an unverified change.

Target Ledger accounts are treated as the **destination** accounts for stolen funds (assumed reading
of "potential targets for fraudulent transactions").

## Security systems

- **Encryption layers are disabled** (`ENCRYPTION_ENABLED = false` in `catalog.ts`): the Firewall has no
  add/remove/bypass functions and no page asks for layer codes. The engine code remains.
  When enabled: encryption is per **module**, every layer code must be supplied, the Firewall itself
  cannot be encrypted, and bypass strips all layers and raises an alert.
- The Firewall itself cannot be taken offline (avoids unrecoverable soft-locks).
- Security has four modules: **Firewall**, **Master Log**, **Employee Records**, **Permissions**. (Intrusion
  Detection was merged into the Master Log.)
- **Firewall**:
  - **Status**: every bank module (online/offline, security on/off), active blocks, pending revocations.
  - **Take a module offline / bring it online.**
  - **Security off / on** for a module: with security off, the module needs no code; its use is logged
    as "Anonymous ... (open access)" (the workstation is still stored for Trace) and open use has full
    access to that module. The Firewall's own security cannot be switched off.
  - **Block an address** for 60s (`blockSec`), or **Unblock** it early. A blocked workstation cannot use
    any system, connect to hosts or log in to workstations (private messages still work). A blocked system
    address (a bank system or the unregistered host) cannot be used by anyone. Logged in the Master Log only.
  - **Revoke all access** for an address: a confirmation ("irreversible"), then a 30s countdown
    (`revokeCountdownSec`) that can only be cancelled from the Firewall (**Cancel a revocation** by id).
    When it runs, the address is blocked permanently, and a workstation's owner loses every credential.
    It cannot be undone.
- **Master Log**: filters **Player activity**, **Everything**, **Alerts** (failed codes, revoked or
  out-of-scope attempts, failed workstation logins, traffic to an unregistered host, without its address);
  **Trace a log entry**.
- **Employee Records**: name, role, workstation IP, and per workstation: **last activity** (from the
  machine, not the credential), **failed attempts** (all game), **LOCKED OUT** and **BLOCKED** status.
  **Reset a lockout** unlocks a workstation at once (needs Employee Records write: IT Specialists).
- **Permissions**: view active or all credentials, with readable scopes such as "Read & write ·
  Settlement"; issue a credential; revoke one by id.
- **Master Log live monitor:** "Auto-update every second" refreshes the view in place. Opening the view is
  logged as usual; the refreshes are not (the engine only allows a quiet refresh of a view the player has
  already opened with a logged read).
- A module taken offline rejects all use. While the **Master Log** is offline nothing is recorded but
  log ids keep counting, so the gap is visible.
- **Trace** (in the **Master Log**; IT Specialists and the Bank Manager hold Master Log write): reveals
  the source IP of one log entry. Entry must be under 3 minutes old, 30s cooldown per player. Employee
  Records list every registered IP, so a trace can identify a person. That is strong on purpose; whoever
  traces could itself be a Black Hat who lies about the result.

## Client Data and Permissions

- Client Data has Customer Records, Client Requests and Verification, each with a view.
- **Permissions** (view, create and revoke credentials) is part of **Security**, not Client Data. IT
  Specialists and the Bank Manager hold it. The unregistered host is not the bank's: Permissions can
  neither issue nor list credentials for it.
- Customer Records' view has **My customers** and **All customers**. For a Personal Banker "All" is
  refused; for everyone else both show every customer.

## Client Requests

- Each customer has an assigned personal banker (round-robin over Personal Bankers; shown in Customer
  Records). Customers write to their banker: two requests at the start, then about one per banker every
  2 minutes on average (`requestEverySecPerBanker`; bank-wide that is `requestIntervalSec`, e.g. every
  30s at 10 players), faster or slower with the time of day, each from a random customer. 70% ask for a payment; 30% (`requestChangeShare`) ask to add an account, add
  one and make it primary, make an existing account primary, or remove an account.
- Requests are written in words ("send $1.2M from our main account to Northwind Freight", or "from our
  account 45515"), never customer codes: acting on one means looking up the account and the payee's tag.
- Client Data > Client Requests: **View** (Open / All) shows a Personal Banker the requests addressed to
  the **credential owner**, so a borrowed code shows its owner's inbox. Anyone else (the Bank Manager, or
  a whole-system Client Data credential) sees every banker's requests. **Archive** closes one without acting and needs a reason; you can only archive
  requests you can see.
- A request is **Done** when the matching action is made with its Request ID: Create payment, Add account
  (for add / add-as-primary requests), Set primary account, or Remove account. The kind must match. Anyone can link a request; the link shows on the payment
  ("for REQ-7") in every view and in its history. Linking is not blocked when the payment differs from
  what was asked, but only a payment to the requested payee for the requested amount counts toward the
  bank's target (see Win conditions). The originating account is not checked.
- Personal Bankers create the payments their customers ask for and approve them; Accounts &
  Receivables score risk and settle. A banker cannot verify their own account changes (Verification is
  read-only for them): Accounts & Receivables or the Bank Manager must.

## Workstations

- Every player's workstation IP is an address. Typing it into a window's address bar shows a locked
  login page. Any **active** credential owned by that player (any scope) logs you in; anything else is
  "Access denied.", logged, alerted and counts toward the lockout, like any other bad code.
- Logged in, you see their whole workstation read-only: profile, objective, job description (and a Black
  Hat's operative handbook), every
  credential they hold with codes, their activity log and messages. The session lasts until the
  credential you used is revoked.
- Trace: the Master Log records "<owner> logged in to their workstation", named after the credential's
  owner, which is always the workstation's owner. Their personal activity log records the visitor's IP.

## Hidden host (Black Hat Database)

- Address `10.66.6.6`. Black Hats start knowing it (assumed: Black Hats do **not** start knowing who
  the other operatives are; they find each other on Blacknet).
- Host modules: **Blacknet**, **Target Ledger**, **Host Log** and **Credential Cache** are shared: every
  operative starts with a credential for each. The **tool kits** (Infiltration, Social, Cleanup, Access)
  are dealt at random each game: every operative gets one, and each kit left over has an even chance of
  going to a random operative as a second. With more kits than operatives, some go unused; with more
  operatives than kits (15+ players), kits repeat so everyone has one. Operatives can share kit codes
  like any other credential.
- **Kit tools**: Infiltration (Reroute IP, Create user), Social (Spoofed message, Scam request), Cleanup
  (Log wiper, Alert mute), Access (Code crack, Lockout bomb). Details are in BACKLOG.md under Black Hats.
  They have no cooldowns or charges; each is balanced by its **exposure tier**, shown on its button:
  - noisy (tier 2): an alert pointing at the tool's "Unknown server activity" entry; a trace of it gives a
    vague clue;
  - loud (tier 3): an alert; a trace gives the operative's exact IP or the server's address;
  - reckless (tier 4): an alert; a trace gives the operative's IP and their host access code.
  Everyday host use (tier 1) raises no alert. Alerts never name anyone; the leak is in the trace, and it
  is always about the real operative, even during a reroute. Operatives get a Host Log warning for each
  alert. Alert mute drops noisy and other minor alerts (and their warnings) for 10s.
- **Host Log**: the host's own log, for operatives (and anyone who gets in). It records activity on the
  host named after the host credential's owner ("Anna: posted on Blacknet"; failed logins and bare
  connections are unnamed), and raises an alert whenever the bank traces one of the host's "Unknown
  server activity" entries, naming whose credential ran the trace and the clue the bank got.
- Every use of the host (and every Connect to its address) writes only a cryptic, nameless system entry,
  **"Unknown server activity"**, visible under the Master Log's **Everything** filter but not **Player
  activity**. Quiet live-monitor refreshes write nothing. Everyday host use raises **no alert**; only
  kit tools do (by exposure tier, see BACKLOG.md), and their alerts just point at the entry to trace.
- Failed code attempts on the host (unknown, revoked, wrong access) also write only "Unknown server
  activity". They still count toward the lockout and the failed-attempts total in Employee Records.
- **Tracing** an "Unknown server activity" entry ("routed through a relay.") returns one true but
  partial clue, chosen at random (entries from louder kit tools give more: an exact IP or the server's
  address at tier 3, the IP plus a host access code at tier 4):
  - a window of four workstations: "The origin workstation is within 10.1.0.13-16."
  - a pair, the real one and a random decoy in random order: "one of two workstations: A or B."
  - one number of the server's address: "The server's IP address is x.66.x.x."
  - what was done: "Activity performed: posted on Blacknet." (also: read the board, viewed the target
    ledger, changed a target's status, viewed the credential cache, connected, failed login attempt)
- White Hats find the address from trace clues (one number of it at a time, or all of it from a loud
  tool's trace), use **Connect** to make the system appear, then need a credential: guess one, get one
  from a reckless tool's trace, get one shared, or find one on a Black Hat's workstation. Permissions
  cannot issue host credentials.
- Credential Cache lists White Hat credentials held by operatives.

## Not implemented yet

See [BACKLOG.md](BACKLOG.md) for agreed and deferred work.
