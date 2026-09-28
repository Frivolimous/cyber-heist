// Core data model. Everything here is plain JSON so it can be stored in Firestore later.

export type PlayerId = string;
export type Allegiance = 'WHITE' | 'BLACK';
export type Winner = Allegiance;
export type SystemId = 'SECURITY' | 'CLIENT_DATA' | 'TRANSACTIONS' | 'BLACKHAT_DB';
export type Permission = 'READ' | 'WRITE';
export type RoleId =
  | 'IT_SPECIALIST'
  | 'PERSONAL_BANKER'
  | 'ACCOUNTS_RECEIVABLES'
  | 'SECURITY_ANALYST'
  | 'SYSTEMS_ADMIN';
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
  whiteTarget: number; // NPC money that must be settled for a White Hat win
  blackTarget: number; // stolen money for a Black Hat win
  timeoutWinner: Winner; // who wins if the clock runs out
  blackHatCount: number | null; // null = ~30% of players
  npcIntervalSec: number; // one NPC payment every N seconds
  npcMinAmount: number;
  npcMaxAmount: number;
  maxManualAmount: number; // largest payment a player can create by hand
  largeAmount: number; // risk check flags payments above this
  recentModifySec: number; // risk check flags beneficiaries edited this recently
  reversalWindowSec: number; // how long a settled payment can be reversed
  traceMaxAgeSec: number; // TRACE only works on log entries this young
  traceCooldownSec: number;
  lockoutAfterFails: number; // consecutive failures before a workstation locks
  lockoutSec: number;
  clockStart: number; // seconds after midnight shown as the in-game start time
  autoProcess: boolean; // DEBUG: a bot settles NPC payments that pass the risk check
  autoProcessDelaySec: number;
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
}

export interface Alert {
  id: string;
  t: number;
  kind: string;
  message: string;
  logId: string | null;
}

export interface Customer {
  id: string;
  name: string;
  account: string;
}

export interface Beneficiary {
  id: string;
  name: string;
  account: string;
  originalAccount: string;
  verified: boolean;
  lastModifiedAt: number | null;
  history: { t: number; byOwner: PlayerId; from: string; to: string }[];
}

export interface Transaction {
  id: string;
  amount: number;
  customerId: string;
  beneficiaryId: string;
  origin: 'NPC' | 'PLAYER';
  createdBy: PlayerId | null;
  status: TxStatus;
  createdAt: number;
  riskResult: RiskResult | null;
  riskFlags: string[];
  authorizedBy: PlayerId | null;
  settledAt: number | null;
  settledTo: string | null; // account it was actually paid to
  fraud: boolean; // ground truth: settled into a Black Hat target account
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

export interface InfoPacket {
  id: string;
  system: SystemId;
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
  packets: InfoPacket[];
  activity: ActivityEntry[]; // personal activity log (ground truth for this player)
  messages: Message[];
  failStreak: number;
  lockedUntil: number;
  lastTraceAt: number;
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
  beneficiaries: Record<string, Beneficiary>;
  transactions: Transaction[];
  targets: TargetAccount[];
  blacknet: BlacknetMessage[];
  totals: { processedNpc: number; stolen: number };
  hiddenHost: string;
  counters: { log: number; alert: number; cred: number; tx: number; msg: number; packet: number };
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
export type Action = ExecuteAction | ShareCredentialAction | SendMessageAction | ConnectAction;

export interface ActionResult {
  ok: boolean;
  message: string;
  lines?: string[];
}
