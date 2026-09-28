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

- **Tools for the kits.** The kits exist (Infiltration, Social, Cleanup, Access; see RULES.md) but are
  empty. Each tool is a function in a kit module plus a handler, like the rest of the game.
- **Balance by exposure, not limits.** No cooldowns and no limited charges. Instead, every Black Hat
  action raises an alert in the bank's Master Log, and stronger actions reveal more in that alert:
  - weakest: nothing beyond the usual "Unknown server activity" (traceable for partial clues);
  - stronger: a partial clue right away (the same kinds a trace gives);
  - stronger still: one exact fact (the acting operative's workstation IP, or the server's address);
  - strongest: the operative's exact IP and a working host credential (that operative's own code).
  What leaks is always about the operative who acted. Tools with a duration pick their exposure level
  by the duration chosen.
- **Host Log alerts for exposure.** The Host Log exists; once tools raise exposing bank alerts, the Host
  Log should also alert the operatives when one of them has been exposed.
- **Scam requests from the hidden host.** Black Hats can send fake Client Requests.
- **Log tampering from the hidden host**, not from the Master Log (which stays trustworthy): deleting
  an entry leaves the id gap visible, like offline gaps.

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
