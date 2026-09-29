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

export const HIDDEN_HOST = '10.66.6.6';

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
          fn('REVOKE_CREDENTIAL', 'Revoke credential', 'WRITE', 'Disable a credential.', [
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
          fn('VIEW_CUSTOMERS', 'View customers', 'READ', 'Your customers, or all of them (needs a credential for all of Client Data): accounts, primary and banker.', [
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
        ],
      },
      {
        id: 'SETTLEMENT',
        label: 'Settlement',
        fns: [
          fn('SETTLE', 'Settle', 'WRITE', 'Pay out an approved payment.', [tx]),
          fn('REVERSE', 'Reverse', 'WRITE', 'Claw back a recently settled payment.', [tx]),
          fn('VIEW_SETTLEMENT', 'View settlement queue', 'READ', 'Approved payments waiting to be paid out (or all, including settled).', [inbox]),
        ],
      },
    ],
  },
  {
    id: 'BLACKHAT_DB',
    label: 'Unregistered host',
    address: HIDDEN_HOST,
    hidden: true,
    modules: [
      {
        id: 'BLACKNET',
        label: 'Blacknet',
        fns: [
          fn('READ_MESSAGES', 'Read messages', 'READ', 'The operatives message board.', [limit]),
          fn('POST_MESSAGE', 'Post message', 'WRITE', 'Post under an alias.', [
            { name: 'text', label: 'Message', kind: 'text' },
            { name: 'alias', label: 'Alias', kind: 'text', optional: true, placeholder: 'ghost' },
          ]),
        ],
      },
      {
        id: 'TARGET_LEDGER',
        label: 'Target Ledger',
        fns: [
          fn('VIEW_TARGETS', 'View targets', 'READ', 'Destination accounts for stolen funds.'),
          fn('SET_TARGET_STATUS', 'Set target status', 'WRITE', 'Mark an account READY / PREPARE / ABORT.', [
            { name: 'account', label: 'Account (5 digits)', kind: 'text', placeholder: '18392' },
            { name: 'status', label: 'Status', kind: 'select', options: ['READY', 'PREPARE', 'ABORT'] },
          ]),
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
            'REROUTE_IP',
            'Reroute IP',
            'WRITE',
            'For a limited time, make all your activity appear to come from another IP (Traces and Employee Records follow it). The longer the reroute, the louder the alert, and the more a trace of it reveals about your real workstation.',
            [
              { name: 'toIp', label: 'Appear as IP', kind: 'text', placeholder: '10.1.0.14' },
              { name: 'duration', label: 'Seconds', kind: 'select', options: ['10', '30', '60'] },
            ],
          ),
          fn(
            'CREATE_USER',
            'Create user',
            'WRITE',
            'Plant a fake employee in the bank\'s records. They show up in Employee Records and can be issued credentials from Permissions like any real employee.',
            [
              { name: 'name', label: 'Name', kind: 'text', placeholder: 'Dana Pruitt' },
              { name: 'role', label: 'Role', kind: 'select', options: ['SECURITY_ANALYST', 'SYSTEMS_ADMIN', 'IT_SPECIALIST', 'PERSONAL_BANKER', 'ACCOUNTS_RECEIVABLES'] },
              { name: 'ip', label: 'IP address', kind: 'text', placeholder: '10.1.0.30' },
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
            'Plant a fake Client Request from a customer to their banker, e.g. "we moved banks, make account X our primary". It looks like any other request in the queue.',
            [
              { name: 'customer', label: 'From customer', kind: 'text', placeholder: 'Tanaka Holdings or CU3' },
              { name: 'kind', label: 'Asking for', kind: 'select', options: ['SET_PRIMARY', 'ADD_AND_PRIMARY', 'ADD_ACCOUNT', 'REMOVE_ACCOUNT'] },
              { name: 'account', label: 'Account (5 digits)', kind: 'text', placeholder: '18392' },
              { name: 'text', label: 'Message', kind: 'text' },
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

// Overlapping on purpose: every critical step of the payment pipeline is reachable by 2-3 roles.
export const ROLES: Record<RoleId, RoleDef> = {
  SECURITY_ANALYST: {
    id: 'SECURITY_ANALYST',
    label: 'Security Analyst',
    creds: [
      c('SECURITY', 'MASTER_LOG', 'WRITE'), // tracing is part of the Master Log
      c('SECURITY', 'EMPLOYEE_RECORDS', 'WRITE'),
      c('TRANSACTIONS', 'RISK_CHECK', 'WRITE'),
    ],
  },
  SYSTEMS_ADMIN: {
    id: 'SYSTEMS_ADMIN',
    label: 'Systems Administrator',
    creds: [
      c('SECURITY', 'FIREWALL', 'WRITE'),
      c('SECURITY', 'MASTER_LOG', 'READ'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'SETTLEMENT', 'WRITE'),
    ],
  },
  IT_SPECIALIST: {
    id: 'IT_SPECIALIST',
    label: 'IT Specialist',
    creds: [
      c('SECURITY', 'PERMISSIONS', 'WRITE'),
      c('SECURITY', 'EMPLOYEE_RECORDS', 'WRITE'),
      c('CLIENT_DATA', null, 'READ'), // whole-system view for now (all customers, requests, verification); permissions to be reviewed
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'RISK_CHECK', 'WRITE'),
    ],
  },
  PERSONAL_BANKER: {
    id: 'PERSONAL_BANKER',
    label: 'Personal Banker',
    creds: [
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'WRITE'),
      c('CLIENT_DATA', 'CLIENT_REQUESTS', 'WRITE'),
      c('CLIENT_DATA', 'VERIFICATION', 'WRITE'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'AUTHORIZATION', 'WRITE'),
    ],
  },
  ACCOUNTS_RECEIVABLES: {
    id: 'ACCOUNTS_RECEIVABLES',
    label: 'Accounts & Receivables',
    creds: [
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'WRITE'),
      c('TRANSACTIONS', 'RISK_CHECK', 'WRITE'),
      c('TRANSACTIONS', 'AUTHORIZATION', 'WRITE'),
      c('TRANSACTIONS', 'SETTLEMENT', 'WRITE'),
    ],
  },
};

export const ROLE_ORDER: RoleId[] = [
  'SECURITY_ANALYST',
  'SYSTEMS_ADMIN',
  'IT_SPECIALIST',
  'PERSONAL_BANKER',
  'ACCOUNTS_RECEIVABLES',
];

export const DEFAULT_CONFIG: GameConfig = {
  durationSec: 40 * 60,
  whiteTarget: 200_000_000,
  blackTarget: 3_000_000,
  timeoutWinner: 'BLACK',
  blackHatCount: null,
  npcIntervalSec: 20,
  npcMinAmount: 500_000,
  npcMaxAmount: 4_000_000,
  maxManualAmount: 5_000_000,
  largeAmount: 3_500_000,
  recentModifySec: 300,
  reversalWindowSec: 180,
  traceMaxAgeSec: 180,
  traceCooldownSec: 30,
  lockoutAfterFails: 3,
  lockoutSec: 20,
  clockStart: 8 * 3600 + 30 * 60,
  autoProcess: false,
  autoProcessDelaySec: 15,
  requestIntervalSec: 45,
  requestChangeShare: 0.3,
  blockSec: 60,
  revokeCountdownSec: 30,
  crackRevealSec: 15,
};
