// Core data model. Everything here is plain JSON so it can be stored in Firestore later.

export type PlayerId = string;
export type Allegiance = 'WHITE' | 'BLACK';
export type Winner = Allegiance;
export type SystemId = 'SECURITY' | 'CLIENT_DATA' | 'TRANSACTIONS' | 'BLACKHAT_DB';
export type Permission = 'READ' | 'WRITE';
export type RoleId = 'PERSONAL_BANKER' | 'ACCOUNTS_RECEIVABLES' | 'IT_SPECIALIST' | 'BANK_MANAGER';
export type TxStatus =
  | 'QUEUED'
  | 'RISK_CHECKED'
  | 'AUTHORIZED'
  | 'HELD'
  | 'REJECTED'
  | 'SETTLED'
  | 'REVERSED';
export type RiskResult = 'LOW' | 'MEDIUM' | 'HIGH';

export interface GameConfig {
  durationSec: number; // game length
  // Scaling with the table (see scaledConfig in setup.ts). The four derived values below are computed
  // from these at game creation unless the game's config sets them explicitly.
  whiteTargetPerPlayer: number; // bank target per player
  blackTargetPerHacker: number; // Black Hat target per Black Hat
  volumePerPlayer: number; // legitimate payment volume offered over the game (automatic + requested), per player
  requestEverySecPerBanker: number; // each Personal Banker gets a client request about this often
  customersPerBanker: number;
  whiteTarget: number; // derived: legitimate money that must be settled for a White Hat win
  blackTarget: number; // derived: stolen money for a Black Hat win
  timeoutWinner: Winner; // who wins if the clock runs out
  blackHatCount: number | null; // null = hackerCount(n): floor(n / 3)
  npcIntervalSec: number; // derived: one automatic payment every N seconds
  npcMinAmount: number;
  npcMaxAmount: number;
  maxManualAmount: number; // largest payment a player can create by hand
  largeAmount: number; // risk check flags payments above this
  recentModifySec: number; // hidden risk assessment flags primary accounts changed this recently
  reversalWindowSec: number; // how long a settled payment can be reversed
  traceMaxAgeSec: number; // TRACE only works on log entries this young
  traceCooldownSec: number;
  lockoutAfterFails: number; // consecutive failures before a workstation locks
  lockoutSec: number;
  clockStart: number; // seconds after midnight shown as the in-game start time
  autoProcess: boolean; // DEBUG: a bot settles NPC payments that pass the risk check
  autoProcessDelaySec: number;
  requestIntervalSec: number; // derived: one client request (bank-wide) every N seconds
  requestChangeShare: number; // share of requests that ask for an account change instead of a payment (0..1)
  blockSec: number; // how long a Firewall block lasts
  revokeCountdownSec: number; // how long anyone has to cancel a "revoke all access"
  crackRevealSec: number; // Access / Code crack: seconds between digit reveals (4 digits ~= a minute)
}

/** A Firewall block on an address (a workstation IP or a system address). */
export interface Block {
  address: string;
  until: number | null; // game seconds; null = permanent (after "revoke all access")
  byOwner: PlayerId;
  actualPlayerId: PlayerId;
}

/**
 * An IP reroute (Infiltration kit): for a while, one operative's activity appears to come from `toIp`.
 * Attribution only — Master Log source IPs (so Traces) and Employee Records "last activity" follow the
 * fake IP; actual routing (firewall blocks, lockouts) still tracks the real workstation.
 */
export interface Reroute {
  playerId: PlayerId;
  toIp: string;
  until: number; // game seconds
}

/** "Revoke all access" for an address: runs when the countdown ends unless someone cancels it. */
export interface Revocation {
  id: string; // R1
  address: string;
  startedAt: number;
  executeAt: number;
  byOwner: PlayerId;
  actualPlayerId: PlayerId;
  status: 'PENDING' | 'DONE' | 'CANCELLED';
  cancelledBy: PlayerId | null; // credential owner who cancelled it (from the Firewall)
}

/** A Code crack (Access kit): reveals one digit of `credentialId`'s code every crackRevealSec, over ~1 minute. */
export interface CodeCrack {
  id: string; // K1
  actorId: PlayerId; // the operative running it (its real source)
  credentialId: string; // the credential being cracked
  revealed: number; // digits recovered so far (0-4)
  nextRevealAt: number; // game seconds
  done: boolean; // completed, or aborted (credential revoked / source blocked)
}

export interface Credential {
  id: string;
  owner: PlayerId;
  code: string; // 4 digits
  system: SystemId;
  module: string | null; // null = whole system
  fn: string | null; // null = whole module
  permission: Permission;
  status: 'ACTIVE' | 'REVOKED';
  issuedBy: PlayerId | null; // null = issued at game start
  createdAt: number;
}

export interface ModuleState {
  status: 'ONLINE' | 'OFFLINE';
  open: boolean; // security switched off in the Firewall: no code needed, use is logged as Anonymous
  encryption: string[]; // layer codes; ALL must be supplied to use the module
}

export interface LogEntry {
  id: string;
  t: number; // game seconds
  actor: string; // 'SYSTEM' | 'UNKNOWN' | credential-owner player id
  kind: string;
  message: string;
  // Ground truth. Players only ever learn sourceIp through TRACE.
  sourceIp: string | null;
  actualPlayerId: PlayerId | null;
  /** Hidden host entries only: what was really done ("posted on Blacknet"); a Trace may reveal it. */
  activity?: string;
  /** Hidden host entries only: exposure tier 1-4 of the action (default 1). A higher tier makes a Trace reveal more. */
  exposure?: number;
  /** Wiped by Cleanup / Log wiper: hidden from the Master Log (leaving an id gap) but still traceable until it ages out. */
  deleted?: boolean;
}

/** The hidden host's own log, readable by operatives (and by anyone who gets into the host). */
export interface HostLogEntry {
  id: string; // H1
  t: number;
  message: string;
  alert: boolean; // an operative has been exposed (e.g. the bank traced a relay entry)
}

export interface Alert {
  id: string;
  t: number;
  kind: string;
  message: string;
  logId: string | null;
  /** Severity 1-4 (mirrors the exposure tiers). Cleanup / Alert mute suppresses tier 1-2 while active. */
  tier: number;
}

/** A change to a customer's accounts. `byOwner` is what the records show; `actualPlayerId` is the truth. */
export interface AccountChange {
  id: string; // CH-1: what Verification refers to
  customerId: string;
  t: number;
  action: 'ADD_ACCOUNT' | 'SET_PRIMARY' | 'REMOVE_ACCOUNT';
  account: string;
  previousPrimary: string; // primary account just before this change
  byOwner: PlayerId;
  actualPlayerId: PlayerId;
  verified: boolean; // every change waits in the Verification queue until someone verifies it
  verifiedBy: PlayerId | null; // credential owner
  verifiedAt: number | null;
}

/**
 * Everyone the bank deals with is a customer (CU1..). Payments come FROM any of a customer's accounts and
 * are paid TO a customer's primary account, whichever it is at settlement time.
 */
export interface Customer {
  id: string;
  name: string;
  bankerId: PlayerId | null; // assigned personal banker: their Client Requests go to this player
  accounts: string[]; // every account on file, oldest first
  primary: string; // where payments to this customer land
  originalPrimary: string;
  lastModifiedAt: number | null;
  history: AccountChange[];
}

export type RequestKind = 'PAYMENT' | 'ADD_ACCOUNT' | 'ADD_AND_PRIMARY' | 'SET_PRIMARY' | 'REMOVE_ACCOUNT';

/** A message from a customer to their personal banker. */
export interface ClientRequest {
  id: string; // REQ-1
  t: number; // game seconds
  customerId: string;
  bankerId: PlayerId | null;
  kind: RequestKind;
  text: string; // what the customer wrote, in words (names, not codes)
  // What is being asked, as data. Never shown to players; kept for checking fulfilment later.
  payeeId: string | null; // PAYMENT: customer to pay
  amount: number | null; // PAYMENT
  originAccount: string | null; // PAYMENT: which of their accounts to pay from
  account: string | null; // account requests: the account to add / make primary / remove
  status: 'OPEN' | 'DONE' | 'ARCHIVED';
  closedAt: number | null;
  closedBy: PlayerId | null; // credential owner
  closedByActual: PlayerId | null; // who really did it
  txId: string | null; // DONE by this payment (payment requests)
  archiveReason: string | null;
}

/** One step in a payment's life. `by` is what the records show (credential owner); `actualPlayerId` is the truth. */
export interface TxEvent {
  t: number; // game seconds
  action: 'CREATED' | 'RISK_CHECKED' | 'APPROVED' | 'HELD' | 'REJECTED' | 'SETTLED' | 'REVERSED';
  by: PlayerId | 'SYSTEM';
  actualPlayerId: PlayerId | null; // null for SYSTEM
  detail: string | null;
}

export interface Transaction {
  id: string;
  amount: number;
  customerId: string; // originator (the customer paying)
  originAccount: string; // which of the originator's accounts it is paid from
  beneficiaryId: string; // the customer being paid (CU..); paid into their primary account at settlement
  origin: 'NPC' | 'PLAYER';
  createdBy: PlayerId | null;
  channel: string | null; // automatic payments: where they came in ("Online banking" ...); null for manual ones
  status: TxStatus;
  createdAt: number;
  riskResult: RiskResult | null;
  riskFlags: string[]; // hidden: the system's own assessment at check time (players never see it)
  riskReason: string | null; // the reason the player typed with their score
  authorizedBy: PlayerId | null;
  settledAt: number | null;
  settledTo: string | null; // account it was actually paid to
  debitedFrom: string | null; // originator account it was actually taken from (captured at settlement)
  fraud: boolean; // ground truth: settled into a Black Hat target account
  history: TxEvent[]; // every step, oldest first
  requestId: string | null; // the client request this payment was made for, if any
}

export interface TargetAccount {
  account: string;
  status: 'READY' | 'PREPARE' | 'ABORT';
}

export interface BlacknetMessage {
  id: string;
  t: number;
  alias: string;
  text: string;
  ownerId: PlayerId; // ground truth
}

export interface Message {
  id: string;
  t: number;
  from: PlayerId;
  to: PlayerId;
  text: string;
}

export interface ActivityEntry {
  t: number;
  text: string;
}

export interface Player {
  id: PlayerId;
  name: string;
  role: RoleId;
  allegiance: Allegiance;
  objective: string;
  motivation: string;
  ip: string;
  bankAccount: string;
  heldCredentialIds: string[]; // credentials this player knows the code of
  knownSystems: SystemId[];
  activity: ActivityEntry[]; // personal activity log (ground truth for this player)
  messages: Message[];
  failStreak: number;
  lockedUntil: number;
  lastTraceAt: number;
  failTotal: number; // failed attempts from this workstation, all game (shown in Employee Records)
  lastActiveAt: number | null; // last time this workstation tried to use a system
  monitoring: string[]; // READ functions this player has opened with a logged read; only these can refresh quietly
  remoteAccess: { playerId: PlayerId; credentialId: string }[]; // other workstations this player has logged in to
  fake?: boolean; // planted by a Black Hat (Infiltration): a record in Employee Records, not a real seat
}

export interface GameState {
  id: string;
  seed: number;
  rngState: number;
  config: GameConfig;
  status: 'RUNNING' | 'ENDED';
  winner: Winner | null;
  endReason: string | null;
  startedAt: number; // ms
  now: number; // ms, last time the state was advanced to
  lastNpcAt: number; // game seconds
  players: Record<PlayerId, Player>;
  playerOrder: PlayerId[];
  credentials: Record<string, Credential>;
  modules: Record<string, ModuleState>; // key: SYSTEM.MODULE
  logs: LogEntry[];
  alerts: Alert[];
  customers: Customer[];
  requests: ClientRequest[];
  blocks: Block[];
  reroutes: Reroute[];
  cracks: CodeCrack[];
  alertMuteUntil: number; // game seconds: while now < this, tier 1-2 alerts are suppressed (Cleanup / Alert mute)
  hostLog: HostLogEntry[];
  revocations: Revocation[];
  lastRequestAt: number; // game seconds
  transactions: Transaction[];
  targets: TargetAccount[];
  blacknet: BlacknetMessage[];
  /** processed: legitimate money settled (automatic payments, plus manual ones that fulfil a payment request). */
  totals: { processed: number; stolen: number };
  hiddenHost: string;
  counters: { log: number; alert: number; cred: number; tx: number; msg: number; req: number; change: number; revoke: number; host: number; player: number; crack: number };
}

// ---- Actions -------------------------------------------------------------

export interface ExecuteAction {
  type: 'EXECUTE';
  playerId: PlayerId;
  code: string;
  system: SystemId;
  module: string;
  fn: string;
  params?: Record<string, string>;
  encCodes?: string[];
  /** Live monitor refresh: READ functions only; leaves no Master Log entry or activity note. */
  quiet?: boolean;
}
export interface ShareCredentialAction {
  type: 'SHARE_CREDENTIAL';
  playerId: PlayerId;
  credentialId: string;
  toPlayerId: PlayerId;
}
export interface SendMessageAction {
  type: 'SEND_MESSAGE';
  playerId: PlayerId;
  toPlayerId: PlayerId;
  text: string;
}
export interface ConnectAction {
  type: 'CONNECT';
  playerId: PlayerId;
  address: string;
}
export interface AccessWorkstationAction {
  type: 'ACCESS_WORKSTATION';
  playerId: PlayerId;
  targetId: PlayerId;
  code: string;
}
export type Action = ExecuteAction | ShareCredentialAction | SendMessageAction | ConnectAction | AccessWorkstationAction;

export interface ActionResult {
  ok: boolean;
  message: string;
  lines?: string[];
  workstation?: PlayerId; // CONNECT: the address belongs to this player's workstation
}
