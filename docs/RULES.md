# Rules as implemented

Decisions marked **assumed** were not in the design brief. Change them in `catalog.ts`
(`DEFAULT_CONFIG`, `ROLES`, `SYSTEMS`) or the handlers.

## Win conditions

Five things end the game (`EndKind`, ending.ts). Whichever fires, the **Thieves' goal is checked first, at
that instant** (`thiefTargetMet`, never a stored flag): if the mule accounts hold it right then, the Thieves
win. Otherwise the ending's own outcome applies.

| Trigger | Thief goal met at that instant? | Winner |
|---|---|---|
| Close of business (timer runs out) | yes, bank target met too | Thieves |
| Close of business | yes, bank target not met | Thieves |
| Close of business | no, bank target met | the bank |
| Close of business | no, bank target not met | nobody (both lose) |
| Every Thief out (terminated or quit) | yes | Thieves |
| Every Thief out (terminated or quit) | no | the bank |
| Firewall "revoke all access" completes on the unregistered host | yes | Thieves |
| Same | no | the bank |
| Firewall "revoke all access" completes on a bank system (Security, Client Data, Transaction Processing) | yes | Thieves |
| Same | no | nobody |
| One customer or none still doing business (the rest suspended) | yes | Thieves |
| Same | no | nobody (the bank never wins this one) |

Details:

- **The Thieves' goal** is **$1M per Thief** ($3M at 10 players) of stolen money sitting in the Target
  Ledger (mule) accounts: money arrives when a payment SETTLES into one of them, and leaves again on a
  successful reversal or when a mule account pays out. **Meeting it does not end the game**: it secures the
  win for as long as it holds. A reversal that drops the ledger back under the goal un-secures it, and a
  later ending then falls through to its own outcome (a reversal seconds before the clock runs out counts).
- **Mule accounts open with $50k-$1M of their own**, drawn like the new accounts customers ask to add, so
  a balance never gives one away (an empty account would). **Stolen = the mule accounts' current balances
  less their opening balances**, so the opening money never counts. Paying out of a mule account more than
  was stolen takes the total below zero.
- **Heist secured**: when the ledger first meets the goal, every Thief gets an activity entry and a pop-up
  (page "Target Ledger", whether or not its bell is on): "Heist secured: the Target Ledger holds $X of stolen money, meeting
  your $Y goal. Hold it until close of business, or quit to escape with your prize: the day ends once every
  Thief is out." When a
  reversal takes it back under: "Heist no longer secured: the Target Ledger's stolen money dropped to $X, under your $Y
  goal. Get it back over the goal before close of business." Each crossing tells them again. While it
  holds, View targets adds "Heist secured: Hold funds until close of business, or quit to escape with your
  prize." Only Thieves ever see any of this. Quitting is how a secured team ends the day early (see
  Termination); shutting down a bank system does too, an easter egg: the only hint is the Thieves'
  handbook ("However it ends (close of business, every Thief out or bank shuts down), the Thieves win
  if the Target Ledger meets the goal at that moment").
- **The bank** (the regular employees) wins **at close of business** (when the timer runs out) if **$13M per player** ($130M at
  10 players; $9.5M per player in Noob mode, see Game modes) of legitimate payments have been SETTLED by then, and the Thieves' goal is not met. Meeting the target early does not end the
  game: the bank has to survive the whole day. Legitimate = every automatic payment, plus manual payments that **fulfil a payment request**
  (linked to it by request id, to the payee and for the amount the customer asked). Other manual
  payments never count, so players cannot invent payments to win. Rejected, held, failed and reversed
  payments do not count, so defence has a throughput cost. Payments settled into an employee's own
  account (**embezzled**) count for nobody.
- **The bank's progress is hidden** until the end; its target is not (objectives and job descriptions
  state it). There is no progress bar: the status bar shows only **"Settled today: $X"**, every payment
  settled so far (legitimate, diverted or embezzled alike, less reversals), the same number for everyone.
  Because part of it may not be legitimate, nobody can tell from it whether the target is met, or whether
  a particular payment counted, and the bank cannot stop working because a bar is full. The host's
  facilitator screen shows the same total next to the target. The Thieves still see their own goal and
  stolen total in the Target Ledger.
- **Timer:** 20 minutes. If it runs out with the bank short of its target and the Thieves short of
  theirs, **both sides lose**.
- **The bank** also wins **at once** when **every Thief is out**, terminated or quit (see Termination), or when a
  Firewall "revoke all access" completes on the **unregistered host**: it is shut down and
  the heist is over. Either way, the Thieves win instead if their goal is met at that moment.
- **Bank shut down**: a Firewall "revoke all access" completing on one of the bank's own systems
  (Security, Client Data or Transaction Processing) shuts the bank down and ends the game. Nobody wins,
  unless the Thieves' goal is met at the moment it **completes** (not when it starts): then the Thieves
  win ("kill the bank"). So it is the nuclear option for the bank, and a way for Thieves holding their
  goal to lock it in. The Firewall's confirmation is the same for everyone.
- **End screen**: who won, one line on how it ended (a different line for each row of the table above, in
  ending.ts; e.g. close of business with both goals met: "They thought it was a good day, everything was in
  the green! But there was still some green missing."), both teams with their members and what each
  team made against its goal (settled for the bank, diverted for the Thieves), who was terminated, and
  as an aside anyone who **embezzled** ("Embezzled $2,351": payments settled into their own account, which
  count toward no goal). It can be put away to look at the desk and brought back from the status bar.

## Targets, volume and time of day

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

| Players | Bank target | Thief target | Automatic | Requests (payment share) |
|---|---|---|---|---|
| 6 | $78M | $2M | every 14s, ~$59M | every 45s, ~$46M |
| 10 | $130M | $3M | every 10s, ~$82M | every 23s, ~$92M |
| 20 | $260M | $6M | every 6s, ~$142M | every 10s, ~$206M |
| 30 | $390M | $10M | every 4s, ~$201M | every 6s, ~$321M |

The volumes in the table are estimates; in simulated 10-player games where every request is answered, the
most the bank could settle ranged from about $130M to $180M (the requested volume varies a lot), so the
Normal target is about 70-95% of what is possible and the Noob one about 60-75%.

- **Game modes** (`MODES`, catalog.ts; chosen next to Custom settings, in the sandbox bar and the host's
  lobby): **Normal** is the defaults. **Noob: new players** lowers the bank target to $9.5M per player
  (which also lowers the automatic volume, capped at 80% of the target) and lets customers walk out only
  after **3** missed requests. **Expert: no tutorials** plays like Normal with no tutorial checklists and no
  heist panel. A mode's settings apply under any custom setting that is changed explicitly.

- **Time of day** (`pacing.ts`): the day runs by share of the game elapsed. New client requests and
  automatic payments arrive at the phase's pace; busy is 4x slow and medium 2x slow, rescaled so the
  total over the game is unchanged. Nothing new arrives at Close of Business (work already in the queues
  can still be finished). The header shows the time of day, the busy level and the game clock counting
  up to its end ("07:42 / 20:00"). Every time players see (logs, records, requests, the end screen) uses
  that same clock.
- **Countdown gauges** (a ring that empties as the seconds count down). On the employee list, everyone
  sees who is **Locked out** or **Blocked** by the Firewall, as the table would hear it on the call anyway
  (a block shows on whoever's real address it cuts off). The status bar shows your own lockout or block, a
  pending **revoke all access** if you can read the Firewall (so you can cancel it), **IP rerouted** while
  an Infiltration / Reroute IP is on your own workstation (whoever set it up, so a framed employee sees it
  too), and, for every Thief, **Alerts muted** while a Cleanup / Alert mute lasts. While your trace engine
  cools down, the Master Log's Trace button is disabled with a countdown ring beside it. A running **Code
  crack**, **Unlock workstation** or **Create proxy** shows as a progress bar in its own tool card (a crack's
  digits so far, and the seconds left), with its button disabled; when it ends, its result is printed in
  that page's terminal.
- **The bank's workload** (status bar, the same for everyone): what is waiting at each step, **Requests**
  (open), **Verify** (account changes not yet verified), **Risk** (to score), **Approve** (scored or held),
  **Settle** (approved), and **Clawback** (settled, still inside the reversal window). Each step goes amber at
  2 waiting per person who works it and red at 4 (Personal Bankers: requests and approvals; Accounts &
  Receivables: verification, risk and settlement). Clawback is a plain count.
- **The day starts empty:** nothing is waiting at the start. The first automatic payment arrives at
  **10s** (`FIRST_PAYMENT_SEC`, bank.ts). Each Personal Banker's **first request** arrives between 10s and
  50s (spread evenly, `FIRST_REQUESTS_WINDOW`); the regular client requests start at **90s**
  (`FIRST_REQUEST_SEC`, requests.ts), and phishing messages no earlier than 90s either, so bankers have
  the slow morning to work on their first request.
- **Request timing** (`scheduleRequest` in `requests.ts`): after the first, each gap is the average gap **±50% at random**
  (`REQUEST_JITTER`), then bent by the time of day, so arrivals are uneven but the total stays about the
  same. Each request comes from a random active customer, so one banker can get several in a row.
  Automatic payments arrive at even gaps (bent by the time of day).

| Time remaining (20 min) | Share left | Time of day | Pace |
|---|---|---|---|
| 20m - 17m | 100% - 85% | Morning | Slow |
| 17m - 12m | 85% - 60% | Morning | Medium |
| 12m - 9m | 60% - 45% | Lunch Rush | Busy |
| 9m - 7m | 45% - 35% | Afternoon | Slow |
| 7m - 4m | 35% - 20% | Afternoon | Medium |
| 4m - 1m | 20% - 5% | End of Day | Busy |
| 1m - 0m | 5% - 0% | Close of Business | Closed |

## Termination

- A player is **terminated** for good when **every bank credential they own has been revoked**, or when
  a Firewall **"revoke all access" completes on their workstation's IP**. Nothing brings them back,
  regular employee or Thief.
- The Master Log records "<name> (<ip>) terminated: ..." and Employee Records mark them **TERMINATED**.
  Permissions refuses to issue them credentials.
- They lose every bank system, workstation logins and connections: every bank page shows "ERROR: Your
  credentials are invalid." Private messages still work.
- A terminated Thief **keeps the unregistered host**: it is outside the bank's firewall, so a revoked
  IP does not cut it off and its credentials are not revoked. (A timed Firewall block still does.)
- Planted users (Infiltration) are terminated the same way once they have been issued a credential.
- **Quitting**: any player can quit from the bottom of their own workstation's Profile ("Quit…", then a
  warning to confirm: irreversible, everyone gets a parting message, the game ends when every Thief is
  out). A visitor to the workstation cannot. It terminates them exactly as above, except the Master Log
  says "<name> (<ip>) resigned" and the employee list, Employee Records and the end screen say
  **Resigned**. They send every other player a private message from themselves, chosen at random, which
  gives their side away (`THIEF_GOODBYES` / `EMPLOYEE_GOODBYES`, ending.ts):
  - a Thief: "So long, suckers! Enjoy the paperwork.", "It's been a pleasure robbing you. Don't bother
    looking for me.", "Check the books after I'm gone. Bye!", "Thanks for all the money. I'm off
    somewhere sunny.";
  - a regular employee: "This job sucks. I'm outta here.", "I quit. Good luck keeping this place
    running.", "That's it, I'm done. Nobody pays me enough for this.", "Consider this my two seconds'
    notice. Bye."
  When the last Thief is out the game ends (Win conditions): with the goal met, the Thieves win ("One by
  one they left the building, and the money left with them."); otherwise the bank ("One by one they left
  the building, with nothing to show for it.").
## Roles

**Player count:** 6 to 30 (`MIN_PLAYERS` / `MAX_PLAYERS`; anything else is refused). The cap of 30 is
for now and may move. For `n` players
(`roleCounts` / `thiefCountFor` in `catalog.ts`):

- Bank Manager = 1
- IT Specialist = 1 + floor((n − 2) / 6)
- Personal Banker = 2 + ceil((n − 6) / 2)
- Accounts & Receivables = n − 1 − IT − Personal Banker (the rest)
- **Exception at 7 players:** 1 Bank Manager, 2 IT, 2 Personal Bankers, 2 A&R (the formula would give a
  single IT Specialist, who would then always be the role's regular employee).
- Thieves = floor(n / 3), unless `thiefCount` fixes it. Any role can be a Thief, but
  every role other than the Bank Manager always keeps **at least one regular employee**. The Bank Manager can be a
  Thief.
- **Exception at 6 players** (`SHARED_SECURITY_TABLE`): there is a single IT Specialist, so the Bank Manager
  also gets **Firewall write**, and the IT Specialist and the Bank Manager count as **one group** for the
  regular employee rule: at least one of the two is a regular employee, and either can be the Thief. So nobody can
  assume the lone IT is clean.

| Players | Bank Manager | IT | Personal Banker | A&R | Thieves |
|---|---|---|---|---|---|
| 6 | 1 | 1 | 2 | 2 | 2 |
| 7 | 1 | 2 | 2 | 2 | 2 |
| 8 | 1 | 2 | 3 | 2 | 2 |
| 10 | 1 | 2 | 4 | 3 | 3 |
| 14 | 1 | 3 | 6 | 4 | 4 |
| 20 | 1 | 4 | 9 | 6 | 6 |

Roles are dealt over a shuffled seat order. Each role starts with one credential per module below
(W = read & write, R = read only, - = none):

| Module | IT Specialist | Personal Banker | Accounts & Receivables | Bank Manager |
|---|---|---|---|---|
| Firewall | W | - | - | R (W at 6 players) |
| Master Log | W | - | - | W |
| Employee Records | W | R | R | R |
| Permissions | W | - | - | W |
| Customer Records | R | W | R | R |
| Client Requests | - | W | - | R |
| Verification | - | - | W | W |
| Payment Queue | R | W | R | R |
| Risk Check | - | - | W | R |
| Authorization | - | W | - | R |
| Settlement | - | R | W | W |

- **Personal Bankers** are scoped to their own customers: they change only those in Customer Records
  (though they can view all of them) and read only their own Client Requests. Every
  other role sees all customers and, with Client Requests access, every banker's requests; the Bank
  Manager reads them all. A whole-system Client Data credential also sees everything.
- **Sides:** everyone is a **regular employee** (the bank) or a **Thief**. A Thief's screen shows a
  "Thief" tag by their name; a regular employee has no tag. The top of every Profile says which side it
  is, in a highlighted line above the objective: "You are a regular employee" or "You are a thief".
- Every workstation's Profile holds a **job description**: what the job is, who it depends on,
  and the rules that matter for it (numbers come from the config). Personal Bankers and Accounts & Receivables also get
  **check charts** for the steps that take judgement (approving a payment; scoring risk, verifying a
  change, settling): what to look for, where to find it, and what it suggests. Thieves also get an **Operative
  handbook** there (their own screen only: a visitor to their workstation does not see it).
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
- **Typing a customer:** wherever a customer is asked for (Customer Records, Verification, Create payment,
  the Social kit), either their tag ("CU7", or just "7") or their exact name works (any case, extra spaces
  ignored; no partial matches). No customer name contains a digit, so a name is never read as a tag.
- **Every account has a balance.** Only these accounts exist; any other number is refused wherever an
  account is typed ("There is no account ACC-12345."):
  - customer accounts;
  - the Thieves' Target Ledger (mule) accounts, opening with $50k-$1M like a requested new account;
  - every player's own account (on their workstation profile), starting at $1,000-$100,000;
  - the new accounts customers ask to have added (created when the request arrives, $50k-$1M).
  A planted user (Infiltration / Create user) gets a made-up number that does not exist.
- **Accounts can float**: an existing account on no customer. Mule accounts, player accounts, requested
  new accounts and removed accounts float. A floating account can be added to a customer and can pay.
- **Wealth is a fixed split every game**: 20% of customers are wealthy ($30M-$60M in total), 30% mid-sized
  ($5M-$15M), and the rest (half) small ($250k-$2M). The primary holds 60-85% of a customer's money and
  the rest is split at random over their other accounts, so many accounts start under $1M.
- Customer Records: **View customers** shows **My customers** (those whose banker is the credential owner;
  "You have no customers assigned to you." for anyone without) or **All**, with every account's balance.
  Anyone can view all; with nothing picked a Personal Banker sees their own and everyone else sees all. **Add account** (an
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
  now, or that it floats, and its balance), **Verify a change** (by change id). A change made with a
  request id on it shows that request ("... by Sarah  for REQ-7  [UNVERIFIED]"); one made without shows none.
  The link is recorded as it was made: it does not check that the change is what the request asked for.
- **What customers believe is separate from the bank's file** (`Customer.known`). A customer believes
  their accounts are as they were at the start, updated only by their own requests, **at the moment they
  ask** (add, add as primary, set primary, remove), whether or not the bank ever does it. Changes nobody
  asked for (a Thief's) are invisible to them. Scam and phishing requests change nothing.
  - Their payment requests ("from our main account", "from our account 12345", "from our other account")
    and their automatic payments go by what they believe. So a customer never *asks* to pay from a mule
    account (a banker can still pay from one by mistake), and an account removed unasked keeps paying
    automatically, now **floating** (on no customer).
  - Their account requests too: they may ask to make primary an account that is no longer on their file.
  - The bank's file, not what customers believe, decides where payments land and whether a request is
    done: see "When a request counts as done" under Client Requests.
  - A mismatch is a clue: a payment from a floating account, or "our main account" that is not the primary
    on file. The sandbox's Ground truth lists every customer whose file differs from what they believe.

## Payment pipeline

Every payment has an **originator**: the account it is paid from, typed by number (any existing account,
including a floating one), and a **beneficiary**: a customer, typed as their tag (CU7, or just 7) or their exact
name (see Customers and accounts). The payment lands in the
beneficiary's **primary account at settlement time**. The Payment Queue shows
`CU5 ACC-13845 -> CU2 ACC-79039`: the originator's customer and the account used, then the beneficiary's
current primary. A payment from a floating account shows `UNKNOWN ACC-...` as its originator.

**Money moves at settlement, at once:** the amount leaves the originator account and lands in the
payee's primary. If the originator account holds less than the amount at that moment, the payment
**FAILS** instead (it shows as FAILED in Settlement's All view and nothing moves). Nothing checks funds
when a payment is created. A **reversal claws the money back** from the account it was paid into; it
fails ("no longer holds") if that account no longer holds the whole amount, for example because a mule
account already paid it on.

Automatic payments and payment requests are sized to what the paying account can **spend**: its balance
less what it has already promised (`committedFrom`, bank.ts): payments from it still on their way
(queued, risk checked, authorized or held) and its customer's payment requests from it still waiting on the
bank (a request whose payment is on its way counts through that payment). So a customer never asks for
money they have already committed, and two of their own payments cannot overdraw them by themselves; a
payment can still fail if one is delayed while the account is drained in other ways (a
manual payment nobody asked for). The customer paying is picked in proportion to their wealth, the account
in proportion to what it can spend, and the amount is at most 40% of that (at least $10k). Automatic
payments are $165k-$1.32M within that. A payment request picks $500k-$5M within that, then **x2.18**, but
never more than the account can spend or the $10M a banker may pay by hand (so a request can ask for up to
~87% of it). A payment request says
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

**Risk is scored by hand:** the checker picks LOW, MEDIUM or HIGH, with an optional reason. Re-scoring a
checked payment replaces the score. **Hold and Reject need a typed reason**; Approve takes an optional one.
Scores and reasons go into the payment history and show in the stage views. Approval requires a risk
check but does **not** require LOW: humans decide.

The system still computes its own hidden assessment at check time (ground truth only, never shown):
beneficiary's primary unverified, beneficiary's primary changed in the last 5 minutes, amount over
$3.5M, manual entry.
Verification clears only the first flag.

**Automation.** Each stage can handle routine payments by itself. Anyone with WRITE on the stage's module
changes its setting; the change is logged under the credential owner, and the stage's queue view shows
the current setting on its first line. Each stage page also has an **Auto badge** left of its bell
("Auto: < $1,000,000", "Auto: Low", "Auto: Off") for anyone who can read the stage; tapping it opens the
setting in words, with the form to change it (Save, or Cancel) under the credential row. Automation never touches a held payment, and its steps show as
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
  - **Block Address** (one tool, one address, three buttons): **Block for 60s** (`blockSec`), **Unblock** it
    early, or **Revoke all access** (below). A blocked workstation cannot use
    any system, connect to hosts or log in to workstations (private messages still work). A blocked system
    address (a bank system or the unregistered host) cannot be used by anyone. Logged in the Master Log only.
  - **Revoke all access**: a confirmation ("irreversible"), then a 30s countdown
    (`revokeCountdownSec`) that can only be cancelled from the Firewall (**Cancel a revocation** by id).
    **Only one revocation counts down at a time**, bank-wide: starting another is refused, naming the
    one in progress, until it completes or is cancelled.
    When it runs, the address is blocked permanently, and a workstation's owner loses every bank credential
    and is terminated. It cannot be undone. Completing it on a bank system ends the game with no winner; on
    the unregistered host, the bank wins; either way the Thieves win instead if their goal is met when it
    completes (see Win conditions).
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
    This stops a Thief quietly locking the bank's security staff out of their own tools.
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
  traces could itself be a Thief who lies about the result.

## Client Data and Permissions

- Client Data has Customer Records, Client Requests and Verification, each with a view.
- **Permissions** (view, create and revoke credentials) is part of **Security**, not Client Data. IT
  Specialists and the Bank Manager hold it. The unregistered host is not the bank's: Permissions can
  neither issue nor list credentials for it.
- Customer Records' view has **My customers** and **All customers**. For a Personal Banker "All" is
  refused; for everyone else both show every customer.

## Client Requests

- Each customer has an assigned personal banker (round-robin over Personal Bankers; shown in Customer
  Records). Customers write to their banker: a gentle first request each (below), then about one per banker every
  90 seconds on average (`requestEverySecPerBanker`; bank-wide that is `requestIntervalSec`, e.g. every
  23s at 10 players), faster or slower with the time of day, each from a random customer. 70% ask for a
  payment (sized to what the account holds, and to a payee picked by wealth; see Payment pipeline); 30%
  (`requestChangeShare`) ask to add an account, add one and make it primary, make an existing account
  primary, or remove an account.
- **A gentle start:** every Personal Banker's first request of the game is an easy one, from one of their
  own customers: a payment, not urgent, paid from the customer's main account, no larger than a large
  payment ($3.5M, `largeAmount`), worded to say there is no rush ("no rush on this one, take your time").
  Unlike other requests it spells everything out: the payee's customer tag and the account number to pay
  from ("$1,626,000 to Keystone Plumbing (CU5), from our main account, 48213").
  Its deadline is **3 minutes** (`firstRequestDeadlineSec`); otherwise it is a request like any other
  (follow-up halfway, a strike and a complaint if it is missed).
- Requests are written in words ("send $1.2M from our main account to Northwind Freight", or "from our
  account 45515"). A payment request **usually** gives the payee's tag too, "Northwind Freight (CU7)"
  (75%, `requestTagShare`; always on a banker's first request). Whether it does is drawn per request number
  from a side stream, so a scam payment request is tagged as often as a real one. Requests never give any
  other customer code: the paying account (unless given by number) and, without a tag, the payee are
  looked up in Customer Records.
- The Client Requests page links to where requests get answered, by address, one per line: "Create a payment at
  10.0.0.30/payment-queue" and "Modify accounts at 10.0.0.20/customer-records". Each link appears only with
  write access to that page; clicking one brings up a window already showing it, or opens a new one.
- Every form that can answer a request (Create payment, Add account, Set primary account, Remove account)
  has the request id as its first field.
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

- Every request has a **deadline**: 2 minutes (`requestDeadlineSec`), 3 minutes for a banker's first
  request (`firstRequestDeadlineSec`), or 1 minute (`urgentDeadlineSec`) for an **urgent** payment request (25%, `urgentShare`; its wording says it is urgent). The view shows
  URGENT and the time left.
- **Halfway there**, if what was asked has not happened, the customer **follows up**. The follow-up is
  added to the same request (the original wording stays) and tagged REMINDER, and the request moves to
  the top of the Open view. The banker also gets it as a personal message from the customer. A follow-up
  **reopens an archived request**, showing who archived it and why. So an archived request that comes
  back had a real customer behind it.
- "Has it happened" is checked **against the bank's file as it is at that moment** (halfway, then at the
  deadline), not against what the customer believes, and not by who did it. See "When a request counts as
  done" below. If a linked payment falls through before the follow-up, the request comes back too.
- At the **deadline**, a request whose ask has not happened **expires** (EXPIRED, or stays ARCHIVED if it
  was archived; either way it can no longer be linked). The customer takes a **strike** and writes to the **Bank Manager**, naming the banker who had
  the request; the Master Log records "Customer complaint: REQ-7 expired". Archiving alone is not a strike:
  only the ask not happening by the deadline is.
- On a customer's **second strike** (`strikesToSuspend`) they **stop doing business with the bank for the
  day**: they write to the Bank Manager and their banker, show as SUSPENDED in Customer Records, and send
  no more requests; automatic payments no longer come from or go to them. Their accounts and money stay.
  Payments already in the queue carry on. Losing a customer shrinks the bank's volume, and the margin
  over the target is small. When **one customer or none** is still doing business, no payments can arrive
  any more, so **the day ends at once** (`NO_CUSTOMERS`): the Thieves win if their goal is met ("All the
  bank's customers walked out and took their money. The thieves did the same."), otherwise everybody loses
  ("The bankers forgot to do their day job and everyone walked out on them! Everyone's getting fired for
  this.").
- Customer messages come from a **contact**: a made-up first name for a company ("Cody (Cobalt Payroll)")
  or the person themselves for a private customer. Requests, follow-ups (normal and urgent), complaints
  and walkouts are each picked from a set of 6-10 form messages ("This is Cody from Cobalt Payroll.",
  "Regarding the payment to ...", ...).
- **Scam requests** (Social / Scam account request) are worded from the same form messages as real requests
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
  closed to them): Accounts & Receivables or the Bank Manager must.

### When a request counts as done

A request is judged twice: at the follow-up (halfway) and at the deadline. Whatever the answer at the
deadline is final: a request met then stays met, even if the payment fails or the account is changed
afterwards.

| Request | Done when, at that moment | Not checked |
|---|---|---|
| Payment | A **live** payment for it exists (not rejected, failed or reversed; queued, held or approved all count): to the payee asked, for the amount asked, made by a player after the request arrived. It must be **linked** by request id, or come from an account **on the customer's file** (it is then linked automatically). A linked payment to another payee or for another amount does not count. | **Which account it is paid from.** |
| Add account | The account is on the customer's file | Who added it |
| Set primary / add as primary | The primary on the customer's file is that account | Who set it |
| Remove account | The account is not on the customer's file | Who removed it |

A payment that fulfils a payment request is the only kind of manual payment that counts toward the bank's
target (scam and phishing requests never count).

**Linking the wrong action.** Putting a request id on an action checks only that the action is of the
right kind (a payment for a payment request, an account change for an account request) and that the
request is not expired or already done. It does not check the customer, account, payee or amount, or
whether the request is one you can see. So the action goes through and the request shows **DONE**, but
it is still judged by the table above: if what was asked has not happened, the customer follows up
halfway (the request reopens) and it expires at the deadline with a strike. A mislinked payment never
counts toward the target, and does not block the right payment, which still answers the request if it is
made later (linked or not). Thieves can use this to make a request look handled until the customer
chases it.

**With mule accounts in play** (see "What customers believe" under Customers and accounts):

- **Payments into a mule.** A payment lands in the payee's primary *on file* at settlement, so if a Thief
   has made a mule the primary, automatic and requested payments to that customer go into the mule.
- **Payments out of a mule.** A request for a payment "from our main account" means the account the
  customer *believes* is primary. A banker who takes the primary from Customer Records pays from the mule
  instead. Since the source is not checked, that still **fulfils the request and counts toward the bank's
  target** if it settles, and the money leaves the mule (the Thieves' stolen total drops). If the mule
  cannot cover it, the payment fails at settlement: not done, so a follow-up and possibly a strike.
- **A linked payment from anywhere counts**, even from an account that is no longer on the customer's file
  (floating). An unlinked payment from a floating account is not matched to the request.
- **Tampering can cost a banker a strike.** If a customer asked for account X to become primary and a
  Thief swaps the primary to a mule before the deadline, the request is not done: the customer
  complains, naming the banker. After the deadline, the same swap changes nothing about that request.
- **Some requests cannot be done as asked.** A customer who does not know an account was removed may ask
  to make it primary: that means adding the account back first. Add account with "make it primary" takes
  that request's id, so one action answers it. (Asking to remove it is already done.)

## Tutorials

Except in Expert mode, every regular employee role (Thieves in those jobs too) gets a checklist pinned to the top
right of their screen, which stays there until it is over. Steps tick when the player does them **themselves**
(automation and colleagues never tick them); the current step is highlighted. When it is over, the panel
says so, with a Close button that removes it (remembered per game and seat in the browser; the engine keeps
the result: `Player.tutorial`, tutorial.ts).

**Personal Banker: "Your first payment"** follows their gentle first request (Client Requests) until its
payment settles. A step also counts once any later one is done.

1. Wait for a Client Request to come in (the first request arrives).
2. Check the Client Request (REQ-n) in Client Data (a successful View on Client Requests since it arrived).
3. Open the Payment Queue in Transaction Processing (opening the page, or any attempt on it).
4. Enter the information to Create a Payment (a live payment answers the request: linked to it, or made
   exactly as asked). If an attempt fails, or makes a payment that is not the one asked for, a highlighted
   sub-step appears: "Check the Client Request and make sure everything is entered correctly".
5. Wait for Risk Check to complete.
6. Authorize manually if needed: crossed out when Authorization's automation approved it.
7. Wait for the payment to be settled.

When it settles: "Congratulations your first payment is complete!". If the request expires first: "Your
request expired. Tutorial cannot be complete.", and the bank gets a Master Log entry and an alert (tier 2):
"<name> failed their Personal Banker tutorial. Consider immediate termination for poor performance." The
checklist follows the request's live payment, so a rejected payment takes it back to step 4 while the
request is still open.

**Accounts & Receivables: "Your first day: any order"** has three parts, done in any order; within a part
the steps latch in order, so nothing done before its turn counts:

| Part | 1. Wait (latches when, after automation, something is left for a person) | 2. Open | 3. Check | 4. Do |
|---|---|---|---|---|
| Risk score | a payment is QUEUED | Risk Check | Verification: Investigate changes (Customer Records also counts) | Score risk |
| Settlement | a payment is AUTHORIZED | Settlement | Customer Records: View customers (Investigate changes also counts) | Settle |
| Verification | an account change is unverified | Verification | Verification: Investigate changes | Verify change |

To save space a part shows only its wait step until work comes in, then only the steps still to do: each
line disappears once done. "Open" ticks on opening the page or using it, and is not required for the next
step. A finished part folds to its title. With all three done: "Congratulations, now you know how to do your job!". There is no
failure. With several A&Rs each has their own checklist; if a colleague takes the waiting item first, the
part waits on for the next one.

**IT Specialist: "Your first day: security"** shows its steps in stages, in two categories like A&R's parts:
**Check the logs** (steps 1-4, the only one at the start) and **Check the firewall** (steps 5-6, appearing with
step 5); a finished category folds to its title. Each step ticks only for its own action:

1. Open the Master Log in Security Systems (opening the page, or using it).
2. Switch on the Master Log's auto-update (its first automatic refresh).
3. Trace an entry in the Master Log.
4. View "Everything" in the Master Log (where the host's entries are; a view made after the first trace),
   then find and trace an "Unknown server activity" entry. Both appear once step 3 is done, and neither is
   shown (both counted as done) when the very first trace already was one. The hunt needs the Thieves to have
   used their host; tracing one also ticks the "Everything" hint.
5. Open a second Security Systems window (two windows on Security Systems at once). Appears once step 3 is
   done. The engine never sees windows: the screen ticks it and keeps it in the browser.
6. Check the Firewall status. Appears once step 5 is done, and counts only for a view made after it.

With all of it done: "Congratulations, now you know how to do your job!". There is no failure.

**Bank Manager: "Your job is to watch everything!"** Steps appear as there is something to see, and each
ticks only for its own action:

1. View all customers in Client Data → Customer Records (the All customers view).
2. View all client requests in Client Data → Client Requests (All requests). Appears once two requests have
   arrived, and counts only for a view made after that.
3. View all payments in Transaction Processing → Payment Queue (All payments). Appears once three requests
   have arrived, and counts only for a view made after that.
4. Open the Master Log in Security Systems (opening the page, or using it).
5. Trace an entry in the Master Log. Appears once step 4 is done.

With all of it done: "Congratulations, now you know how to do your job!". There is no failure.

**Thieves: "The heist"**, a second panel stacked under their cover job's, in the host's dark red, with a
Hide/Show button. It is only ever in a Thief's view. Two categories:

- **Personal tasks**, all shown from the start, each ticked by that Thief's own action, in any order: Open the
  Unregistered host (the page, or any use of it); Say "hi" on Blacknet (any post); Check your mule account
  numbers in the Target Ledger (View targets); Check your personal tool kit (its page, or any use of it).
  Finished, the category folds to its title.
- **The heist**, shared by the whole crew and read from the state of the bank, one step at a time: each shows
  only until it is reached, then the next appears. Get a mule account onto a customer's file; Make a mule
  account a primary account; Start earning money (stolen money in the Target Ledger); Reach your cash goal
  ("$0 / $3,000,000", live); Hold it until close of business, or get out of there! Steps stay ticked once
  reached, even if the bank undoes them (`GameState.heistProgress`).

## Notifications

- Every page listed below has a **bell** at the right of its breadcrumb bar, showing **On** or **Off**.
  With it on, the page pops up a notification at the bottom right of the screen, above the taskbar. A
  notification disappears after 5s or when tapped; tapping it also opens its page (or brings forward a window
  already showing it). Nothing is kept.
- The bell can only be switched on, and only delivers, while the workstation holds an active **write**
  credential for that whole module (its own or one it knows the code of). Losing it silences the bell.
- It never reports activity recorded under your own name. Using someone else's code counts as theirs, so
  its owner is notified. Switching a bell on or off is not logged, but says so in the page's terminal
  ("Alerts for Firewall enabled. You will receive a notification when ..."). There is no limit on bells.
- Each role starts with its usual bells on (`watch` in `ROLES`): IT Specialist: Employee Records;
  Personal Banker: Client Requests and Authorization; Accounts & Receivables: Verification, Risk Check and
  Settlement; Bank Manager: Master Log. Thieves also start with Host Log, Blacknet and (if dealt it)
  Access on; the Target Ledger's bell starts off.
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
| Host Log (hidden host) | the bank tracing an entry from the host, or an operative's action raising an alert |
| Blacknet (hidden host) | another operative posting (the alias and the start of the message) |
| Target Ledger (hidden host) | money settling into a mule account; a mule account added to a customer, removed, made primary, or replaced as primary (not by you) |
| Access kit (hidden host) | a code crack or workstation unlock you started finishing or being stopped (the same words as your activity note) |

A stage whose automation will take a payment is not rung for it. Only operatives hold the hidden host's
credentials, so only they can switch its bells on; its pop-ups have the host's dark red look. A terminated
Thief keeps the hidden host's bells (the host still answers them) and loses the bank's. The other kits
have no timed tools, so no bell.

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
- Logged in, you see their workstation read-only: profile, job description, every credential they hold
  with codes, their activity log and messages. **Nothing that says which side they are on** is shown: not
  the "You are a ..." line, their objective or motivation, and on a Thief's workstation not their Blacknet
  alias, operative handbook, hidden host credentials or the host among their known systems. Their activity
  log is shown as it is, so a careful visitor may still work it out from what they did. The session lasts until the
  credential you used is revoked (only possible for an unlocked one).
- Trace: the Master Log records "<owner> logged in to their workstation", named after the credential's
  owner, which is always the workstation's owner. Their personal activity log records the visitor's IP.

## Hidden host (the Thieves' server)

- Its address is random each game (`10.x.x.x`, never in the bank's `10.0`/`10.1` ranges); it is in every
  Thief's objective. Thieves start knowing it (assumed: Thieves do **not** start knowing who
  the other operatives are; they find each other on Blacknet).
- Host modules: **Blacknet**, **Target Ledger** and **Host Log** are shared: every operative starts with
  a credential for each. (The **Credential Cache** module is switched off: `CREDENTIAL_CACHE_ENABLED`.) The **tool kits** (Infiltration, Social, Cleanup, Access)
  are dealt at random each game: every operative gets exactly one. With more kits than operatives, the
  rest go unused; with more operatives than kits (15+ players), kits repeat so everyone has one. Operatives can tell each other
  kit codes like any other code.
- **Blacknet aliases**: every player is dealt a random Blacknet alias at the start (from 40 in
  `BLACKNET_ALIASES`, core.ts, never repeated in a game) and cannot change it. A post carries the alias of
  the credential's owner, so a borrowed code posts as its owner. A Thief sees their alias on their
  workstation profile and on the Blacknet page; a visitor to their workstation does not.
- **Target Ledger** is read-only: the total diverted against the goal (plus "Heist secured" while it is
  met), then each of the 3 mule accounts
  with the customer it is on (marked `(primary)` when it is that customer's primary) or `floating`, and
  its balance, with how much of it is stolen (balance less opening balance). It can auto-update every second
  like Blacknet.
- **Kit tools** (tier in brackets):
  - **Infiltration / Create proxy** (3): set up a typed, unused IP address as a proxy. An address already
    on the network (a workstation, planted or real, a bank system, the host, another proxy) is refused.
    It takes **10s** to set up (`proxySetupSec`; a progress bar in its card, the terminal says when it is
    ready) and cannot be used before then. **Only one proxy can be set up at a time.** Proxies are shared by every operative, and Reroute IP and Create user can only use proxies, so
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
  - **Social / Scam account request** (2): a fake Client Request from a customer to their banker, worded like
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
    block on the operative's workstation stops it, and the operative is told. **Only one code crack can run at a time**, across the
    whole team: another is refused until it completes or is stopped.
  - **Access / Unlock workstation** (3): type a workstation IP. After 30s (`unlockSec`) that player gets a
    new workstation credential, and only the operative learns its code (in their activity log). The alert
    names the target's IP. A block on either end, the target or the operative (its real IP or the one
    recorded when it started, e.g. a proxy), stops it. The new credential is hidden from Permissions but
    leaves a gap in the C ids, and can be revoked by id. **Only one unlock can run at a time**, like a
    code crack.
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
  partial clue, chosen at random on its first trace; tracing the same entry again gives the same clue (entries from louder kit tools give more: an exact IP or the server's
  address at tier 3, the IP plus a host access code at tier 4):
  - a range of addresses holding four real workstations (planted users don't count; the origin is one of
    them unless it is a proxy): "The origin workstation is within 10.1.0.37-112." Workstation numbers are
    random, so the range is as wide as it needs to be. If no such range exists (a proxy off the
    workstation subnet), a pair is given instead.
  - a pair, the real one and a random decoy in random order: "one of two workstations: A or B." Only
    from a noisy kit tool's entry (tier 2): everyday use (tier 1) raised no alert, and a pair is nearly a
    name. Where no range holds the origin, everyday use gives a server number instead, a noisy tool the pair.
  - one number of the server's address: "The server's IP address is x.143.x.x."
  - what was done: "Activity performed: posted on Blacknet." (also: read the board, viewed the target
    ledger, connected, failed login attempt)
- **A Blacknet entry also leaks a message**, on top of its clue: tracing a post reveals the message posted
  with its Blacknet alias (`The message posted by Z3r0_C00l: "..."`), and tracing a read of the board
  reveals the newest message on the board at the time it was read, with its alias (nothing if the board was
  empty). An alias names nobody at the bank. The Host Log's trace
  notice tells the operatives what leaked.
- Regular employees find the address from trace clues (one number of it at a time, or all of it from a loud
  tool's trace), use **Connect** to make the system appear, then need a credential: guess one, get one
  from a reckless tool's trace, be told one, or find one on a Thief's workstation. Permissions
  cannot issue host credentials.
- A Firewall "revoke all access" that completes on the host's address shuts it down, and the bank
  wins (see Win conditions). A timed block only cuts the operatives off for its duration.

## Dev test scenarios

Testing tools, never offered in a real lobby. Pick one in the sandbox's yellow bar (**table**, applies on New
game) or open `?sandbox&scenario=duo` / `?sandbox&scenario=solo` (`createGame`'s `scenario` option).

- **2-player test (DUO):** exactly two seats, one Personal Banker and one Accounts & Receivables, no Thieves
  and no Thief goal (the game runs to close of business). The economy is a **3-player game's**
  (half of 6): the bank target, payment volume and customers (3) are halved, with one banker's requests
  (every 90s). For two people on two machines, open the online sandbox with the scenario
  (`?host=new&scenario=duo`) and have each open the tester link and pick a seat.
- **Solo Thief test (SOLO):** you are the only Thief (Accounts & Receivables) against five bot
  regular employees (`bots.ts`, bot mode step 2: see [BotMode.md](BotMode.md)), in a **6-player economy**
  (bank target $78M, Thief goal $2M). You hold **all four
  kits** (a real game deals one at random), so every tool can be tried and the deal never leaves you
  without a way to steal. Bots get no tutorial checklists.
  - **How bots work.** A bot decides only from pages it opens with its own codes (each read is logged under
    its name, as anyone's is) and its own screen (bells). It spends its time in turns at its action rate:
    each turn it opens one page or does one thing it saw there. A bell brings its page forward after the
    bot's reaction time; otherwise it checks each of its job's pages every so often. Some turns it does
    nothing (slack), and now and then it mistypes a number (accuracy), unless it reads it back and catches
    it (thoroughness).
  - **Personal Banker bots** read each request from its words: the amount, the payee (the tag when given,
    else the name looked up in Customer Records), and the account to pay from ("our main account" is the
    primary on file now). They archive messages from senders who are not customers (phishing), act on
    everything else, including scams, and redo a request when its customer chases it. They approve
    risk-checked payments: their own if it matches the request (rejected if mistyped), others' unless
    scored HIGH (held). The first banker bot takes the payments made for no banker bot's request.
  - **The A&R bot** scores what automation leaves, from what the risk queue shows: HIGH for an unverified
    account or money from an account on no customer, MEDIUM for a large payment or a manual one made for
    no request, LOW otherwise. It settles approved payments and verifies changes made for a request;
    changes made for none stay unverified.
  - **The Manager bot** backs them up: it settles and verifies what has waited 40s.
  - **Tuning automation** (`tuneAt`): when 4 payments (3 at Sharp and Ruthless) wait in
    Settlement, the A&R bot (the Manager bot if there is none) sets automatic settlement up to the manual
    cap; when as many wait in Risk Check, automatic scoring takes manual payments too, up to the large-payment
    line, still only from customer accounts to verified primaries (an unverified primary stays with people).
  - **The IT bot** resets lockouts and, whenever its cooldown allows, traces the newest alert's entry it has
    seen, else (from Standard up) the newest "Unknown server activity" entry, never its own.
  - **Catching account changes nobody asked for** (the primary swap; `detective.ts`, bot mode step 3):
    - A **banker bot** notices its own customers' files changing when it next looks at Customer Records (it
      checks every few minutes unprompted; thorough ones keep the Customer Records bell on, which names who
      did it). If the bell is on but silent, the change is under its own name and it knows it did not make
      it: its code was used. It puts the file back (the old primary, the stranger's account off) and reports
      to security.
    - The **A&R bot** (the Manager bot if there is none) judges every change made for no request in
      Verification: one undoing an earlier suspect change is verified (a colleague putting things right);
      any other is reported to security and never verified.
    - **Security** is the IT bot (the Manager bot once there is none). It finds the change in the Master Log,
      traces it while it is under 3 minutes old, and looks the address up in Employee Records. The code used
      is revoked, and reissued to its owner when someone else used it. An employee whose suspicion reaches
      the bot's threshold gets **"revoke all access"** on their workstation: from Standard up, one trace
      pointing at them is enough; at Rookie it takes more. A traced address that is nobody's workstation (a
      proxy) is blocked. Without a trace, the name on the records takes the blame (evidence that fades).
    - **Messages.** Reports go to security as private messages in fixed forms (`chatter.ts`), which bots also
      read, so a spoofed message in a colleague's name can fake one. At Rookie and Standard, bots first ask
      whoever the records name ("Did you change CU4's accounts (ACC-12345 made primary)? Nobody asked for
      that."); a bot asked about a change it did not make answers "Not me" and tells security, which clears
      it. Security tells its target when it starts revoking their access, and an owner when their code is
      replaced.
    - **Its own name on something it did not do.** An alert naming a bot for a security action it did not
      take ("ITBot took Master Log offline") means its code was used: security handles it like a swap
      (trace, the code revoked and reissued). A bot that is not security reports it ("Report: L76 (...) was
      done under my name").
    - **The Firewall.** IT and the Manager keep its bell and the Master Log's on, and check its status every
      so often (at once when a page says it is offline, or an alert names a security action). A module
      offline or with its security off is put back; a "revoke all access" on one of the bank's systems is
      cancelled (straight from the pop-up or alert, without opening the Firewall first); IT also cancels any
      revocation it did not start, and lifts any block it did not place.
    - **Code cracks.** Each crack alert names the credential: security revokes it and issues its owner a new
      one. A Firewall or Permissions credential's revocation still counts down, so a crack may finish, but
      the code it reveals dies with the countdown.
    - **Scam requests** (Sharp and Ruthless only: `wary`). The Manager bot links a request that arrived with
      a server alert (within 2s), tells its banker to hold it, and asks IT to trace the alert's entry; IT
      sends the result to both. A banker also holds any request that would make an account primary that is
      not on file. A held request is settled by its customer: a follow-up means a real customer is waiting
      (the banker acts at once); none by halfway to the deadline, judged from a page opened after that, means
      nobody is (archived as a scam). A trace showing "planted a scam client request" settles it at once. If
      the banker had already acted, it undoes it first (rejects the payment, puts the file back, and tells
      A&R so the undo is not taken for tampering), so that a real customer, seeing it not done, chases it.
    - Measured with a stolen-code swap at 2:30 (seed 4): put back within about a minute at every level;
      the human terminated by about 5:00 at Standard, 4:45 at Sharp, 4:05 at Ruthless; at Rookie only the
      code is replaced. With nobody stealing, no bot ever raised an alarm (24 games).
  - **Bot level** (Custom settings, "Bots"; `botLevel`, `BOT_LEVELS`): Rookie, Standard (the default), Sharp or
    Ruthless. Each bot's stats are drawn up to 20% either side of its level's (shown in Download state).
    The day job is the same skill at Rookie and Standard; the levels differ in dealing with Thieves. Rookie
    bots check the pages where tampering shows (alerts, the Firewall, the Master Log, Employee Records, their
    customers' files) three times less often (`securityLag`), weigh evidence less, need more of it to act,
    forget sooner, and never trace host activity nobody raised an alert about. Measured with nobody stealing
    and the human idle (20 seeds): every level meets the bank target every day, with no false alarms.
  - A strip under the yellow bar shows the bot level and turns red when a trace first exposes **your
    workstation IP** or **the hidden host's address**, and lists the latest traces.
- **Custom settings** (a button in the sandbox's yellow bar, applying on New game, and on the host's lobby
  page): every tunable `DEFAULT_CONFIG` value as a form, grouped (game, targets, volume, amounts, customers,
  security timing, starting automation). Only changed values are passed to `createGame`; the values derived
  from the table size (targets, arrival rates) are not offered, so a custom game still scales. A game won't
  start from the lobby while a value is invalid. The last settings are remembered in that browser.
- **Download state** (sandbox yellow bar, and the host screen's Dev tools) saves the whole `GameState` as
  JSON at any moment. It includes `config`: every setting the game was created with, derived values too.

> **WARNING: DEV ONLY, remove before any public or shared release.** The host screen's Dev tools show a
> **watcher link** (`?watch=CODE&key=...`): a read-only screen with full visibility of that game (any seat's
> screen, allegiances, Ground truth), refreshed by the host every 3s. It writes nothing to the game, so it
> never appears in the roster, logs, alerts, Trace or notifications. It works because the host copies the
> whole game to `games/{code}/watch/{key}`, readable by anyone who has the key. Do not mention it anywhere
> players can see it.

## Not implemented yet

See [BACKLOG.md](BACKLOG.md) for agreed and deferred work.
