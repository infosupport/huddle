import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Tests for the root_grants db helpers: root voor de default vscode-user
// (vervangt de noot-dans). db-level, same sqlite probe as grants.test.ts. The
// exec/scheduler side (root-grant.ts) pulls in docker.ts and is covered by the
// tool-compat harness, not here.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch {
  sqliteAvailable = false;
}

let dbMod: typeof import('../src/db');
const CID = 'devcontainer-root';

describe.skipIf(!sqliteAvailable)('root grants', () => {
  beforeAll(async () => {
    dbMod = await import('../src/db');
    dbMod.initDb();
  });
  beforeEach(() => { dbMod.db.exec('DELETE FROM root_grants; DELETE FROM docker_grants;'); });

  it('sets, reads and deletes a time-boxed root grant', () => {
    const until = Math.floor(Date.now() / 1000) + 1800;
    dbMod.setRootGrant(CID, until);
    expect(dbMod.getRootGrant(CID)).toEqual({ until });
    dbMod.deleteRootGrant(CID);
    expect(dbMod.getRootGrant(CID)).toBeUndefined();
  });

  it('upserts (extends) instead of duplicating', () => {
    dbMod.setRootGrant(CID, 1000);
    dbMod.setRootGrant(CID, 2000);
    expect(dbMod.getRootGrant(CID)).toEqual({ until: 2000 });
    const n = (dbMod.db.prepare('SELECT COUNT(*) n FROM root_grants WHERE container_id=?').get(CID) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('getAllRootGrants returns a map keyed by container', () => {
    dbMod.setRootGrant('a', 1000);
    dbMod.setRootGrant('b', 2000);
    const all = dbMod.getAllRootGrants();
    expect(all.a).toEqual({ until: 1000 });
    expect(all.b).toEqual({ until: 2000 });
  });

  it('root and docker grants are independent tables', () => {
    dbMod.setGrant(CID, 1111);
    dbMod.setRootGrant(CID, 2222);
    expect(dbMod.getGrant(CID)).toEqual({ until: 1111 });
    expect(dbMod.getRootGrant(CID)).toEqual({ until: 2222 });
  });
});
