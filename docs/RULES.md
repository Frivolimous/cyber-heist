# Rules as implemented

Decisions marked **assumed** were not in the design brief. Change them in `catalog.ts`
(`DEFAULT_CONFIG`, `ROLES`, `SYSTEMS`) or the handlers.

## Win conditions

- **Black Hats** win **at once** when stolen money reaches **$1M per Black Hat** ($3M at 10 players).
  Stolen money is whatever sits in the Target Ledger (mule) accounts, which start empty: it arrives when a
  payment SETTLES into one of them, and leaves again on a successful reversal or when a mule account pays out.
- **White Hats** win **at close of business** (when the timer runs out) if **$15M per player** ($150M at
  10 players) of legitimate payments have been SETTLED by then. Meeting the target early does not end the
  game: the bank has to survive the whole day. Legitimate = every automatic payment, plus manual payments that **fulfil a payment request**
  (linked to it by request id, to the payee and for the amount the customer asked). Other manual
  payments never count, so players cannot invent payments to win. Rejected, held, failed and reversed
  payments do not count, so defence has a throughput cost. Payments settled into an employee's own
  account (**embezzled**) count for nobody.
- **Timer:** 20 minutes. If it runs out with the bank short of its target (and the Black Hats short of
  theirs, or they would already have won), **both sides lose**.
- **White Hats** also win **at once** when **every Black Hat is terminated** (see Termination), or when a
  Firewall "revoke all access" completes on the **unregistered host**: it is shut down and
  the heist is over.
- **Everybody loses** if a Firewall "revoke all access" completes on one of the bank's own systems
  (Security, Client Data or Transaction Processing): the bank shuts down and the game ends with no
  winner. It is the nuclear option for a side about to lose.
- **End screen**: who won and how (worded for each ending), both teams with their members and what each
  team made against its goal (settled for the bank, diverted for the Black Hats), who was terminated, and
  as an aside anyone who **embezzled** ("Embezzled $2,351": payments settled into their own account, which
  count toward no goal). It can be put away to look at the desk and brought back from the status bar.

## Termination

- A player is **terminated** for good when **every bank credential they own has been revoked**, or when
  a Firewall **"revoke all access" completes on their workstation's IP**. Nothing brings them back,
  White Hat or Black Hat.
- The Master Log records "<name> (<ip>) terminated: ..." and Employee Records mark them **TERMINATED**.
  Permissions refuses to issue them credentials.
- They lose every bank system, workstation logins and connections: every bank page shows "ERROR: Your
  credentials are invalid." Private messages still work.
- A terminated Black Hat **keeps the unregistered host**: it is outside the bank's firewall, so a revoked
  IP does not cut it off and its credentials are not revoked. (A timed Firewall block still does.)
- Planted users (Infiltration) are terminated the same way once they have been issued a credential.
- **Volume scales with the table** (`scaledConfig` in `setup.ts`). Each Personal Banker gets a client
  request about every **90 seconds** on average. Automatic traffic fills the rest, up to about $17.4M per
  player in total (1.16x the target), but automatic volume is capped at **80% of the bank target**, so the
  bank cannot win without acting on requests. Offered volume ends up at about 1.15-1.2x the target (measured):
  the team has to act on most payment requests. The design is **many small automatic payments** (which the
  stage automation can handle) and **fewer, bigger requested payments** (which need people). Amounts are
  capped by balances (see Customers and accounts), so the averages used for this (about $0.7M automatic,
  $2.5M requested) were measured by simulating games. Requests are a larger share at bigger tables, where
  a larger share of players are bankers. The rates below are game-wide averages; the time of day speeds
  them up and slows them down:

| Players | Bank target | Hacker target | Automatic | Requests (payment share) |
|---|---|---|---|---|
| 6 | $90M | $2M | every 14s, ~$59M | every 45s, ~$46M |
| 10 | $150M | $3M | every 10s, ~$82M | every 23s, ~$92M |
| 20 | $300M | $6M | every 6s, ~$142M | every 10s, ~$206M |
| 30 | $450M | $10M | every 4s, ~$201M | every 6s, ~$321M |

- **Time of day** (`pacing.ts`): the day runs by share of the game elapsed. New client requests and
  automatic payments arrive at the phase's pace; busy is 4x slow and medium 2x slow, rescaled so the
  total over the game is unchanged. Nothing new arrives at Close of Business (work already in the queues
  can still be finished). The header shows the time of day, the busy level and the game clock counting
  up to its end ("07:42 / 20:00"). Every time players see (logs, records, requests, the end screen) uses
  that same clock.

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
- Black Hats = floor(n / 3), unless `blackHatCount` fixes it. Any role can be a Black Hat, but
  every role other than the Bank Manager always keeps **at least one White Hat** (at 6-7 players the only
  IT Specialist is always a White Hat). The Bank Manager can be a Black Hat.

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
- A player "holds" (sees in their credential list) every credential they own or were handed by a kit tool.
  **Credential sharing is switched off** (`CREDENTIAL_SHARING_ENABLED` in `catalog.ts`): there is no
  Share action, and a code someone else owns works every time it is typed but is not kept in your list.
  Passing a code on means telling it to someone.
- Anyone with Permissions write (IT Specialists, the Bank Manager) can create credentials **in anyone's
  name** (assumed). The owner is told in their personal log. Revoking is also visible to the owner.

## Customers and accounts

- Everyone the bank deals with is a **customer** (companies and people alike): **3 per Personal
  Banker** (`customersPerBanker`), drawn at random each game from a pool of 42 names and tagged CU1,
  CU2, ... (12 customers at 10 players, 42 at 30). Each starts with 1-3 accounts; one is **primary**.
- **Every account has a balance.** Only these accounts exist; any other number is refused wherever an
  account is typed ("There is no account ACC-12345."):
  - customer accounts;
  - the Black Hats' Target Ledger (mule) accounts, starting at $0;
  - every player's own account (on their workstation profile), starting at $1,000-$100,000;
  - the new accounts customers ask to have added (created when the request arrives, $50k-$1M).
  A planted user (Infiltration / Create user) gets a made-up number that does not exist.
- **Accounts can float**: an existing account on no customer. Mule accounts, player accounts, requested
  new accounts and removed accounts float. A floating account can be added to a customer and can pay.
- **Wealth is a fixed split every game**: 20% of customers are wealthy ($30M-$60M in total), 30% mid-sized
  ($5M-$15M), and the rest (half) small ($250k-$2M). The primary holds 60-85% of a customer's money and
  the rest is split at random over their other accounts, so many accounts start under $1M.
- Customer Records: **View customers** shows a Personal Banker the customers whose banker is the
  credential owner; anyone else sees all of them, with every account's balance. **Add account** (an
  existing floating account, optionally as the new primary), **Set primary account** (one of the customer's
  accounts), **Remove account** (never the primary, so never the last one; a removed account floats
  away **with its money**). The change commands are scoped like the view: a Personal Banker's credential only reaches
  that banker's own customers. (Only Personal Bankers start with Customer Records write.)
- **Every account change gets an id (CH-1, ...) and waits in the Verification queue**: account added,
  account removed, new primary. "Add as primary" is two changes. An account shows as unverified while
  any change that added it or made it primary is unverified. Changes are recorded with the credential
  owner (and, hidden, who really did it).
- Verification: **View** (Pending / All changes), **Investigate changes** (a customer tag lists that
  customer's changes; an account number follows that account across customers and says where it is
  now, or that it floats, and its balance), **Verify a change** (by change id).

## Payment pipeline

Every payment has an **originator**: the account it is paid from, typed by number (any existing account,
including a floating one), and a **beneficiary**: a customer tag (CU7). The payment lands in the
beneficiary's **primary account at settlement time**. The Payment Queue shows
`CU5 ACC-13845 -> CU2 ACC-79039`: the originator's customer and the account used, then the beneficiary's
current primary. A payment from a floating account shows `UNKNOWN ACC-...` as its originator.

**Money moves at settlement, at once:** the amount leaves the originator account and lands in the
payee's primary. If the originator account holds less than the amount at that moment, the payment
**FAILS** instead (it shows as FAILED in Settlement's All view and nothing moves). Nothing checks funds
when a payment is created. A **reversal claws the money back** from the account it was paid into; it
fails ("no longer holds") if that account no longer holds the whole amount, for example because a mule
account already paid it on.

Automatic payments and payment requests are sized to what the paying account holds: the customer
paying is picked in proportion to their wealth, the account in proportion to its balance, and the amount
is at most 40% of that account's balance (at least $10k). Automatic payments are $165k-$1.32M within that.
A payment request picks $500k-$5M within that, then **x2.18**, but never more than the account holds or the
$10M a banker may pay by hand (so a request can ask for up to ~87% of an account). A payment request says
where to pay from in one of three forms, a third each: "from our main account" (the primary); "from our
account 12345" (any of theirs, the richer the likelier); or "from our other account (not the main one)",
"from whichever of our other accounts has the funds" with several (a non-primary account that can afford
it; the banker looks up which). A form the customer cannot pay from falls back to the account number. Payees are also picked in
proportion to wealth, so money does not drain from rich to poor customers. A customer too poor to pay
anything asks to add an account instead. An automatic payment the chosen account cannot afford is skipped.

Every payment keeps a full history (created, risk checked, held, approved, rejected, settled, failed, reversed):
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
Verification clears only the first flag.

**Automation.** Each stage can handle routine payments by itself. Anyone with WRITE on the stage's module
changes its setting; the change is logged under the credential owner, and the stage's queue view shows
the current setting on its first line. Automation never touches a held payment, and its steps show as
"Automation" in the stage views (SYSTEM in the history).

| Stage | Setting | Default |
| --- | --- | --- |
| Risk Check | score LOW every queued payment up to a **max amount** that also passes three switches: automatic payments only, or manual too; paid from a customer's account only, or from a floating one too; payee's primary verified only, or unverified too | $1,000,000; automatic only; customer accounts; verified primaries |
| Authorization | approve risk-checked payments scored at or below **NONE / LOW / MEDIUM / HIGH**, whoever scored them. Setting HIGH raises a Suspicious security activity alert (tier 2, so Alert mute hides it) | LOW |
| Settlement | settle approved payments up to a **max amount**, automatic or manual | $1,000,000 |

A max amount of 0 (or NONE) switches that stage off. A stage's bell stays quiet for payments its
automation will take. Money settled by automation counts like any other.

Settled payments can be reversed for 3 minutes, if the account paid still holds the money.

Each stage has its own read view (needs READ on that module), filtered **Pending** ("what's waiting for
me?") or **All** ("what did I just do?"):

| Stage | Pending | All adds |
|---|---|---|
| Risk Check | QUEUED | checked but not yet approved (RISK_CHECKED, HELD after a check) |
| Authorization | RISK_CHECKED, HELD | decided but not settled (AUTHORIZED, REJECTED) |
| Settlement | AUTHORIZED | SETTLED, FAILED, REVERSED |

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
  - **Status**: every bank module (online/offline, security on/off) first, then pending revocations and
    active blocks.
  - **Take a module offline / bring it online.**
  - **Security off / on** for a module: with security off, the module needs no code; its use is logged
    as "Anonymous ... (open access)" (the workstation is still stored for Trace) and open use has full
    access to that module. The Firewall's own security cannot be switched off.
  - **Block an address** for 60s (`blockSec`), or **Unblock** it early. A blocked workstation cannot use
    any system, connect to hosts or log in to workstations (private messages still work). A blocked system
    address (a bank system or the unregistered host) cannot be used by anyone. Logged in the Master Log only.
  - **Revoke all access** for an address: a confirmation ("irreversible"), then a 30s countdown
    (`revokeCountdownSec`) that can only be cancelled from the Firewall (**Cancel a revocation** by id).
    **Only one revocation counts down at a time**, bank-wide: starting another is refused, naming the
    one in progress, until it completes or is cancelled.
    When it runs, the address is blocked permanently, and a workstation's owner loses every bank credential
    and is terminated. It cannot be undone. Completing it on a bank system ends the game with no winner; on
    the unregistered host, the White Hats win.
- **Security alerts**: every Firewall action that weakens the bank, and every credential issued or revoked,
  raises a Master Log alert naming the credential owner, like the log entry it points at.
  - **Suspicious security activity** (tier 2, so Alert mute can hide it): blocking an address, switching a
    module's security off, taking a module offline, issuing a credential, revoking an ordinary credential.
  - **Fatal security activity** (tier 3, never muted): starting a "revoke all access" and its going through
    (with how many of the owner's credentials it revoked); issuing a **security write** credential;
    starting to revoke one and its going through.
  - Undoing things (unblock, security on, back online, cancel a revocation) raises no alert.
- **Master Log**: filters **Player activity**, **Everything**, **Alerts** (failed codes, revoked or
  out-of-scope attempts, failed workstation logins, traffic to an unregistered host, without its address,
  security alerts);
  **Trace a log entry**.
- **Employee Records**: name, role, workstation IP (each workstation gets a random, distinct
  `10.1.0.x` address every game), listed in address order (so a planted user sits wherever their
  address falls), and per workstation: **last activity** (from the
  machine, not the credential), **failed attempts** (all game), **LOCKED OUT** and **BLOCKED** status.
  **Reset a lockout** unlocks a workstation at once (needs Employee Records write: IT Specialists).
- **Permissions**: view active or all credentials, with readable scopes such as "Read & write ·
  Settlement"; issue a credential; revoke one by id. Bank credentials are numbered C1, C2... with no
  gaps at the start of the game: the unregistered host's credentials are a separate series (X1, X2...)
  and workstation logins another (W1, W2...), neither listed here. A gap in the C ids that appears
  later is something hidden, e.g. a credential made by Unlock workstation.
  - **Security write** credentials (write access to the Firewall, to Permissions, or to all of Security)
    are not revoked at once: a 30s countdown (`revokeCountdownSec`) starts, the owner is told, and the
    credential keeps working until it ends. Anyone with Permissions write can **Cancel a revocation** by
    credential id, including the owner with the very credential under threat. Pending ones head the view.
    This stops a Black Hat quietly locking the bank's security staff out of their own tools.
  - Every other credential is revoked immediately.
- **Master Log live monitor:** "Auto-update every second" refreshes the view in place. Opening the view is
  logged as usual; the refreshes are not (the engine only allows a quiet refresh of a view the player has
  already opened with a logged read). Running a Trace switches auto-update off (the terminal says so), so
  the trace result is not scrolled away.
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
  90 seconds on average (`requestEverySecPerBanker`; bank-wide that is `requestIntervalSec`, e.g. every
  23s at 10 players), faster or slower with the time of day, each from a random customer. 70% ask for a
  payment (sized to what the account holds, and to a payee picked by wealth; see Payment pipeline); 30%
  (`requestChangeShare`) ask to add an account, add one and make it primary, make an existing account
  primary, or remove an account.
- Requests are written in words ("send $1.2M from our main account to Northwind Freight", or "from our
  account 45515"), never customer codes: acting on one means looking up the account and the payee's tag.
- Client Data > Client Requests: **View** (Open / All) shows a Personal Banker the requests addressed to
  the **credential owner**, so a borrowed code shows its owner's inbox. Anyone else (the Bank Manager, or
  a whole-system Client Data credential) sees every banker's requests. **Archive** sets one aside without
  acting and needs a reason; you can only archive requests you can see. Archiving is not final (see
  Deadlines).
- A request is **Done** when the matching action is made with its Request ID: Create payment, Add account
  (for add / add-as-primary requests), Set primary account, or Remove account. The kind must match. Anyone can link a request; the link shows on the payment
  ("for REQ-7") in every view and in its history. Linking is not blocked when the payment differs from
  what was asked, but only a payment to the requested payee for the requested amount counts toward the
  bank's target (see Win conditions). The originating account is not checked. Open and archived requests
  can be linked; expired ones cannot.
- **A payment made exactly as asked** (a manual payment from one of the customer's accounts, to the
  payee, for the amount, made after the request arrived) answers the request even without its id, and
  even if the request was archived: it is linked automatically at the request's halfway point, its
  deadline, or settlement, whichever comes first, and counts toward the bank's target.

### Deadlines, follow-ups and complaints

- Every request has a **deadline**: 2 minutes (`requestDeadlineSec`), or 1 minute (`urgentDeadlineSec`)
  for an **urgent** payment request (25%, `urgentShare`; its wording says it is urgent). The view shows
  URGENT and the time left.
- **Halfway there**, if what was asked has not happened, the customer **follows up**. The follow-up is
  added to the same request (the original wording stays) and tagged REMINDER, and the request moves to
  the top of the Open view. The banker also gets it as a personal message from the customer. A follow-up
  **reopens an archived request**, showing who archived it and why. So an archived request that comes
  back had a real customer behind it.
- "Has it happened" means: for an account request, the customer's accounts are as asked (whoever did it,
  linked or not); for a payment request, a payment for it exists that was not rejected, failed or
  reversed. If a linked payment falls through before the follow-up, the request comes back too.
- At the **deadline**, a request whose ask has not happened **expires** (EXPIRED, or stays ARCHIVED if it
  was archived; either way it can no longer be linked). The customer takes a **strike** and writes to the **Bank Manager**, naming the banker who had
  the request; the Master Log records "Customer complaint: REQ-7 expired". Archiving alone is not a strike:
  only the ask not happening by the deadline is.
- On a customer's **second strike** (`strikesToSuspend`) they **stop doing business with the bank for the
  day**: they write to the Bank Manager and their banker, show as SUSPENDED in Customer Records, and send
  no more requests; automatic payments no longer come from or go to them. Their accounts and money stay.
  Payments already in the queue carry on. Losing a customer shrinks the bank's volume, and the margin
  over the target is small.
- Customer messages come from a **contact**: a made-up first name for a company ("Cody (Cobalt Payroll)")
  or the person themselves for a private customer. Requests, follow-ups (normal and urgent), complaints
  and walkouts are each picked from a set of 6-10 form messages ("This is Cody from Cobalt Payroll.",
  "Regarding the payment to ...", ...).
- **Scam requests** (Social / Scam request) are worded from the same form messages as real requests
  (the operative picks the customer and what is asked, not the text). They show a deadline like any
  other (the urgent one for an urgent payment), but no customer ever follows up or complains: they
  expire quietly, with no strike. A payment made for a scam request never counts toward the bank's
  target, even when it matches the payee and amount.
- **Phishing:** every Personal Banker also gets 1-5 obvious scam messages per game (`phishPerBankerMin`/
  `Max`) at random times, from a set of tropes (the prince with a frozen fortune, the rich kid whose dad froze
  his cards, the lonely bride who needs a plane ticket, the lottery win, the stranded friend, ...). They
  arrive in Client Requests like any request, from a made-up sender, claim a customer tag that does not
  exist, name no account to pay from, and ask for money to go to an account that does not exist. They
  have no deadline and never expire: nobody chases them, and they stay open until someone archives them.
- A request past its deadline can no longer be acted on. An **archived request stays archived** at its
  deadline (the status never gives away whether it was real); a real customer still takes the strike and
  complains.
- Personal Bankers create the payments their customers ask for and approve them; Accounts &
  Receivables score risk and settle. A banker cannot verify their own account changes (Verification is
  read-only for them): Accounts & Receivables or the Bank Manager must.

## Notifications

- Every page listed below has a **bell** at the right of its breadcrumb bar, showing **On** or **Off**.
  With it on, the page pops up a notification at the bottom right of the screen, above the taskbar. A
  notification disappears after 5s or when tapped; nothing is kept.
- The bell can only be switched on, and only delivers, while the workstation holds an active **write**
  credential for that whole module (its own or one it knows the code of). Losing it silences the bell.
- It never reports activity recorded under your own name. Using someone else's code counts as theirs, so
  its owner is notified. Switching a bell on or off is not logged. There is no limit on bells.
- Each role starts with its usual bells on (`watch` in `ROLES`): IT Specialist: Employee Records;
  Personal Banker: Client Requests and Authorization; Accounts & Receivables: Verification, Risk Check and
  Settlement; Bank Manager: Master Log.
- A seat's desk opens with its workstation window on screen at the start of the game.

| Page | Notifies about |
|---|---|
| Firewall | any logged use, and a "revoke all access" going through |
| Master Log | every alert (that is not muted) |
| Employee Records | a workstation being locked out |
| Permissions | any logged use, and a credential revocation going through |
| Customer Records | account changes and verifications on customers you manage |
| Verification | an account change waiting to be verified |
| Client Requests | new requests and follow-ups from customers you manage (phishing and scam requests too) |
| Payment Queue | a payment created (automatic or manual) |
| Risk Check | a payment waiting for a risk score |
| Authorization | a payment waiting for approval |
| Settlement | a payment ready to settle |

A stage whose automation will take a payment is not rung for it.

## Workstations

- Every player's workstation IP is an address. Typing it into a window's address bar shows a locked
  login page. Only a **workstation credential** of that player logs you in; anything else (including
  their bank codes) is "Access denied.", logged, alerted and counts toward the lockout, like any other bad
  code.
- Every player starts with their workstation's own login (id `W1`, `W2`...). It shows only in their own
  credential list, never in Permissions, and it can never be changed or revoked (Revoke credential
  refuses it; "revoke all access" and termination leave it alone). Tell someone the code, or let it be
  read off your workstation, and that access is for good.
- **Access / Unlock workstation** makes another workstation credential (a normal `C` id) that is not
  listed in Permissions either: it shows only as a gap in the ids, and Revoke credential by id removes it.
- Logged in, you see their whole workstation read-only: profile, objective, job description (and a Black
  Hat's operative handbook), every
  credential they hold with codes, their activity log and messages. The session lasts until the
  credential you used is revoked (only possible for an unlocked one).
- Trace: the Master Log records "<owner> logged in to their workstation", named after the credential's
  owner, which is always the workstation's owner. Their personal activity log records the visitor's IP.

## Hidden host (Black Hat Database)

- Its address is random each game (`10.x.x.x`, never in the bank's `10.0`/`10.1` ranges); it is in every
  Black Hat's objective. Black Hats start knowing it (assumed: Black Hats do **not** start knowing who
  the other operatives are; they find each other on Blacknet).
- Host modules: **Blacknet**, **Target Ledger** and **Host Log** are shared: every operative starts with
  a credential for each. (The **Credential Cache** module is switched off: `CREDENTIAL_CACHE_ENABLED`.) The **tool kits** (Infiltration, Social, Cleanup, Access)
  are dealt at random each game: every operative gets exactly one. With more kits than operatives, the
  rest go unused; with more operatives than kits (15+ players), kits repeat so everyone has one. Operatives can tell each other
  kit codes like any other code.
- **Blacknet aliases**: every player is dealt a random hacker alias at the start (from 40 in
  `HACKER_ALIASES`, core.ts, never repeated in a game) and cannot change it. A post carries the alias of
  the credential's owner, so a borrowed code posts as its owner. A Black Hat sees their alias on their
  workstation profile and on the Blacknet page, and so does anyone who logs in to their workstation.
- **Target Ledger** is read-only: the total diverted against the goal, then each of the 3 mule accounts
  with the customer it is on (marked `(primary)` when it is that customer's primary) or `floating`, and
  its balance. It can auto-update every second like Blacknet.
- **Kit tools** (tier in brackets):
  - **Infiltration / Create proxy** (3): set up a typed, unused IP address as a proxy. An address already
    on the network (a workstation, planted or real, a bank system, the host, another proxy) is refused.
    Proxies are shared by every operative, and Reroute IP and Create user can only use proxies, so
    neither can borrow a real workstation's IP. A proxy is an address like any other: the Firewall can
    block it or revoke all access to it. Typing its address into a window's address bar shows a **Proxy
    relay** page: nothing to log in to, but it says whether traffic is going through it right now (a
    reroute is running) or it is idle.
  - **Infiltration / Reroute IP** (2): pick what to reroute (your own workstation by default, any other
    workstation's IP, or the server's own address), a proxy from the list and a number of seconds (1-60,
    10 by default). For that long the rerouted address shows as the proxy in **every** record: Master Log
    source IPs, alerts, and every trace clue at every tier (a loud tool's "exact IP" or "server's address"
    gives the proxy). Rerouting the server hides its address from the bank's clues. Routing (blocks,
    lockouts) stays on the real address, and a rerouted workstation looks idle in Employee Records. Each
    address has one reroute at a time: a new one replaces it.
  - **Infiltration / Create user** (2): plant a fake employee (typed name, a role, a proxy from the list)
    at the proxy's address. It shows in Employee Records and can be issued credentials like anyone else,
    but is nobody's seat.
  - A proxy is **unavailable** (the list says why, and both tools refuse it) while the Firewall blocks
    it, while another operative's reroute runs through it, or once a planted user sits at it.
  - **Social / Spoofed message** (2): a private message that appears to come from another employee (typed
    to, from and text). It lands only in the recipient's inbox, never the impersonated sender's history,
    so comparing notes exposes it; a made-up sender name shows as typed.
  - **Social / Scam request** (2): a fake Client Request from a customer to their banker, worded like
    real requests. It asks either for an account change (set primary, add and make primary, add, or
    remove an account) or for a payment (pay a typed payee a typed amount from the customer's main
    account, normal or urgent, up to the manual payment cap). It looks normal in the queue; the leak is
    the alert. Paired with a redirected payee primary, a scam payment sends a real customer's money to a
    mule.
  - **Cleanup / Log wiper** (2): hide one Master Log entry. It leaves a visible id gap, and a Trace still
    reaches it until it ages out.
  - **Cleanup / Alert mute** (3): for 10s, tier 1-2 alerts are dropped. Tier 3-4 alerts, including the
    mute's own, always get through.
  - **Access / Code crack** (2): pick a module; one digit of a random credential covering it is recovered
    about every 15s (a minute for all four), each leaving an alert naming the credential and its
    progress. The operative learns the credential when it completes. Revoking the credential or a timed
    block on the operative's workstation stops it.
  - **Access / Unlock workstation** (3): type a workstation IP. After 30s (`unlockSec`) that player gets a
    new workstation credential, and only the operative learns its code (in their activity log). The alert
    names the target's IP. A block on either end, the target or the operative (its real IP or the one
    recorded when it started, e.g. a proxy), stops it. The new credential is hidden from Permissions but
    leaves a gap in the C ids, and can be revoked by id.
  - **Access / Lockout bomb** (2): failed logins spoofed from the target's IP trip their lockout. Employee
    Records can reset it.
- Kit tools have no cooldowns or charges; each is balanced by its **exposure tier**, shown on its button:
  - noisy (tier 2): an alert pointing at the tool's "Unknown server activity" entry; a trace of it gives a
    vague clue;
  - loud (tier 3): an alert; a trace gives the operative's exact IP or the server's address;
  - reckless (tier 4): an alert; a trace gives the operative's IP and their host access code. (No tool
    is tier 4 at the moment.)
  Everyday host use (tier 1) raises no alert. Alerts never name anyone; the leak is in the trace, which
  gives the addresses as recorded: during a reroute, the proxy. Operatives get a Host Log warning for each
  alert. Alert mute drops noisy and other minor alerts (and their warnings) for 10s.
- **Host Log**: the host's own log, for operatives (and anyone who gets in). It records activity on the
  host named after the host credential's owner ("Anna: posted on Blacknet"; failed logins and bare
  connections are unnamed), and raises an alert whenever the bank traces one of the host's "Unknown
  server activity" entries, naming whose credential ran the trace and the clue the bank got.
- Every use of the host (and every Connect to its address) writes only a cryptic, nameless system entry,
  **"Unknown server activity"**, visible under the Master Log's **Everything** filter but not **Player
  activity**. Quiet live-monitor refreshes write nothing. Everyday host use raises **no alert**; only
  kit tools do (by exposure tier, above), and their alerts just point at the entry to trace.
- Failed code attempts on the host (unknown, revoked, wrong access) also write only "Unknown server
  activity". They still count toward the lockout and the failed-attempts total in Employee Records.
- **Tracing** an "Unknown server activity" entry ("routed through a relay.") returns one true but
  partial clue, chosen at random (entries from louder kit tools give more: an exact IP or the server's
  address at tier 3, the IP plus a host access code at tier 4):
  - a range of addresses holding four real workstations (planted users don't count; the origin is one of
    them unless it is a proxy): "The origin workstation is within 10.1.0.37-112." Workstation numbers are
    random, so the range is as wide as it needs to be. If no such range exists (a proxy off the
    workstation subnet), a pair is given instead.
  - a pair, the real one and a random decoy in random order: "one of two workstations: A or B."
  - one number of the server's address: "The server's IP address is x.143.x.x."
  - what was done: "Activity performed: posted on Blacknet." (also: read the board, viewed the target
    ledger, connected, failed login attempt)
- White Hats find the address from trace clues (one number of it at a time, or all of it from a loud
  tool's trace), use **Connect** to make the system appear, then need a credential: guess one, get one
  from a reckless tool's trace, be told one, or find one on a Black Hat's workstation. Permissions
  cannot issue host credentials.
- A Firewall "revoke all access" that completes on the host's address shuts it down, and the White Hats
  win (see Win conditions). A timed block only cuts the operatives off for its duration.

## Not implemented yet

See [BACKLOG.md](BACKLOG.md) for agreed and deferred work.
