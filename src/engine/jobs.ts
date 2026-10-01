// Job descriptions: what each role does, who it depends on, and the rules that matter for it.
// Shown on the player's workstation (Profile). Numbers come from the game config so they stay true.

import { SHARED_SECURITY_TABLE } from './catalog';
import { money } from './core';
import type { Allegiance, GameConfig, RoleId } from './types';

export interface JobDescription {
  summary: string;
  duties: string[];
  dependsOn: string[];
  rules: string[];
  /** Charts for the steps that take judgement: what to look for, where to find it, what it suggests. */
  checks?: Checklist[];
  /** Thieves only: how to operate unseen. Their own screen only: a visitor to their workstation never sees it. */
  operative?: string[];
}

/** One step's chart. Every row is something a player can look up by hand with the role's own tools. */
export interface Checklist {
  title: string;
  intro?: string;
  rows: { look: string; where: string; means: string }[];
}

const row = (look: string, where: string, means: string): Checklist['rows'][number] => ({ look, where, means });

const secs = (n: number): string => (n % 60 === 0 && n >= 120 ? `${n / 60} minutes` : `${n}s`);

/** Rules every employee needs, whatever their job. */
function commonRules(c: GameConfig): string[] {
  return [
    'Every log names the owner of the code that was used, not the person who typed it. Anyone holding your code can act as you.',
    `${c.lockoutAfterFails} wrong codes in a row lock your workstation for ${secs(c.lockoutSec)}.`,
    'Your workstation has its own login code (W): it never changes and cannot be revoked. Anyone who has it can log in to your workstation and read it: your codes, your activity log and your messages (not your objective or which side you are on).',
    'Switch on the bell of a page you can write to and it tells you when someone else does something there.',
    "Lose every credential, or have your IP revoked by the Firewall, and you are terminated: the bank's systems refuse you for the rest of the game. Quitting (at the bottom of your Profile) does the same. Once every Thief is terminated or has quit, the game ends: the bank wins, unless the Thieves' goal is already met.",
  ];
}

const JOBS: Record<RoleId, (c: GameConfig, n: number) => JobDescription> = {
  PERSONAL_BANKER: (c) => ({
    summary: 'You look after your own customers: you read their requests, keep their accounts up to date, and start the payments they ask for.',
    duties: [
      'Manage Clients: Act on Client Requests. Put the request id (REQ-7) on the action so the request is marked done.',
      'Create Payments: Use the Payment Queue to create the payments your customers ask for.',
      'Manage Accounts: Use Customer Records to add accounts, remove accounts or change a customer\'s primary account.',
      'Authorize payments: Ensure the payment fulfills the client\'s request, especially if it has a MEDIUM or HIGH risk score.',
    ],
    dependsOn: [
      'Accounts & Receivables to score the risk of your payments, settle them, and verify your account changes.',
      'The Bank Manager, who can also verify account changes and settle payments.',
    ],
    rules: [
      'You change only your own customers, and only read requests sent to you. You can view every customer in Customer Records.',
      'A payment you create counts toward the bank\'s target only if it pays the payee and amount a customer asked for. Put the request id on it; a payment made exactly as asked is matched to the request anyway.',
      `Your first request of the day is an easy one with ${secs(c.firstRequestDeadlineSec)}: use it to learn the ropes. After that, customers expect action within ${secs(c.requestDeadlineSec)} (${secs(c.urgentDeadlineSec)} when urgent). Halfway there they chase you in your messages, and an archived request comes back. When a deadline passes they complain to the Bank Manager, naming you; after ${c.strikesToSuspend} missed requests a customer stops doing business with the bank for the day.`,
      'Requests are written in words, usually with the payee\'s tag (CU3). Look up account numbers, and any tag not given, in Customer Records. Wherever a customer is asked for you can type their tag or their exact name.',
      'Not every request is genuine. Phishing messages claim customer tags and accounts that do not exist: archive them.',
      'Every account change waits in Verification until Accounts & Receivables or the Bank Manager verifies it. You cannot see that queue, or the Risk Check queue.',
      'A payment is paid into the payee\'s primary account at the moment it settles, not when it was created. Changing a primary account redirects payments already on their way.',
      'Approval needs a risk check first, but not a LOW score. Hold and Reject need a typed reason.',
      `Authorization approves payments by itself up to a risk level (${c.automation.approveUpTo} at the start). Anyone with Authorization write can change it; setting HIGH raises an alert.`,
      `Manual payments are capped at ${money(c.maxManualAmount)}.`,
    ],
    checks: [
      {
        title: 'Before approving a payment',
        intro: 'The risk score and its reason come from Accounts & Receivables. MEDIUM or HIGH means they want you to look.',
        rows: [
          row('Scored MEDIUM or HIGH', 'Authorization: the score and its reason', 'Read the reason. Hold it if you are not sure; reject it if it is wrong.'),
          row('Payee or amount don\'t match the attached request', 'Client Requests', 'Not what the customer asked: reject it.'),
          row('For a request you cannot see', 'Authorization: "for REQ-..."', 'Another banker\'s request. Ask them if it is right.'),
        ],
      },
    ],
  }),
  ACCOUNTS_RECEIVABLES: (c) => ({
    summary: 'You move the money safely: you score the risk of every payment, settle approved ones, and check that account changes are genuine.',
    duties: [
      'Risk Check: Ensure the payment was created legitimately and the paying account and the payee are genuine.',
      'Settle Payments: Ensure the risk check and authorization were performed correctly and the payee\'s account did not change while it was in transit, especially with high value transactions.',
      'Verify Account Changes: Ensure modified accounts are legitimate.',
    ],
    dependsOn: [
      'Personal Bankers, who create payments, approve them, and are the only ones who change customers\' accounts.',
      'The Bank Manager, who also monitors changes and can settle payments.',
    ],
    rules: [
      `Routine payments move by themselves: Risk Check scores automatic payments up to ${money(c.automation.scoreMax)} LOW when they come from a customer account and the payee's primary is verified, and Settlement settles approved payments up to ${money(c.automation.settleMax)}. You can change both settings; each queue shows the current one.`,
      'The risk queue marks a payment "UNVERIFIED" when the payee\'s primary account, or the account it is paid from, has an unverified change.',
      'A payment is paid into the payee\'s primary account at the moment it settles. Check the primary before you settle.',
      `A settled payment can be reversed for ${secs(c.reversalWindowSec)}, as long as the account it was paid into still holds the money.`,
      "A payment fails at settlement if the account it is paid from holds too little. Customer Records shows every account's balance.",
      `The bank wins if ${money(c.whiteTarget)} of legitimate customer payments are settled by close of business and the Thieves' goal is not met. "Settled today" counts every settled payment, diverted and embezzled ones too, so it runs ahead of the bank's real progress. Every payment held, rejected or reversed slows the bank down. A payment settled into an employee's own account counts for nobody.`,
    ],
    checks: [
      {
        title: 'Scoring risk',
        intro: `LOW: nothing is odd | MEDIUM: a banker should look before approving | HIGH: it looks like fraud`,
        rows: [
          row('"!! UNVERIFIED" on the payment', 'Risk queue', 'An account in it was changed and hasn\'t been checked yet. Investigate before you score.'),
          row('The payee\'s primary changed recently, not by their banker or with no request', 'Verification: Investigate changes (the payee\'s tag)', 
          'The money may be going somewhere new.'),
          row('Paid from UNKNOWN', 'Risk queue', 'The account is on no customer\'s file.'),
          row('A manual payment with no "for REQ-..."', 'Risk queue', 'Banker did not attach a request.'),
          row('Created by someone who is not the paying customer\'s banker', 'Risk queue: "created by"; Customer Records: "banker"', 'Why are they paying for someone else\'s customer?'),
          row(`More than ${money(c.largeAmount)}, or most of what the paying account holds`, 'Risk queue; Customer Records', 'Big payments are worth a second look.'),
          row('Several payments to the same payee close together', 'Payment Queue (All)', 'Someone may be draining an account.'),
        ],
      },
      {
        title: 'Verifying an account change',
        intro: 'Verifying says "this change is genuine". A change you doubt can stay unverified: tell the team why.',
        rows: [
          row('Not made by the customer\'s own banker', 'Verification: "by"; Customer Records: "banker"', 'Ask the banker; only they should be changing their customers.'),
          row('No "for REQ-..." on it', 'Verification', 'Nobody linked a request. Ask the banker which customer asked.'),
          row('The account has moved around a lot', 'Verification: Investigate changes (the account, or the customer)', 'Accounts do not usually move between customers. Do not verify.'),
          row('Payments to this customer are waiting', 'Risk queue; Settlement queue', 'A new primary receives them when they settle. Check it before they do.'),
        ],
      },
      {
        title: 'Before settling a payment',
        intro: 'The money goes to the payee\'s primary at the moment you settle, whatever it was when the payment was approved.',
        rows: [
          row('The payee\'s primary changed after the payment was approved', 'Verification: Investigate changes (the payee\'s tag)', 'Do not settle. Ask a banker to hold it.'),
          row('The primary shown is (unverified)', 'Customer Records', 'Do not settle until the change is verified.'),
          row('Scored MEDIUM or HIGH and approved anyway', 'Settlement: the score, the approval and their reasons', 'Read why it was approved. If it does not add up, ask a banker to hold it.'),
          row('The paying account holds less than the amount', 'Customer Records', 'It will fail.'),
          row('It settled into an account you did not expect', 'The settle result line', `Reverse it within ${secs(c.reversalWindowSec)}, before the money moves on.`),
        ],
      },
    ],
  }),
  IT_SPECIALIST: (c, n) => ({
    summary: 'You keep the bank\'s systems secure: the firewall, the logs, staff records and everyone\'s credentials.',
    duties: [
      'Monitor and Report: Watch the Master Log and its alerts, and trace anything suspicious.',
      'Maintain Permissions: Issue and revoke credentials in Permissions, replace permissions you suspect have been compromised.',
      'Reset lockouts in Employee Records.',
      'Act on suspicious activity: Use the Firewall to block an address, take a module offline, or set its security level.',
    ],
    dependsOn: [
      n === SHARED_SECURITY_TABLE
        ? 'The Bank Manager, who also traces log entries, manages credentials, and the Firewall.'
        : 'The Bank Manager, who also traces log entries and monitors banking activity.',
      'Everyone else to report what looks wrong: you see the logs, they see the money.',
    ],
    rules: [
      `A trace reveals which workstation made a log entry. Entries must be under ${secs(c.traceMaxAgeSec)} old, and you can trace once every ${secs(c.traceCooldownSec)}. Employee Records list every workstation's IP.`,
      '"Unknown server activity" comes from an unregistered host. Tracing it gives only a partial clue, unless an alert points at it.',
      `A block lasts ${secs(c.blockSec)}. A blocked workstation cannot use any system.`,
      `"Revoke all access" is permanent once its ${secs(c.revokeCountdownSec)} countdown ends; only the Firewall can cancel it, and only one can count down at a time. Revoking a workstation terminates its owner for good. Revoking the unregistered host shuts it down and the bank wins, unless the Thieves' goal is already met; revoking one of the bank's own systems shuts the bank down, and everybody loses.`,
      'While the Master Log is offline nothing is recorded, but the entry numbers keep counting, so the gap shows.',
      'You can issue a credential in anyone\'s name. Its owner is told.',
      'Blocking an address, switching security off, taking a module offline, and issuing or revoking a credential raise a "Suspicious security activity" alert naming you. Starting a "revoke all access", and issuing or revoking Firewall or Permissions write, raise a "Fatal" one.',
      `Revoking a Firewall or Permissions write credential takes ${secs(c.revokeCountdownSec)}. Its owner is told, and anyone with Permissions write can cancel it.`,
    ],
  }),
  BANK_MANAGER: (c, n) => ({
    summary: 'You oversee the whole bank: you can read every customer request and every payment, verify account changes, settle payments, and manage credentials.',
    duties: [
      'Review Everything: Read every banker\'s Client Requests and check that what gets done matches what customers asked for.',
      'Monitor Activity: Watch the Master Log and trace anything suspicious.',
      `Claw Back Settlements: You can reverse a settled payment within ${secs(c.reversalWindowSec)}, if the account it went to still holds the money.`,
      'Manage your Team: Keep everyone motivated, make sure they have the permissions they need and pick up the slack where the team is swamped, especially in the Lunch Rush and at End of Day.',
      ...(n === SHARED_SECURITY_TABLE ? ['Act on suspicious activity (1 IT Specialist): Use the Firewall to block an address, take a module offline, or set its security level.'] : []),
    ],
    dependsOn: [
      'Personal Bankers to act on requests and change accounts.',
      'Accounts & Receivables to score risk.',
      n === SHARED_SECURITY_TABLE ? 'The IT Specialist, who shares the Firewall with you.' : 'IT Specialists to act on the Firewall.',
    ],
    rules: [
      'A payment is paid into the payee\'s primary account at the moment it settles. A primary changed just before settlement is the classic way money goes missing.',
      `A trace reveals which workstation made a log entry. Entries must be under ${secs(c.traceMaxAgeSec)} old, and you can trace once every ${secs(c.traceCooldownSec)}.`,
      `A settled payment can be reversed for ${secs(c.reversalWindowSec)}.`,
      `Settlement settles approved payments up to ${money(c.automation.settleMax)} by itself; you can change the amount (0 switches it off).`,
      'You can issue a credential in anyone\'s name. Its owner is told.',
      `Revoking a Firewall or Permissions write credential takes ${secs(c.revokeCountdownSec)}, and anyone with Permissions write can cancel it. If yours is being revoked, you can cancel it yourself.`,
      `Customers write to you when a request passes its deadline, naming the banker who had it. After ${c.strikesToSuspend} missed requests a customer stops doing business with the bank for the day.`,
    ],
  }),
};

const OPERATIVE = (c: GameConfig): string[] => [
  'Your day job is your cover. Do it well enough that nobody looks twice.',
  'Anything you do on the unregistered host leaves an "Unknown server activity" entry in the Master Log. Tracing it gives the bank a partial clue, and tracing a Blacknet post or read also shows them a message: the one posted, or the newest on the board.',
  'Kit tools are marked noisy, loud or reckless. The louder the tool, the more a trace of its alert gives away: a partial clue, then your exact IP or the server\'s address, then your IP and your host code.',
  'Your Host Log warns you when the bank gets an alert about you, and when someone traces one of your entries. Its bell and Blacknet\'s start on, so these pop up on your screen (in the host\'s dark red): mind who can see it, or switch them off.',
  'If you are terminated, the unregistered host still answers you: keep helping from there.',
  "Meeting your goal does not end the game. However it ends (close of business, every Thief out or bank shuts down), the Thieves win if the Target Ledger meets the goal at that moment. Once it does, quit (at the bottom of your Profile): when every Thief is out, the day ends on the spot.",
  `Money counts while it sits in a Target Ledger account. Each mule account opened with some money of its own so it looks like any new account: what counts is how far its balance is above that (paying out of it can take you below zero). A settled payment can be reversed for ${secs(c.reversalWindowSec)}, but only while the account it went to still holds the money: a mule account can pay it on first.`,
];

/** `n`: the table size (the 6-player table gives the Bank Manager Firewall write). */
export function jobDescription(role: RoleId, allegiance: Allegiance, c: GameConfig, n: number): JobDescription {
  const job = JOBS[role](c, n);
  return {
    ...job,
    rules: [...job.rules, ...commonRules(c)],
    ...(allegiance === 'BLACK' ? { operative: OPERATIVE(c) } : {}),
  };
}
