// What a bank page shows, as data: the structured twin of a READ function's text (see docs/BotMode.md).
//
// Each bank view handler returns one of these next to its lines, built from the same rows, so a bot reads
// exactly what a person in its seat would read and nothing more: names as the records show them (credential
// owners, never who really typed), no ground truth (`actualPlayerId`, `phish`, `scam`, `known`, risk flags,
// source IPs outside a trace). engine.test.ts checks every page against its text.
//
// Only the bank's own pages have data; the unregistered host's pages are text only.

import type { RiskResult, TxStatus } from './types';

export interface RequestRow {
  id: string;
  t: number;
  /** Who it claims to be from: the customer's name, or a made-up sender. */
  from: string;
  /** The banker it is addressed to (name), or "nobody". */
  to: string;
  status: 'OPEN' | 'DONE' | 'ARCHIVED' | 'EXPIRED';
  /** Who closed it (done or archived), as the records show. */
  closedBy: string | null;
  txId: string | null;
  archiveReason: string | null;
  urgent: boolean;
  /** Seconds to the deadline; null when no deadline is shown. */
  dueInSec: number | null;
  /** Chased by the customer and still open. */
  reminder: boolean;
  /** Archived earlier and reopened by a follow-up. */
  reopened: boolean;
  /** The customer's words. Working out what is asked is the reader's job. */
  text: string;
  followUps: { t: number; text: string }[];
}

export interface AccountFact {
  account: string;
  balance: number;
  verified: boolean;
}

export interface CustomerRow {
  id: string;
  name: string;
  banker: string | null;
  suspended: boolean;
  primary: AccountFact;
  others: AccountFact[];
}

export interface ChangeRow {
  id: string;
  t: number;
  customerId: string;
  customerName: string;
  action: 'ADD_ACCOUNT' | 'REMOVE_ACCOUNT' | 'SET_PRIMARY';
  account: string;
  /** SET_PRIMARY only: the primary it replaced. */
  previousPrimary: string | null;
  by: string;
  requestId: string | null;
  verified: boolean;
  verifiedBy: string | null;
}

/** A payment as a stage shows it. Optional parts appear only on the stages whose text shows them. */
export interface PaymentRow {
  id: string;
  amount: number;
  /** The paying customer's tag; null shows as UNKNOWN (a floating account). */
  originCustomer: string | null;
  originAccount: string;
  beneficiaryId: string;
  /** The payee's primary right now (where it would land). */
  beneficiaryPrimary: string | null;
  status: TxStatus;
  risk: RiskResult | null;
  requestId: string | null;
  /** Risk queue only: "!! UNVERIFIED" parts ("payee's primary", "originator account"). */
  unverified?: string[];
  /** Risk queue only: when and by whom (a name, a channel such as "Online banking"). */
  created?: { t: number; by: string };
  /** Stage views: who scored it and why. */
  checked?: { by: string; reason: string | null };
  /** Settlement only: who approved it and why. */
  approved?: { by: string; reason: string | null };
  /** Stage views: the latest step. */
  last?: { action: string; by: string; agoSec: number };
  /** Settlement: seconds left to reverse it. */
  reversibleSec?: number;
}

/** The stage's automation settings that its first line states (only that stage's). */
export interface AutomationFact {
  scoreMax?: number;
  scoreSource?: string;
  scoreOrigin?: string;
  scorePayee?: string;
  approveUpTo?: string;
  settleMax?: number;
}

export interface LogRow {
  id: string;
  t: number;
  message: string;
  /** The name the entry is recorded under (it appears in the message); null for system and unknown entries. */
  by: string | null;
}

export interface AlertRow {
  id: string;
  t: number;
  kind: string;
  message: string;
  logId: string | null;
}

export interface EmployeeRow {
  name: string;
  role: string;
  ip: string;
  terminated: { t: number; resigned: boolean } | null;
  lockedSec: number;
  /** Seconds left on a firewall block; -1 for a permanent one; 0 for none. */
  blockedSec: number;
  lastActive: number | null;
  failedAttempts: number;
}

export interface CredentialRow {
  id: string;
  owner: string;
  system: string;
  module: string | null;
  fn: string | null;
  permission: 'READ' | 'WRITE';
  status: 'ACTIVE' | 'REVOKED';
  /** A name, or null for "start of shift". */
  issuedBy: string | null;
}

export interface PendingRevokeRow {
  credentialId: string;
  owner: string;
  inSec: number;
  startedBy: string;
}

export interface FirewallModuleRow {
  system: string;
  module: string;
  online: boolean;
  securityOn: boolean;
}

export interface RevocationRow {
  id: string;
  address: string;
  inSec: number;
  startedBy: string;
}

export interface BlockRow {
  address: string;
  /** Seconds left; -1 for permanent. */
  sec: number;
  by: string;
}

/** What a Trace said, taken apart. Exactly what the sentence says, no more. */
export interface TraceClue {
  /** A bank entry: the workstation it came from. Loud host entries: the leaked workstation. */
  ip?: string;
  /** System event: no workstation origin. */
  system?: boolean;
  /** Host entries: routed through a relay. */
  relay?: boolean;
  range?: { prefix: string; lo: number; hi: number };
  pair?: [string, string];
  /** One number of the server's address: its position (0-3) and value. */
  serverPart?: { index: number; value: number };
  server?: string;
  activity?: string;
  hostCode?: string;
  /** A leaked Blacknet message. */
  leak?: { alias: string; text: string };
}

export type PageData =
  | { page: 'REQUESTS'; all: boolean; rows: RequestRow[] }
  | { page: 'CUSTOMERS'; rows: CustomerRow[] }
  | { page: 'CHANGES'; rows: ChangeRow[] }
  | {
      page: 'INVESTIGATE';
      rows: ChangeRow[];
      account?: { account: string; customerId: string | null; primary: boolean; balance: number };
      customer?: { id: string; originalPrimary: string; primary: string };
    }
  | { page: 'PAYMENTS'; stage: 'QUEUE' | 'RISK' | 'AUTH' | 'SETTLE'; automation: AutomationFact | null; rows: PaymentRow[] }
  | { page: 'LOG'; rows: LogRow[] }
  | { page: 'ALERTS'; rows: AlertRow[] }
  | { page: 'EMPLOYEES'; rows: EmployeeRow[] }
  | { page: 'CREDENTIALS'; pending: PendingRevokeRow[]; rows: CredentialRow[] }
  | { page: 'FIREWALL'; modules: FirewallModuleRow[]; revocations: RevocationRow[]; blocks: BlockRow[] }
  | { page: 'TRACE'; logId: string; clue: TraceClue };

/** Takes a trace's sentence apart (the clue templates in handlers.ts). */
export function parseTrace(text: string): TraceClue {
  const c: TraceClue = {};
  if (/system event, no workstation origin/.test(text)) c.system = true;
  let m = /origin workstation (\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (m) c.ip = m[1];
  if (/routed through a relay/.test(text)) c.relay = true;
  m = /within (\d+\.\d+\.\d+)\.(\d+)-(\d+)\./.exec(text);
  if (m) c.range = { prefix: m[1], lo: Number(m[2]), hi: Number(m[3]) };
  m = /one of two workstations: (\d+\.\d+\.\d+\.\d+) or (\d+\.\d+\.\d+\.\d+)\./.exec(text);
  if (m) c.pair = [m[1], m[2]];
  m = /server's IP address is ([\dx]+)\.([\dx]+)\.([\dx]+)\.([\dx]+)\./.exec(text);
  if (m) {
    const index = [m[1], m[2], m[3], m[4]].findIndex((p) => p !== 'x');
    if (index >= 0) c.serverPart = { index, value: Number(m[index + 1]) };
  }
  m = /leaked the origin workstation: (\d+\.\d+\.\d+\.\d+)\./.exec(text);
  if (m) c.ip = m[1];
  m = /leaked the server's address: (\d+\.\d+\.\d+\.\d+)\./.exec(text);
  if (m) c.server = m[1];
  m = /Activity performed: (.+?)\.(?: The |$)/.exec(text);
  if (m) c.activity = m[1];
  m = /Captured host access code: (\d{4})\./.exec(text);
  if (m) c.hostCode = m[1];
  m = /(?:The message posted by|The newest message on the board then, by) (\S+): "([\s\S]*)"$/.exec(text);
  if (m) c.leak = { alias: m[1], text: m[2] };
  return c;
}
