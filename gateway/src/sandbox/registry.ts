// ── Per-sandbox identity ──────────────────────────────────────────────────────
// Which sandbox is calling. There used to be a cache of sandbox NAMES here too,
// read by the fleet merge; identity replaced it and nothing asked the cache
// anything afterwards, so it is gone rather than kept warm for no reader.
//
// A sandbox reaches the proxy as sbx' host daemon, so the only thing that can
// carry identity is the credential in the upstream-proxy URL — see
// docs/ADR-sbx-identity.md and ../sbx-identity.ts. Huddle Node holds both halves
// because it is the side that writes that URL.

import { db } from '../db';
import { hashSandboxSecret, mintSandboxSecret } from '../sbx-identity';

export interface SandboxIdentity {
  name: string;
  secret: string;
}

/**
 * A FRESH secret for `name`, replacing whatever that name held before.
 *
 * Fresh, never reused: two sandboxes sharing a secret are one identity wearing
 * two names, and the audit trail merges them silently. Re-creating a name is
 * therefore a new box with a new credential, not a returning one — the old
 * secret stops being an identity the moment this runs.
 */
export function mintSandboxIdentity(name: string): SandboxIdentity {
  const secret = mintSandboxSecret();
  db.prepare(
    `INSERT INTO sandbox_identity (name, secret, secret_hash, created)
     VALUES (?, ?, ?, unixepoch())
     ON CONFLICT(name) DO UPDATE SET
       secret = excluded.secret, secret_hash = excluded.secret_hash, created = excluded.created`
  ).run(name, secret, hashSandboxSecret(secret));
  return { name, secret };
}

/**
 * Does this sandbox have an identity — i.e. did Huddle create it?
 *
 * Selects no columns, so asking the question cannot read the answer's secret —
 * which is the whole reason this is the only reader here besides minting. The
 * reconciler asks it to decide which boxes are Huddle's to widen, and a module
 * that manages policy rules should not be a place a credential can be read from.
 *
 * There is deliberately no getSandboxIdentity beside it. The secret is spent
 * once, at create, by whoever minted it; nothing reads it back, so no accessor
 * that returns it exists to be called by something that later thinks it needs
 * one.
 */
export function hasSandboxIdentity(name: string): boolean {
  return db.prepare('SELECT 1 FROM sandbox_identity WHERE name = ?').get(name) !== undefined;
}

/**
 * Forget a sandbox' identity. A sandbox does not outlive its credential — there
 * is no rotation story beyond this — so `sbx rm` and every failed create drop
 * the row rather than leave a secret that maps to no box.
 */
export function dropSandboxIdentity(name: string): void {
  db.prepare('DELETE FROM sandbox_identity WHERE name = ?').run(name);
}
