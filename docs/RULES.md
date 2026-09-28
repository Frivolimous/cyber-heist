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

## Payment pipeline

Queue -> Risk Check -> Authorization -> Settlement. A payment is paid to the beneficiary's account
**at settlement time**, so editing a beneficiary can divert payments that were already approved.

Risk flags: unverified beneficiary, beneficiary edited in the last 5 minutes, amount over $3.5M,
manual entry. 0 flags = LOW, 1 = MEDIUM, 2 or more = HIGH. Verification clears only the first flag.
Approval requires a risk check but does **not** require LOW: humans decide.

Settled payments can be reversed for 3 minutes.

Target Ledger accounts are treated as the **destination** accounts for stolen funds (assumed reading
of "potential targets for fraudulent transactions").

## Security systems

- **Encryption layers are disabled** (`ENCRYPTION_ENABLED = false` in `catalog.ts`): the Firewall has no
  add/remove/bypass functions and function pages ask for no layer codes. The engine code remains.
  When enabled: encryption is per **module**, every layer code must be supplied, the Firewall itself
  cannot be encrypted, and bypass strips all layers and raises an alert.
- The Firewall itself cannot be taken offline (avoids unrecoverable soft-locks).
- A module taken offline rejects all use. While the **Master Log** is offline nothing is recorded but
  log ids keep counting, so the gap is visible.
- **Trace**: reveals the source IP of one log entry. Entry must be under 3 minutes old, 30s cooldown
  per player. Employee Records list every registered IP, so a trace can identify a person. That is
  strong on purpose; the analyst's role could itself be a Black Hat who lies about the result.

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
- Every access writes "connected to an unregistered host" to the Master Log (no address) and raises
  an Intrusion Detection alert that **does** name the address (throttled to one per 30s).
- White Hats find the address via alerts or info packets, use **Connect** to make the system
  appear, then need a credential: guess one (info packets leak its digits), get one shared, or have an
  IT Specialist create one. Credentials issued at game start for the host are not shown in the
  Permissions registry; ones created in-game are.
- Credential Cache lists White Hat credentials held by operatives.

## Info packets

One packet per player per system (40 for 10 players), drawn from per-system fact pools. Some facts
are shared by several players (redundancy), some are rules of the world, some are clues: the hidden
host address, two original beneficiary accounts, two mule accounts, four digits of one operative's
host code, one operative's IP. All facts are true.

## Not implemented yet

Personal Node hacking, fake or deleted logs, credential spoofing, function- or system-level
encryption, lobby, networking, neutral players.
