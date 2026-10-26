// The sbx provider's state in the gateway DB, and who is calling on the sbx
// egress listener. Kept apart from sbx.ts so the provider stays testable with an
// in-memory store and no DB.

import {
  clearSandboxIdentities,
  deleteSetting,
  getSetting,
  sandboxByProxySecretHash,
  sandboxSpecJson,
  saveSandboxIdentity,
  setSetting,
} from '../db';
import type { SbxStore } from './sbx';
import type { SandboxSpec } from './types';
import { RESET_USER, hashProxySecret, newProxySecret, parseProxyAuthorization, sameSecret } from './sbx-egress';

const PROVIDER = 'sbx';
const ENABLED_KEY = 'sbx.egress.enabled';
const RESET_KEY = 'sbx.egress.resetSecret';
const ORIGINAL_PROXY_KEY = 'sbx.egress.originalProxy';

export const dbSbxStore: SbxStore = {
  enabled: () => getSetting(ENABLED_KEY) === '1',
  setEnabled: (on) => setSetting(ENABLED_KEY, on ? '1' : '0'),
  resetSecret() {
    let secret = getSetting(RESET_KEY);
    if (!secret) {
      secret = newProxySecret();
      setSetting(RESET_KEY, secret);
    }
    return secret;
  },
  originalProxy: () => getSetting(ORIGINAL_PROXY_KEY),
  setOriginalProxy: (value) => (value === null ? deleteSetting(ORIGINAL_PROXY_KEY) : setSetting(ORIGINAL_PROXY_KEY, value)),
  saveIdentity: (name, secretHash, spec) => saveSandboxIdentity(PROVIDER, name, secretHash, JSON.stringify(spec)),
  spec(name) {
    const json = sandboxSpecJson(PROVIDER, name);
    if (!json) return null;
    try {
      return JSON.parse(json) as SandboxSpec;
    } catch {
      return null;
    }
  },
  clearIdentities: () => clearSandboxIdentities(PROVIDER),
};

export type SbxCaller = { kind: 'sandbox'; name: string } | { kind: 'reset' } | { kind: 'unknown' };

/**
 * Who sent a request to the sbx egress listener, from its Proxy-Authorization.
 * The sbx daemon adds that header; the sandbox itself never sees the secret.
 */
export function identifySbxCaller(header: string | string[] | undefined, store: SbxStore = dbSbxStore): SbxCaller {
  if (!store.enabled()) return { kind: 'unknown' };
  const cred = parseProxyAuthorization(header);
  if (!cred || !cred.pass) return { kind: 'unknown' };
  if (cred.user === RESET_USER) {
    return sameSecret(cred.pass, store.resetSecret()) ? { kind: 'reset' } : { kind: 'unknown' };
  }
  // Looked up by hash, so the stored value is useless to whoever reads the DB.
  // The user name must match too: it is the name the secret was minted for.
  const name = sandboxByProxySecretHash(PROVIDER, hashProxySecret(cred.pass));
  return name && sameSecret(name, cred.user) ? { kind: 'sandbox', name } : { kind: 'unknown' };
}


/**
 * The `identify` of the sbx egress listener: a known sandbox becomes rule scope
 * `sbx:<name>`, anyone else is turned away. The reset secret is turned away too,
 * but first sets off `onReset` (recreate everything).
 */
export function sbxEgressIdentify(onReset: () => void, store: SbxStore = dbSbxStore) {
  return (req: { headers: Record<string, string | string[] | undefined> }): string | null => {
    const caller = identifySbxCaller(req.headers['proxy-authorization'], store);
    if (caller.kind === 'reset') onReset();
    return caller.kind === 'sandbox' ? `sbx:${caller.name}` : null;
  };
}
