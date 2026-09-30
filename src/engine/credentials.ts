import { nextId, keyOf } from './core';
import { rand } from './rng';
import type { RngHolder } from './rng';
import type { Credential, GameState, Permission, PlayerId, SystemId } from './types';
import { gameTime } from './core';

export function newUniqueCode(s: GameState, h: RngHolder = s): string {
  const used = new Set(Object.values(s.credentials).map((c) => c.code));
  for (const m of Object.values(s.modules)) for (const layer of m.encryption) used.add(layer);
  for (;;) {
    const code = String(Math.floor(rand(h) * 10000)).padStart(4, '0');
    if (!used.has(code)) return code;
  }
}

export function createCredential(
  s: GameState,
  o: {
    owner: PlayerId;
    system: SystemId;
    module: string | null;
    fn?: string | null;
    permission: Permission;
    issuedBy: PlayerId | null;
  },
): Credential {
  const cred: Credential = {
    // The host's credentials are numbered apart (X1, X2...): Permissions never lists them, so sharing the
    // C series would leave gaps that give away who holds them.
    id: o.system === 'HIDDEN_HOST' ? nextId(s, 'xcred', 'X') : nextId(s, 'cred', 'C'),
    owner: o.owner,
    code: newUniqueCode(s),
    system: o.system,
    module: o.module,
    fn: o.fn ?? null,
    permission: o.permission,
    status: 'ACTIVE',
    issuedBy: o.issuedBy,
    createdAt: gameTime(s),
  };
  s.credentials[cred.id] = cred;
  return cred;
}

/** A workstation's own login: id W<n>, never changed or revoked, and never listed in Permissions. */
export function createWorkstationCredential(s: GameState, owner: PlayerId, h: RngHolder = s): Credential {
  const cred: Credential = {
    id: nextId(s, 'wcred', 'W'),
    owner,
    code: newUniqueCode(s, h),
    system: 'WORKSTATION',
    module: null,
    fn: null,
    permission: 'WRITE',
    status: 'ACTIVE',
    issuedBy: null,
    createdAt: gameTime(s),
    fixed: true,
  };
  s.credentials[cred.id] = cred;
  return cred;
}

export function findCredentialByCode(s: GameState, code: string): Credential | undefined {
  return Object.values(s.credentials).find((c) => c.code === code);
}

export { keyOf };
