import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Aikido regression on b35103b's rollback fix: registerSocketName replaces
// the row and mints a new revision on every call, so two authenticated
// starts (or a start racing `huddle migrate`) for the same containerName can
// interleave — the earlier request's rollback must not delete the row the
// later request has since re-established. See unregisterSocketNameIfCurrent's
// doc in db.ts.

let db: typeof import('../src/db').db;
let registerSocketName: typeof import('../src/db').registerSocketName;
let unregisterSocketName: typeof import('../src/db').unregisterSocketName;
let unregisterSocketNameIfCurrent: typeof import('../src/db').unregisterSocketNameIfCurrent;

beforeAll(async () => {
  const dbMod = await import('../src/db');
  db = dbMod.db;
  registerSocketName = dbMod.registerSocketName;
  unregisterSocketName = dbMod.unregisterSocketName;
  unregisterSocketNameIfCurrent = dbMod.unregisterSocketNameIfCurrent;
  dbMod.initDb();
});

beforeEach(() => {
  db.exec('DELETE FROM socket_registrations');
});

function currentRevision(name: string): string | undefined {
  return (db.prepare('SELECT revision FROM socket_registrations WHERE name = ?').get(name) as { revision: string } | undefined)?.revision;
}

describe('registerSocketName / unregisterSocketNameIfCurrent — race safety', () => {
  it('returns a fresh revision on every call, including a re-register of the same name', () => {
    const first = registerSocketName('dc-race');
    const second = registerSocketName('dc-race');
    expect(first).not.toBe(second);
    expect(currentRevision('dc-race')).toBe(second);
  });

  it('a rollback scoped to a superseded revision does not delete the row a later registration established', () => {
    // Request A registers first...
    const revisionA = registerSocketName('dc-race');
    // ...then request B, for the same name (e.g. a second authenticated start,
    // or `huddle migrate`), re-registers while A is still waiting/creating.
    const revisionB = registerSocketName('dc-race');
    expect(revisionA).not.toBe(revisionB);

    // A now fails and rolls back using the revision IT captured.
    unregisterSocketNameIfCurrent('dc-race', revisionA);

    // B's registration must survive untouched.
    expect(currentRevision('dc-race')).toBe(revisionB);
  });

  it('a rollback scoped to the current revision does delete the row (single-request case)', () => {
    const revision = registerSocketName('dc-solo');
    unregisterSocketNameIfCurrent('dc-solo', revision);
    expect(currentRevision('dc-solo')).toBeUndefined();
  });

  it('unregisterSocketName (unconditional) still removes a row regardless of revision', () => {
    registerSocketName('dc-unconditional');
    unregisterSocketName('dc-unconditional');
    expect(currentRevision('dc-unconditional')).toBeUndefined();
  });
});
