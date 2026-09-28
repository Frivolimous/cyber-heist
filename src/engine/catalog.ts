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

const target: ParamSpec = { name: 'target', label: 'Module', kind: 'module' };
const code4: ParamSpec = { name: 'code', label: '4-digit layer code', kind: 'text', placeholder: '0000' };
const limit: ParamSpec = { name: 'limit', label: 'Rows', kind: 'number', optional: true, placeholder: '25' };
const tx: ParamSpec = { name: 'txId', label: 'Transaction', kind: 'text', placeholder: 'TX-0001 or 1' };
const ben: ParamSpec = { name: 'beneficiaryId', label: 'Beneficiary', kind: 'text', placeholder: 'B1' };

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
          fn('VIEW_LOG', 'View log', 'READ', 'Read recent system activity.', [
            limit,
            { name: 'humansOnly', label: 'Hide system noise', kind: 'select', options: ['no', 'yes'], optional: true },
          ]),
        ],
      },
      {
        id: 'EMPLOYEE_RECORDS',
        label: 'Employee Records',
        fns: [fn('VIEW_EMPLOYEES', 'View employees', 'READ', 'Names, roles and registered workstation IPs.')],
      },
      {
        id: 'INTRUSION_DETECTION',
        label: 'Intrusion Detection',
        fns: [
          fn('VIEW_ALERTS', 'View alerts', 'READ', 'Recent security alerts.', [limit]),
          fn('TRACE', 'Trace log entry', 'WRITE', 'Reveal the origin IP of a log entry.', [
            { name: 'logId', label: 'Log entry', kind: 'text', placeholder: 'L12' },
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
        fns: [fn('VIEW_CUSTOMERS', 'View customers', 'READ', 'Customer names and accounts.')],
      },
      {
        id: 'BENEFICIARY_DATABASE',
        label: 'Beneficiary Database',
        fns: [
          fn('VIEW_BENEFICIARIES', 'View beneficiaries', 'READ', 'Payment destinations on file.'),
          fn('MODIFY_BENEFICIARY', 'Modify beneficiary account', 'WRITE', 'Change where a beneficiary is paid.', [
            ben,
            { name: 'newAccount', label: 'New account (5 digits)', kind: 'text', placeholder: '12345' },
          ]),
          fn('INVESTIGATE_CHANGES', 'Investigate changes', 'READ', 'Change history for one beneficiary.', [ben]),
        ],
      },
      {
        id: 'PERMISSIONS',
        label: 'Permissions',
        fns: [
          fn('VIEW_PERMISSIONS', 'View credentials', 'READ', 'All credentials (without codes).'),
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
      {
        id: 'VERIFICATION',
        label: 'Verification',
        fns: [fn('VERIFY_BENEFICIARY', 'Verify beneficiary', 'WRITE', 'Mark a beneficiary as verified.', [ben])],
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
          fn('CREATE_TRANSACTION', 'Create payment', 'WRITE', 'Queue a manual payment.', [
            ben,
            { name: 'amount', label: 'Amount', kind: 'number', placeholder: '1000000' },
          ]),
        ],
      },
      {
        id: 'RISK_CHECK',
        label: 'Risk Check',
        fns: [fn('RUN_RISK_CHECK', 'Run risk check', 'WRITE', 'Score a queued payment.', [tx])],
      },
      {
        id: 'AUTHORIZATION',
        label: 'Authorization',
        fns: [
          fn('APPROVE', 'Approve', 'WRITE', 'Approve a risk-checked payment.', [tx]),
          fn('REJECT', 'Reject', 'WRITE', 'Reject a payment permanently.', [tx]),
          fn('HOLD', 'Hold', 'WRITE', 'Pause a payment.', [tx]),
        ],
      },
      {
        id: 'SETTLEMENT',
        label: 'Settlement',
        fns: [
          fn('SETTLE', 'Settle', 'WRITE', 'Pay out an approved payment.', [tx]),
          fn('REVERSE', 'Reverse', 'WRITE', 'Claw back a recently settled payment.', [tx]),
          fn('VIEW_SETTLED', 'View settled', 'READ', 'Recently settled payments.', [limit]),
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
        id: 'CREDENTIAL_CACHE',
        label: 'Credential Cache',
        fns: [fn('VIEW_CACHE', 'View cache', 'READ', 'Credentials of White Hat staff held by operatives.')],
      },
    ],
  },
];

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
  module: string;
  permission: Permission;
}
export interface RoleDef {
  id: RoleId;
  label: string;
  creds: CredTemplate[];
}

const c = (system: SystemId, module: string, permission: Permission): CredTemplate => ({ system, module, permission });

// Overlapping on purpose: every critical step of the payment pipeline is reachable by 2-3 roles.
export const ROLES: Record<RoleId, RoleDef> = {
  SECURITY_ANALYST: {
    id: 'SECURITY_ANALYST',
    label: 'Security Analyst',
    creds: [
      c('SECURITY', 'MASTER_LOG', 'READ'),
      c('SECURITY', 'INTRUSION_DETECTION', 'WRITE'),
      c('SECURITY', 'EMPLOYEE_RECORDS', 'READ'),
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
      c('CLIENT_DATA', 'PERMISSIONS', 'WRITE'),
      c('SECURITY', 'EMPLOYEE_RECORDS', 'READ'),
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'READ'),
      c('TRANSACTIONS', 'PAYMENT_QUEUE', 'READ'),
      c('TRANSACTIONS', 'RISK_CHECK', 'WRITE'),
    ],
  },
  PERSONAL_BANKER: {
    id: 'PERSONAL_BANKER',
    label: 'Personal Banker',
    creds: [
      c('CLIENT_DATA', 'CUSTOMER_RECORDS', 'READ'),
      c('CLIENT_DATA', 'BENEFICIARY_DATABASE', 'WRITE'),
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
};
