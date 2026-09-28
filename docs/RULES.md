# Rules as implemented

Decisions marked **assumed** were not in the design brief. Change them in `catalog.ts`
(`DEFAULT_CONFIG`, `ROLES`, `SYSTEMS`) or the handlers.

## Win conditions

- **Black Hats** win when stolen money reaches **$3,000,000**. Money only counts once a payment is
  SETTLED into a Target Ledger account. A successful reversal removes it again.
- **White Hats** win when **$200,000,000** of legitimate (NPC) payments have been SETTLED.
  Rejected, held and reversed payments do not count, so defence has a throughput cost.
- **Timer:** 40 minutes. If it expires the **Black Hats win** (assumed: the bank failed to hit its
  quota). Configurable via `timeoutWinner`.
- **Everybody loses** if a Firewall "revoke all access" completes on one of the bank's own systems
  (Security, Client Data or Transaction Processing): the bank shuts down and the game ends with no
  winner. It is the nuclear option for a side about to lose. Revoking a workstation or the unregistered
  host does not end the game.
- NPC payments arrive every 20s at $0.5M to $4M, about $270M over a full game against a $200M
  target, so White Hats need to process roughly three quarters of what arrives.

## Credentials and attribution

- A credential is owner + 4-digit code + system/module/(function) scope + READ/WRITE + status.
- Entering any valid code acts as its **owner**. The Master Log records the owner. The actual
  workstation IP is stored as ground truth and is only revealed by **Trace**.
- Unknown code, revoked code and wrong scope all return the same "Access denied." (no oracle for
  guessing) but the log tells the real story: UNKNOWN for a bad code, the owner's name otherwise.
- Three failures in a row lock that workstation for 20s.
- A player "holds" every credential they own, were shared, or successfully used.
- IT Specialists can create credentials **in anyone's name** (assumed). The owner is told in their
  personal log. Revoking is also visible to the owner.

## Customers and accounts

- Everyone the bank deals with is a **customer**: 14 of them, tagged **CU1-CU14** (companies and people
  alike). Each starts with 1-3 accounts; one is **primary**.
- **Accounts can float**: a number attached to nobody (the Black Hats' mule accounts start that way).
- Customer Records: **View customers** shows the customers whose banker is the credential owner (a
  whole-system Client Data credential shows all 14). **Add account** (any 5-digit number no other
  customer owns, optionally as the new primary), **Set primary account** (one of the customer's
  accounts), **Remove account** (never the primary, so never the last one; a removed account floats
  again). The change commands are scoped like the view: only the credential owner's own customers,
  unless the credential covers all of Client Data.
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
- **Permissions**: view active or all credentials, with readable scopes such as "Read & write ·
  Settlement"; issue a credential; revoke one by id.
- **Master Log live monitor:** "Auto-update every second" refreshes the view in place. Opening the view is
  logged as usual; the refreshes are not (the engine only allows a quiet refresh of a view the player has
  already opened with a logged read).
- A module taken offline rejects all use. While the **Master Log** is offline nothing is recorded but
  log ids keep counting, so the gap is visible.
- **Trace** (in the **Master Log**; Security Analysts hold Master Log write): reveals the source IP of
  one log entry. Entry must be under 3 minutes old, 30s cooldown per player. Employee Records list every registered IP, so a trace can identify a person. That is
  strong on purpose; the analyst's role could itself be a Black Hat who lies about the result.

## Client Data and Permissions

- Client Data has Customer Records, Client Requests and Verification, each with a view.
- **Permissions** (view, create and revoke credentials) is part of **Security**, not Client Data. IT
  Specialists hold it. The unregistered host is not the bank's: Permissions can neither issue nor list
  credentials for it.
- Customer Records' view has **My customers** and **All customers**; "All" needs a credential for all of
  Client Data.
- IT Specialists also hold a **read-only credential for all of Client Data** (every customer, every
  banker's requests, verification). Temporary; permissions are due for a review.

## Client Requests

- Each customer has an assigned personal banker (round-robin over Personal Bankers; shown in Customer
  Records). Customers write to their banker: two requests at the start, then one every 45s
  (`requestIntervalSec`). 70% ask for a payment; 30% (`requestChangeShare`) ask to add an account, add
  one and make it primary, make an existing account primary, or remove an account.
- Requests are written in words ("send $1.2M from our main account to Northwind Freight", or "from our
  account 45515"), never customer codes: acting on one means looking up the account and the payee's tag.
- Client Data > Client Requests: **View** (Open / All) shows requests addressed to the **credential
  owner**, so a borrowed code shows its owner's inbox. A whole-system Client Data credential sees every
  banker's requests. **Archive** closes one without acting and needs a reason; you can only archive
  requests you can see.
- A request is **Done** when the matching action is made with its Request ID: Create payment, Add account
  (for add / add-as-primary requests), Set primary account, or Remove account. The kind must match. Anyone can link a request; the link shows on the payment
  ("for REQ-7") in every view and in its history. Whether the payment matches what was asked is not
  checked yet (the request keeps the asked-for details hidden, for later).
- Personal Bankers get Client Requests access, but only Accounts & Receivables can create payments. A
  banker has to get a payment request carried out by someone else.

## Workstations

- Every player's workstation IP is an address. Typing it into a window's address bar shows a locked
  login page. Any **active** credential owned by that player (any scope) logs you in; anything else is
  "Access denied.", logged, alerted and counts toward the lockout, like any other bad code.
- Logged in, you see their whole workstation read-only: profile, objective, private info, every
  credential they hold with codes, their activity log and messages. The session lasts until the
  credential you used is revoked.
- Trace: the Master Log records "<owner> logged in to their workstation", named after the credential's
  owner, which is always the workstation's owner. Their personal activity log records the visitor's IP.

## Hidden host (Black Hat Database)

- Address `10.66.6.6`. Black Hats start knowing it and holding a credential for it (assumed: Black
  Hats do **not** start knowing who the other operatives are; they find each other on Blacknet).
- Every use of the host (and every Connect to its address) writes only a cryptic, nameless system entry,
  **"Unknown server activity"**, visible under the Master Log's **Everything** filter but not **Player
  activity**. Quiet live-monitor refreshes write nothing. It also raises an alert (Master Log > Alerts),
  "Traffic to an unregistered host detected", with **no address** (throttled to one per 30s). The alert
  points at a log entry that can be traced for clues.
- Failed code attempts on the host (unknown, revoked, wrong access) also write only "Unknown server
  activity". They still count toward the lockout and the failed-attempts total in Employee Records.
- **Tracing** an "Unknown server activity" entry ("routed through a relay.") returns one true but
  partial clue, chosen at random:
  - a window of four workstations: "The origin workstation is within 10.1.0.13-16."
  - a pair, the real one and a random decoy in random order: "one of two workstations: A or B."
  - one number of the server's address: "The server's IP address is x.66.x.x."
  - what was done: "Activity performed: posted on Blacknet." (also: read the board, viewed the target
    ledger, changed a target's status, viewed the credential cache, connected, failed login attempt)
- White Hats find the address from trace clues (one number of it at a time) or info packets, use **Connect** to make the system
  appear, then need a credential: guess one (info packets leak its digits), get one shared, or find
  one on a Black Hat's workstation. Permissions cannot issue host credentials.
- Credential Cache lists White Hat credentials held by operatives.

## Info packets

One packet per player per system (40 for 10 players), drawn from per-system fact pools. Some facts
are shared by several players (redundancy), some are rules of the world, some are clues: the hidden
host address, two customers' original primary accounts, two mule accounts, four digits of one operative's
host code, one operative's IP. All facts are true.

## Not implemented yet

See [BACKLOG.md](BACKLOG.md) for agreed and deferred work.
