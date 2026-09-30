// Job descriptions: what each role does, its tools, who it depends on, and the rules that matter for it.
// Shown on the player's workstation (Profile). Numbers come from the game config so they stay true.

import { findModule, ROLES } from './catalog';
import { money } from './core';
import type { Allegiance, GameConfig, RoleId } from './types';

export interface JobDescription {
  summary: string;
  duties: string[];
  /** The modules this role starts with: "Customer Records (read & write)". */
  tools: string[];
  dependsOn: string[];
  rules: string[];
  /** Black Hats only: how to operate unseen. It lives on the workstation, so a White Hat who logs in can read it. */
  operative?: string[];
}

const secs = (n: number): string => (n % 60 === 0 && n >= 120 ? `${n / 60} minutes` : `${n}s`);

function tools(role: RoleId): string[] {
  return ROLES[role].creds.map((t) => {
    const label = t.module ? (findModule(t.system, t.module)?.label ?? t.module) : t.system;
    return `${label} (${t.permission === 'WRITE' ? 'read & write' : 'read only'})`;
  });
}

/** Rules every employee needs, whatever their job. */
function commonRules(c: GameConfig): string[] {
  return [
    'Every log names the owner of the code that was used, not the person who typed it. Anyone holding your code can act as you.',
    `${c.lockoutAfterFails} wrong codes in a row lock your workstation for ${secs(c.lockoutSec)}.`,
    'Your workstation has its own login code (W): it never changes and cannot be revoked. Anyone who has it can log in to your workstation and read everything on it, including your codes.',
    'Switch on the bell of a page you can write to and it tells you when someone else does something there.',
    "Lose every credential, or have your IP revoked by the Firewall, and you are terminated: the bank's systems refuse you for the rest of the game. The bank wins at once if every Black Hat is terminated.",
  ];
}

const JOBS: Record<RoleId, (c: GameConfig) => Omit<JobDescription, 'tools'>> = {
  PERSONAL_BANKER: (c) => ({
    summary: 'You look after your own customers: you read their requests, keep their accounts up to date, and start the payments they ask for.',
    duties: [
      'Read your Client Requests and act on them. Put the request id (REQ-7) on the action so the request is marked done.',
      'Create the payments your customers ask for in the Payment Queue.',
      'Add accounts, remove accounts or change a customer\'s primary account in Customer Records.',
      'Approve, hold or reject risk-checked payments in Authorization.',
      'Archive requests you will not act on, with a reason.',
    ],
    dependsOn: [
      'Accounts & Receivables to score the risk of your payments, settle them, and verify your account changes.',
      'The Bank Manager, who can also verify account changes and settle payments.',
    ],
    rules: [
      'You only see and change your own customers, and only read requests sent to you.',
      'A payment you create counts toward the bank\'s target only if it pays the payee and amount a customer asked for. Put the request id on it; a payment made exactly as asked is matched to the request anyway.',
      `Customers expect action within ${secs(c.requestDeadlineSec)} (${secs(c.urgentDeadlineSec)} when urgent). Halfway there they chase you in your messages, and an archived request comes back. When a deadline passes they complain to the Bank Manager, naming you; after ${c.strikesToSuspend} missed requests a customer stops doing business with the bank for the day.`,
      'Requests are written in words. Look up account numbers and customer tags (CU3) in Customer Records.',
      'Not every request is genuine. Phishing messages claim customer tags and accounts that do not exist: archive them.',
      'Every account change waits in Verification until someone verifies it. You can see the queue but cannot verify.',
      'A payment is paid into the payee\'s primary account at the moment it settles, not when it was created. Changing a primary account redirects payments already on their way.',
      'Approval needs a risk check first, but not a LOW score. Hold and Reject need a typed reason.',
      `Authorization approves payments by itself up to a risk level (${c.automation.approveUpTo} at the start). Anyone with Authorization write can change it; setting HIGH raises an alert.`,
      `Manual payments are capped at ${money(c.maxManualAmount)}.`,
    ],
  }),
  ACCOUNTS_RECEIVABLES: (c) => ({
    summary: 'You move the money safely: you score the risk of every payment, settle approved ones, and check that account changes are genuine.',
    duties: [
      'Score the risk of queued payments (LOW, MEDIUM or HIGH) in Risk Check. Every score needs a reason.',
      'Settle approved payments in Settlement.',
      'Verify account changes in Verification. Use Investigate changes to check a customer or an account first.',
      'Reverse a settled payment that went somewhere it should not have.',
    ],
    dependsOn: [
      'Personal Bankers, who create payments, approve them, and are the only ones who change customers\' accounts.',
      'The Bank Manager, who also verifies account changes and settles payments.',
    ],
    rules: [
      `Routine payments move by themselves: Risk Check scores automatic payments up to ${money(c.automation.scoreMax)} LOW when they come from a customer account and the payee's primary is verified, and Settlement settles approved payments up to ${money(c.automation.settleMax)}. You can change both settings; each queue shows the current one.`,
      'The risk queue marks a payment "UNVERIFIED" when the payee\'s primary account, or the account it is paid from, has an unverified change.',
      'A payment is paid into the payee\'s primary account at the moment it settles. Check the primary before you settle.',
      `A settled payment can be reversed for ${secs(c.reversalWindowSec)}, as long as the account it was paid into still holds the money.`,
      "A payment fails at settlement if the account it is paid from holds too little. Customer Records shows every account's balance.",
      `The bank wins if ${money(c.whiteTarget)} of customer payments are settled by close of business. Every payment held, rejected or reversed slows the bank down. A payment settled into an employee's own account counts for nobody.`,
    ],
  }),
  IT_SPECIALIST: (c) => ({
    summary: 'You keep the bank\'s systems secure: the firewall, the logs, staff records and everyone\'s credentials.',
    duties: [
      'Watch the Master Log and its alerts, and trace anything suspicious.',
      'Use the Firewall to block an address, take a module offline, or switch a module\'s security off.',
      'Issue and revoke credentials in Permissions.',
      'Reset lockouts in Employee Records.',
    ],
    dependsOn: [
      'The Bank Manager, who also traces log entries and manages credentials, and can see the Firewall.',
      'Everyone else to report what looks wrong: you see the logs, they see the money.',
    ],
    rules: [
      `A trace reveals which workstation made a log entry. Entries must be under ${secs(c.traceMaxAgeSec)} old, and you can trace once every ${secs(c.traceCooldownSec)}. Employee Records list every workstation's IP.`,
      '"Unknown server activity" comes from an unregistered host. Tracing it gives only a partial clue, unless an alert points at it.',
      `A block lasts ${secs(c.blockSec)}. A blocked workstation cannot use any system.`,
      `"Revoke all access" is permanent once its ${secs(c.revokeCountdownSec)} countdown ends; only the Firewall can cancel it, and only one can count down at a time. Revoking a workstation terminates its owner for good. Revoking the unregistered host shuts it down and the bank wins; revoking one of the bank's own systems shuts the bank down, and everybody loses.`,
      'While the Master Log is offline nothing is recorded, but the entry numbers keep counting, so the gap shows.',
      'You can issue a credential in anyone\'s name. Its owner is told.',
      'Blocking an address, switching security off, taking a module offline, and issuing or revoking a credential raise a "Suspicious security activity" alert naming you. Starting a "revoke all access", and issuing or revoking Firewall or Permissions write, raise a "Fatal" one.',
      `Revoking a Firewall or Permissions write credential takes ${secs(c.revokeCountdownSec)}. Its owner is told, and anyone with Permissions write can cancel it.`,
    ],
  }),
  BANK_MANAGER: (c) => ({
    summary: 'You oversee the whole bank: you can read every customer request and every payment, verify account changes, settle payments, and manage credentials.',
    duties: [
      'Read every banker\'s Client Requests and check that what gets done matches what customers asked for.',
      'Verify account changes in Verification, investigating anything unusual first.',
      'Settle approved payments in Settlement.',
      'Watch the Master Log and trace anything suspicious.',
      'Issue and revoke credentials in Permissions.',
    ],
    dependsOn: [
      'Personal Bankers to act on requests and change accounts.',
      'Accounts & Receivables to score risk.',
      'IT Specialists to act on the Firewall. You can see its status but not change it.',
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
  'Anything you do on the unregistered host leaves an "Unknown server activity" entry in the Master Log. Tracing it gives the bank a partial clue.',
  'Kit tools are marked noisy, loud or reckless. The louder the tool, the more a trace of its alert gives away: a partial clue, then your exact IP or the server\'s address, then your IP and your host code.',
  'Your Host Log warns you when the bank gets an alert about you, and when someone traces one of your entries.',
  'If you are terminated, the unregistered host still answers you: keep helping from there.',
  `Money counts while it sits in a Target Ledger account. A settled payment can be reversed for ${secs(c.reversalWindowSec)}, but only while the account it went to still holds the money: a mule account can pay it on first.`,
];

export function jobDescription(role: RoleId, allegiance: Allegiance, c: GameConfig): JobDescription {
  const job = JOBS[role](c);
  return {
    ...job,
    tools: tools(role),
    rules: [...job.rules, ...commonRules(c)],
    ...(allegiance === 'BLACK' ? { operative: OPERATIVE(c) } : {}),
  };
}
