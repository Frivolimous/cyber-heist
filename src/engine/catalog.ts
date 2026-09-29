// Data-driven definition of the bank network: systems > modules > functions,
// plus roles and default tuning. Add mechanics here first, then add a handler.

import type { GameConfig, Permission, RoleId, SystemId } from './types';

export type ParamKind = 'text' | 'number' | 'player' | 'module' | 'scope' | 'select';

export interface ParamSpec {
  name: string;
  label: string;
  kind: ParamKind;
  options?: string[];
  optional?: boolean;
  placeholder?: string;
}

export interface FnDef {
  id: string;
  label: string;
  permission: Permission;
  description: string;
  params: ParamSpec[];
}

export interface ModuleDef {
  id: string;
  label: string;
  fns: FnDef[];
}

export interface SystemDef {
  id: SystemId;
  label: string;
  address: string; // network address typed into a window's address bar
  hidden?: boolean;
  modules: ModuleDef[];
}

const fn = (
  id: string,
  label: string,
  permission: Permission,
  description: string,
  params: ParamSpec[] = [],
): FnDef => ({ id, label, permission, description, params });

const address: ParamSpec = { name: 'address', label: 'Address', kind: 'text', placeholder: '10.1.0.12' };
const target: ParamSpec = { name: 'target', label: 'Module', kind: 'module' };
const code4: ParamSpec = { name: 'code', label: '4-digit layer code', kind: 'text', placeholder: '0000' };
const limit: ParamSpec = { name: 'limit', label: 'Rows', kind: 'number', optional: true, placeholder: '25' };
const tx: ParamSpec = { name: 'txId', label: 'Transaction', kind: 'text', placeholder: 'TX-0001 or 1' };
/** The customer being paid. Payments land in that customer's primary account. */
const ben: ParamSpec = { name: 'beneficiaryId', label: 'Beneficiary', kind: 'text', placeholder: 'CU1' };
const cust: ParamSpec = { name: 'customerId', label: 'Customer', kind: 'text', placeholder: 'CU1' };
const account: ParamSpec = { name: 'account', label: 'Account (5 digits)', kind: 'text', placeholder: '12345' };
/** Stage inboxes: PENDING = waiting for this stage, ALL = also what this stage recently handled. */
const reason: ParamSpec = { name: 'reason', label: 'Reason', kind: 'text', placeholder: 'why?' };
const requestParam: ParamSpec = { name: 'requestId', label: 'Request', kind: 'text', placeholder: 'REQ-1 or 1' };
const inbox: ParamSpec = { name: 'show', label: 'Show', kind: 'select', options: ['PENDING', 'ALL'], optional: true };


/** Encryption layers (Firewall add/remove/bypass + layer codes on every function) are switched off for now. */
export const ENCRYPTION_ENABLED = false;

export const SYSTEMS: SystemDef[] = [
  {
    id: 'SECURITY',
    label: 'Security Systems',
    address: '10.0.0.10',
    modules: [
      {
        id: 'FIREWALL',
        label: 'Firewall',
        fns: [
          // Encryption layers are disabled: re-add these to bring them back (handlers and checks still exist).
          ...(ENCRYPTION_ENABLED
            ? [
                fn('ADD_ENCRYPTION', 'Add encryption layer', 'WRITE', 'Lock a module behind a 4-digit code.', [target, code4]),
                fn('REMOVE_ENCRYPTION', 'Remove encryption layer', 'WRITE', 'Remove a layer. You must know its code.', [target, code4]),
                fn('BYPASS_ENCRYPTION', 'Bypass encryption', 'WRITE', 'Strip all layers from a module. Raises an alert.', [target]),
              ]
            : []),
          fn('VIEW_STATUS', 'View firewall status', 'READ', 'Every module (online, security on or off), active blocks, and pending revocations.'),
          fn('SET_SECURITY', 'Set module security', 'WRITE', 'Switch a module\'s security off (no code needed, use is anonymous) or back on.', [
            target,
            { name: 'security', label: 'Security', kind: 'select', options: ['ON', 'OFF'] },
          ]),
          fn('BLOCK_ADDRESS', 'Block address', 'WRITE', 'Cut an address (workstation or system) off the network for a minute.', [address]),
          fn('UNBLOCK_ADDRESS', 'Unblock address', 'WRITE', 'Lift a block early.', [address]),
          fn('REVOKE_ALL_ACCESS', 'Revoke all access', 'WRITE', 'Permanently cut an address off (and revoke a workstation owner\'s credentials) after a countdown.', [address]),
          fn('CANCEL_REVOCATION', 'Cancel revocation', 'WRITE', 'Stop a "revoke all access" before its countdown ends.', [
            { name: 'revocationId', label: 'Revocation', kind: 'text', placeholder: 'R1' },
          ]),
          fn('SET_MODULE_STATUS', 'Set module online/offline', 'WRITE', 'Take a module offline or bring it back.', [
            target,
            { name: 'status', label: 'Status', kind: 'select', options: ['ONLINE', 'OFFLINE'] },
          ]),
        ],
      },
      {
        id: 'MASTER_LOG',
        label: 'Master Log',
        fns: [
          fn('VIEW_LOG', 'View log', 'READ', 'Recent activity: player actions, everything, or security alerts.', [
            limit,
            { name: 'show', label: 'Show', kind: 'select', options: ['PLAYERS', 'ALL', 'ALERTS'], optional: true },
          ]),
          fn('TRACE', 'Trace log entry', 'WRITE', 'Reveal the workstation a log entry came from.', [
            { name: 'logId', label: 'Log entry', kind: 'text', placeholder: 'L12' },
          ]),
        ],
      },
      {
        id: 'EMPLOYEE_RECORDS',
        label: 'Employee Records',
        fns: [
          fn('VIEW_EMPLOYEES', 'View employees', 'READ', 'Names, roles, workstation IPs, last activity, failed attempts, lockouts and blocks.'),
          fn('RESET_LOCKOUT', 'Reset lockout timer', 'WRITE', 'Unlock a locked-out workstation now.', [
            { name: 'address', label: 'Workstation', kind: 'text', placeholder: '10.1.0.12' },
          ]),
        ],
      },
      {
        id: 'PERMISSIONS',
        label: 'Permissions',
        fns: [
          fn('VIEW_PERMISSIONS', 'View credentials', 'READ', 'Credentials on record (without codes): active ones, or all including revoked.', [
            { name: 'show', label: 'Show', kind: 'select', options: ['ACTIVE', 'ALL'], optional: true },
          ]),
          fn('CREATE_CREDENTIAL', 'Create credential', 'WRITE', 'Issue a new credential to any employee.', [
            { name: 'owner', label: 'Issue to', kind: 'player' },
            { name: 'scope', label: 'Scope', kind: 'scope' },
            { name: 'permission', label: 'Permission', kind: 'select', options: ['READ', 'WRITE'] },
          ]),
          fn('REVOKE_CREDENTIAL', 'Revoke credential', 'WRITE', 'Disable a credential. Firewall or Permissions write credentials are revoked after a countdown.', [
            { name: 'credentialId', label: 'Credential', kind: 'text', placeholder: 'C5' },
          ]),
          fn('CANCEL_REVOKE', 'Cancel a revocation', 'WRITE', 'Stop a credential revocation that is still counting down.', [
            { name: 'credentialId', label: 'Credential', kind: 'text', placeholder: 'C5' },
          ]),
        ],
      },
    ],
  },
  {
    id: 'CLIENT_DATA',
    label: 'Client Data',
    address: '10.0.0.20',
    modules: [
      {
        id: 'CUSTOMER_RECORDS',
        label: 'Customer Records',
        fns: [
          fn('VIEW_CUSTOMERS', 'View customers', 'READ', 'Customers with their accounts, primary and banker. Personal Bankers see their own customers; everyone else sees all of them.', [
            { name: 'show', label: 'Show', kind: 'select', options: ['MINE', 'ALL'], optional: true },
          ]),
          fn('ADD_ACCOUNT', 'Add account', 'WRITE', 'Attach an account number to a customer, optionally as their primary.', [
            cust,
            account,
            { name: 'makePrimary', label: 'Make it primary', kind: 'select', options: ['NO', 'YES'], optional: true },
            { ...requestParam, optional: true },
          ]),
          fn('REMOVE_ACCOUNT', 'Remove account', 'WRITE', 'Detach an account from a customer. Not their primary, and not their last one.', [
            cust,
            account,
            { ...requestParam, optional: true },
          ]),
          fn('SET_PRIMARY', 'Set primary account', 'WRITE', 'Choose which of a customer\'s accounts receives their payments.', [
            cust,
            account,
            { ...requestParam, optional: true },
          ]),
        ],
      },
      {
        id: 'CLIENT_REQUESTS',
        label: 'Client Requests',
        fns: [
          fn('VIEW_REQUESTS', 'View requests', 'READ', 'Messages from customers to their personal banker. A whole-system Client Data credential sees every banker\'s.', [
            { name: 'show', label: 'Show', kind: 'select', options: ['OPEN', 'ALL'], optional: true },
          ]),
          fn('ARCHIVE_REQUEST', 'Archive request', 'WRITE', 'Close a request without acting on it. Needs a reason.', [requestParam, reason]),
        ],
      },
      {
        id: 'VERIFICATION',
        label: 'Verification',
        fns: [
          fn('VIEW_VERIFICATION', 'View verification queue', 'READ', 'Account changes waiting for verification (or all recent ones).', [
            { name: 'show', label: 'Show', kind: 'select', options: ['PENDING', 'ALL'], optional: true },
          ]),
          fn('INVESTIGATE_CHANGES', 'Investigate changes', 'READ', 'Every change to one customer\'s accounts, or to one account across all customers.', [
            { name: 'target', label: 'Customer or account', kind: 'text', placeholder: 'CU3 or 12345' },
          ]),
          fn('VERIFY_CHANGE', 'Verify change', 'WRITE', 'Mark one account change as verified.', [
            { name: 'changeId', label: 'Change', kind: 'text', placeholder: 'CH-1 or 1' },
          ]),
        ],
      },
    ],
  },
  {
    id: 'TRANSACTIONS',
    label: 'Transaction Processing',
    address: '10.0.0.30',
    modules: [
      {
        id: 'PAYMENT_QUEUE',
        label: 'Payment Queue',
        fns: [
          fn('VIEW_QUEUE', 'View queue', 'READ', 'Pending payments.', [
            { name: 'show', label: 'Show', kind: 'select', options: ['ACTIVE', 'ALL'], optional: true },
          ]),
          fn('CREATE_TRANSACTION', 'Create payment', 'WRITE', 'Queue a manual payment from a customer account.', [
            { name: 'originAccount', label: 'Originator account (5 digits)', kind: 'text', placeholder: '12345' },
            ben,
            { name: 'amount', label: 'Amount', kind: 'number', placeholder: '1000000' },
            { ...requestParam, optional: true },
          ]),
        ],
      },
      {
        id: 'RISK_CHECK',
        label: 'Risk Check',
        fns: [
          fn('VIEW_RISK_QUEUE', 'View risk queue', 'READ', 'Payments waiting for a risk check (or all checked but not yet approved).', [inbox]),
          fn('RUN_RISK_CHECK', 'Score risk', 'WRITE', 'Give a queued payment a risk score, with a reason.', [
            tx,
            { name: 'score', label: 'Score', kind: 'select', options: ['LOW', 'MEDIUM', 'HIGH'] },
            reason,
          ]),
          fn('SET_AUTO_SCORE', 'Automatic scoring', 'WRITE', 'Score routine payments LOW automatically. A max amount of 0 switches it off.', [
            { name: 'maxAmount', label: 'Max amount', kind: 'number', placeholder: '1000000' },
            { name: 'source', label: 'Payments', kind: 'select', options: ['AUTOMATIC', 'ALL'] },
            { name: 'origin', label: 'Paid from', kind: 'select', options: ['CUSTOMER', 'ANY'] },
            { name: 'payee', label: 'Payee primary', kind: 'select', options: ['VERIFIED', 'ANY'] },
          ]),
        ],
      },
      {
        id: 'AUTHORIZATION',
        label: 'Authorization',
        fns: [
          fn('VIEW_AUTH_QUEUE', 'View authorization queue', 'READ', 'Risk-checked payments waiting for a decision (or all decided but not settled).', [inbox]),
          fn('APPROVE', 'Approve', 'WRITE', 'Approve a risk-checked payment.', [tx, { ...reason, optional: true }]),
          fn('REJECT', 'Reject', 'WRITE', 'Reject a payment permanently. Needs a reason.', [tx, reason]),
          fn('HOLD', 'Hold', 'WRITE', 'Pause a payment. Needs a reason.', [tx, reason]),
          fn('SET_AUTO_APPROVE', 'Automatic approval', 'WRITE', 'Approve risk-checked payments at or below a risk level automatically. HIGH raises an alert.', [
            { name: 'level', label: 'Up to', kind: 'select', options: ['NONE', 'LOW', 'MEDIUM', 'HIGH'] },
          ]),
        ],
      },
      {
        id: 'SETTLEMENT',
        label: 'Settlement',
        fns: [
          fn('SETTLE', 'Settle', 'WRITE', 'Pay out an approved payment.', [tx]),
          fn('REVERSE', 'Reverse', 'WRITE', 'Claw back a recently settled payment.', [tx]),
          fn('VIEW_SETTLEMENT', 'View settlement queue', 'READ', 'Approved payments waiting to be paid out (or all, including settled).', [inbox]),
          fn('SET_AUTO_SETTLE', 'Automatic settlement', 'WRITE', 'Settle approved payments up to an amount automatically. 0 switches it off.', [
            { name: 'maxAmount', label: 'Max amount', kind: 'number', placeholder: '1000000' },
          ]),
        ],
      },
    ],
  },
  {
    id: 'BLACKHAT_DB',
    label: 'Unregistered host',
    address: '', // random each game: GameState.hiddenHost (use systemAddress)
    hidden: true,
    modules: [
      {
        id: 'BLACKNET',
        label: 'Blacknet',
        fns: [
          fn('READ_MESSAGES', 'Read messages', 'READ', 'The operatives message board.', [limit]),
          fn('POST_MESSAGE', 'Post message', 'WRITE', 'Post under an alias.', [
            { name: 'alias', label: 'Alias', kind: 'text', optional: true, placeholder: 'ghost' },
          ]),
        ],
      },
      {
        id: 'TARGET_LEDGER',
        label: 'Target Ledger',
        fns: [
          fn('VIEW_TARGETS', 'View targets', 'READ', 'Destination accounts for stolen funds: whose they are and what they hold.'),
        ],
      },
      {
        id: 'HOST_LOG',
        label: 'Host Log',
        fns: [
          fn('VIEW_HOST_LOG', 'View host log', 'READ', 'Activity on this host, and alerts when the bank traces it.', [
            { name: 'show', label: 'Show', kind: 'select', options: ['ALL', 'ALERTS'], optional: true },
          ]),
        ],
      },
      {
        id: 'CREDENTIAL_CACHE',
        label: 'Credential Cache',
        fns: [fn('VIEW_CACHE', 'View cache', 'READ', 'Credentials of White Hat staff held by operatives.')],
      },
      // Tool kits: each operative is dealt one or two at random each game.
      {
        id: 'INFILTRATION',
        label: 'Infiltration',
        fns: [
          fn(
            'CREATE_PROXY',
            'Create proxy',
            'WRITE',
            'Set up an unused IP address as a proxy on the host. Reroute IP and Create user can only use proxies. Any operative can use any proxy.',
            [{ name: 'ip', label: 'Proxy IP (unused)', kind: 'text', placeholder: '10.1.0.77' }],
          ),
          fn(
            'REROUTE_IP',
            'Reroute IP',
            'WRITE',
            'For a number of seconds, make an address appear as one of the proxies in every log, alert and trace: your own workstation, any other workstation, or the server itself. A proxy that is blocked, carrying another reroute or used by a planted user is unavailable.',
            [
              { name: 'source', label: 'Reroute IP (blank: your own)', kind: 'text', placeholder: '10.1.0.14' },
              { name: 'proxy', label: 'Proxy', kind: 'text', placeholder: '10.1.0.77' },
              { name: 'seconds', label: 'Seconds (1-60)', kind: 'text', placeholder: '10' },
            ],
          ),
          fn(
            'CREATE_USER',
            'Create user',
            'WRITE',
            'Plant a fake employee in the bank\'s records, at one of the proxies. They show up in Employee Records and can be issued credentials from Permissions like any real employee.',
            [
              { name: 'name', label: 'Name', kind: 'text', placeholder: 'Dana Pruitt' },
              { name: 'role', label: 'Role', kind: 'select', options: ['PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES', 'IT_SPECIALIST', 'BANK_MANAGER'] },
              { name: 'proxy', label: 'Proxy', kind: 'text', placeholder: '10.1.0.77' },
            ],
          ),
        ],
      },
      {
        id: 'SOCIAL',
        label: 'Social',
        fns: [
          fn(
            'SPOOFED_MESSAGE',
            'Spoofed message',
            'WRITE',
            'Send a private message that appears to come from someone else. It lands in the recipient\'s inbox but never in the impersonated sender\'s history, so comparing notes exposes it. Made-up names work, but are easier to spot as fakes.',
            [
              { name: 'to', label: 'To (employee)', kind: 'text', placeholder: 'Sarah' },
              { name: 'from', label: 'Appear from', kind: 'text', placeholder: 'Mike' },
              { name: 'text', label: 'Message', kind: 'text' },
            ],
          ),
          fn(
            'SCAM_REQUEST',
            'Scam request',
            'WRITE',
            'Plant a fake Client Request from a customer to their banker: "we moved banks, make account X our primary", or "please pay $400,000 to Y from our main account". It is worded like real requests and looks like any other request in the queue.',
            [
              { name: 'customer', label: 'From customer', kind: 'text', placeholder: 'Tanaka Holdings or CU3' },
              { name: 'kind', label: 'Asking for', kind: 'select', options: ['PAYMENT', 'SET_PRIMARY', 'ADD_AND_PRIMARY', 'ADD_ACCOUNT', 'REMOVE_ACCOUNT'] },
              { name: 'account', label: 'Account (5 digits, account requests)', kind: 'text', placeholder: '18392' },
              { name: 'payee', label: 'Pay to (payment)', kind: 'text', placeholder: 'Northwind Freight or CU7' },
              { name: 'amount', label: 'Amount (payment)', kind: 'text', placeholder: '400000' },
              { name: 'urgent', label: 'Urgent (payment)', kind: 'select', options: ['NO', 'YES'] },
            ],
          ),
        ],
      },
      {
        id: 'CLEANUP',
        label: 'Cleanup',
        fns: [
          fn('LOG_WIPER', 'Log wiper', 'WRITE', 'Delete one Master Log entry. The gap in the log ids stays visible, and the entry can still be traced until it ages out.', [
            { name: 'logId', label: 'Log entry', kind: 'text', placeholder: 'L12' },
          ]),
          fn(
            'ALERT_MUTE',
            'Alert mute',
            'WRITE',
            'Suppress the bank\'s minor security alerts for 10s. Only minor alerts are hidden; loud and reckless alerts, including this tool\'s own, always get through.',
          ),
        ],
      },
      {
        id: 'ACCESS',
        label: 'Access',
        fns: [
          fn('CRACK_CODE', 'Code crack', 'WRITE', 'Slowly brute-force a random credential that can reach a module: one digit recovered roughly every 15s (about a minute for all four). Each reveal raises an alert, so defenders can revoke it, block you, or warn the owner.', [target]),
          fn('UNLOCK_WORKSTATION', 'Unlock workstation', 'WRITE', 'Make a new login credential for another workstation. It takes 30s, and a block on your address or theirs stops it. The new code never shows in Permissions, only as a gap in the credential ids.', [
            { name: 'target', label: 'Workstation', kind: 'text', placeholder: '10.1.0.12' },
          ]),
          fn('LOCKOUT_BOMB', 'Lockout bomb', 'WRITE', 'Force failed logins from a workstation until it locks itself out. Pure disruption: knock a defender offline for a while.', [
            { name: 'target', label: 'Workstation', kind: 'text', placeholder: '10.1.0.12' },
          ]),
        ],
      },
    ],
  },
];

/** Hidden host modules every operative can use. */
export const HOST_SHARED_MODULES = ['BLACKNET', 'TARGET_LEDGER', 'HOST_LOG', 'CREDENTIAL_CACHE'];
/** Hidden host tool kits, dealt to operatives at random (more kits than operatives, so some go unused). */
export const HOST_KITS = ['INFILTRATION', 'SOCIAL', 'CLEANUP', 'ACCESS'];

export function findSystem(id: string): SystemDef | undefined {
  return SYSTEMS.find((s) => s.id === id);
}
export function findModule(system: string, module: string): ModuleDef | undefined {
  return findSystem(system)?.modules.find((m) => m.id === module);
}
export function findFn(system: string, module: string, fnId: string): FnDef | undefined {
  return findModule(system, module)?.fns.find((f) => f.id === fnId);
}

// ---- Roles ---------------------------------------------------------------

export interface CredTemplate {
  system: SystemId;
  module: string | null; // null = the whole system
  permission: Permission;
}
export interface RoleDef {
  id: RoleId;
  label: string;
  creds: CredTemplate[];
}

const c = (system: SystemId, module: string | null, permission: Permission): CredTemplate => ({ system, module, permission });

// Separation of duties: Personal Bankers change accounts and start payments; Accounts & Receivables (and the
// Bank Manager) verify those changes, score risk and settle. IT runs security; the Bank Manager oversees.
// Personal Bankers are scoped to their own customers; every other role reads all of them (see handlers).
export const ROLES: Record<RoleId, RoleDef> = {
  PERSONAL_BANKER: {
    id: 'PERSONAL_BANKER',
    label: 'Personal Banker',
    creds: [
      c('SECURITY', 'EMPLOYEE_RECORDS', 'READ'),
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'WRITE'),
      c('CLIENT_DATA', 'CLIENT_REQUESTS', 'WRITE'),
      c('CLIENT_DATA', 'VERIFICATION', 'READ'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'WRITE'),
      c('TRANSACTIONS', 'RISK_CHECK', 'READ'),
      c('TRANSACTIONS', 'AUTHORIZATION', 'WRITE'),
      c('TRANSACTIONS', 'SETTLEMENT', 'READ'),
    ],
  },
  ACCOUNTS_RECEIVABLES: {
    id: 'ACCOUNTS_RECEIVABLES',
    label: 'Accounts & Receivables',
    creds: [
      c('SECURITY', 'EMPLOYEE_RECORDS', 'READ'),
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'READ'),
      c('CLIENT_DATA', 'VERIFICATION', 'WRITE'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'RISK_CHECK', 'WRITE'),
      c('TRANSACTIONS', 'AUTHORIZATION', 'READ'),
      c('TRANSACTIONS', 'SETTLEMENT', 'WRITE'),
    ],
  },
  IT_SPECIALIST: {
    id: 'IT_SPECIALIST',
    label: 'IT Specialist',
    creds: [
      c('SECURITY', 'FIREWALL', 'WRITE'),
      c('SECURITY', 'MASTER_LOG', 'WRITE'), // tracing is part of the Master Log
      c('SECURITY', 'EMPLOYEE_RECORDS', 'WRITE'),
      c('SECURITY', 'PERMISSIONS', 'WRITE'),
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'READ'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
    ],
  },
  BANK_MANAGER: {
    id: 'BANK_MANAGER',
    label: 'Bank Manager',
    creds: [
      c('SECURITY', 'FIREWALL', 'READ'),
      c('SECURITY', 'MASTER_LOG', 'WRITE'),
      c('SECURITY', 'EMPLOYEE_RECORDS', 'READ'),
      c('SECURITY', 'PERMISSIONS', 'WRITE'),
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'READ'),
      c('CLIENT_DATA', 'CLIENT_REQUESTS', 'READ'), // reads every banker's requests (see handlers)
      c('CLIENT_DATA', 'VERIFICATION', 'WRITE'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'RISK_CHECK', 'READ'),
      c('TRANSACTIONS', 'AUTHORIZATION', 'READ'),
      c('TRANSACTIONS', 'SETTLEMENT', 'WRITE'),
    ],
  },
};

/** Display order for roles (sandbox lists, planted-user role picker). */
export const ROLE_ORDER: RoleId[] = ['PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES', 'IT_SPECIALIST', 'BANK_MANAGER'];

/** The smallest game the role formulas support. */
export const MIN_PLAYERS = 6;
/** A hard cap for now, so nothing has to scale past it yet (may be raised or lowered later). */
export const MAX_PLAYERS = 30;

/**
 * How many of each role a game of `n` players gets. Always exactly one Bank Manager; IT and Personal
 * Bankers grow with the table; Accounts & Receivables take the rest.
 */
export function roleCounts(n: number): Record<RoleId, number> {
  const it = 1 + Math.floor((n - 2) / 6);
  const pb = 2 + Math.ceil((n - 6) / 2);
  return { BANK_MANAGER: 1, IT_SPECIALIST: it, PERSONAL_BANKER: pb, ACCOUNTS_RECEIVABLES: n - 1 - it - pb };
}

/** How many Black Hats a game of `n` players gets (unless the config fixes it). */
export const hackerCount = (n: number): number => Math.floor(n / 3);

export const DEFAULT_CONFIG: GameConfig = {
  durationSec: 20 * 60,
  whiteTargetPerPlayer: 15_000_000,
  blackTargetPerHacker: 1_000_000,
  volumePerPlayer: 17_400_000, // 1.16x the target: room for held, rejected and missed payments
  requestEverySecPerBanker: 90,
  customersPerBanker: 3,
  // Derived at game creation (scaledConfig); these are the 10-player values, for reference only.
  whiteTarget: 150_000_000,
  blackTarget: 3_000_000,
  blackHatCount: null,
  npcIntervalSec: 19.6,
  npcMinAmount: 165_000,
  npcMaxAmount: 1_320_000,
  requestMinAmount: 500_000,
  requestMaxAmount: 5_000_000,
  requestAmountFactor: 2.18,
  maxManualAmount: 10_000_000,
  largeAmount: 3_500_000,
  recentModifySec: 300,
  reversalWindowSec: 180,
  traceMaxAgeSec: 180,
  traceCooldownSec: 30,
  lockoutAfterFails: 3,
  lockoutSec: 20,
  automation: { scoreMax: 1_000_000, scoreSource: 'AUTOMATIC', scoreOrigin: 'CUSTOMER', scorePayee: 'VERIFIED', approveUpTo: 'LOW', settleMax: 1_000_000 },
  requestIntervalSec: 22.5, // derived
  requestChangeShare: 0.3,
  requestDeadlineSec: 120,
  urgentDeadlineSec: 60,
  urgentShare: 0.25,
  strikesToSuspend: 2,
  phishPerBankerMin: 1,
  phishPerBankerMax: 5,
  blockSec: 60,
  revokeCountdownSec: 30,
  unlockSec: 30,
  crackRevealSec: 15,
};
