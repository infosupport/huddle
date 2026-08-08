import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// ── Ephemeral sudo grants ────────────────────────────────────────────────────
// A sudo grant temporarily sets a fresh password on the admin user 'noot' inside
// a container and locks the account again on expiry. The docker-exec boundary is
// injected (ContainerExec) so the lifecycle logic can be tested without a live
// docker daemon. The grants live in SQLite (table sudo_grants).
//
// better-sqlite3 is native; in a DMZ devcontainer without a built binding we
// skip (same probe as grants.test.ts / rules.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[sudo-grant.test] SKIPPED — better-sqlite3 binding not usable: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let getSudoGrant: typeof import('../src/db').getSudoGrant;
let getAllSudoGrants: typeof import('../src/db').getAllSudoGrants;
let getExpiredSudoGrants: typeof import('../src/db').getExpiredSudoGrants;
let setSudoGrant: typeof import('../src/db').setSudoGrant;

let sg: typeof import('../src/sudo-grant');

const CID = 'devcontainer-abc';

// Mock exec that records every call and returns a configurable exit code.
type Call = { container: string; cmd: string[]; stdin: string };
function makeExec(exitCode: number | null = 0) {
  const calls: Call[] = [];
  const exec = async (container: string, cmd: string[], stdin: string) => {
    calls.push({ container, cmd, stdin });
    return { exitCode };
  };
  return { exec, calls };
}

describe.skipIf(!sqliteAvailable)('sudo grants', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    getSudoGrant = dbMod.getSudoGrant;
    getAllSudoGrants = dbMod.getAllSudoGrants;
    getExpiredSudoGrants = dbMod.getExpiredSudoGrants;
    setSudoGrant = dbMod.setSudoGrant;
    dbMod.initDb();
    sg = await import('../src/sudo-grant');
  });
  beforeEach(() => { db.exec('DELETE FROM sudo_grants'); });
  afterEach(() => { vi.useRealTimers(); });

  describe('grantSudo', () => {
    it('sets the password via stdin, unlocks, and stores a grant with the correct until', async () => {
      const { exec, calls } = makeExec(0);
      const now = new Date('2026-06-01T12:00:00Z').getTime();
      const { password, until } = await sg.grantSudo(CID, 15, exec, now);

      expect(until).toBe(Math.floor(now / 1000) + 15 * 60);
      expect(getSudoGrant(CID)).toEqual({ until });

      // First exec = chpasswd with 'noot:<pw>' on stdin.
      expect(calls[0].cmd).toEqual(['chpasswd']);
      expect(calls[0].stdin).toBe(`noot:${password}\n`);
      // Second exec = explicit unlock.
      expect(calls[1].cmd).toEqual(['usermod', '-U', 'noot']);
    });

    it('FAIL CLOSED: on a non-zero exit from chpasswd it throws and stores NO grant', async () => {
      const { exec } = makeExec(1);
      await expect(sg.grantSudo(CID, 15, exec)).rejects.toThrow();
      expect(getSudoGrant(CID)).toBeUndefined();
    });

    it('overwrites an existing grant (extend) instead of duplicating it', async () => {
      const { exec } = makeExec(0);
      await sg.grantSudo(CID, 5, exec, 1000_000);
      await sg.grantSudo(CID, 30, exec, 1000_000);
      const rows = db.prepare('SELECT COUNT(*) as n FROM sudo_grants WHERE container_id = ?').get(CID) as { n: number };
      expect(rows.n).toBe(1);
      expect(getSudoGrant(CID)).toEqual({ until: 1000 + 30 * 60 });
    });
  });

  describe('injection resistance', () => {
    it('NEVER passes the password as a shell argument (only via stdin)', async () => {
      const { exec, calls } = makeExec(0);
      const { password } = await sg.grantSudo(CID, 15, exec);
      // No command argument contains the password.
      for (const c of calls) {
        for (const arg of c.cmd) expect(arg).not.toContain(password);
      }
      // chpasswd runs without a shell (no 'sh -c ...').
      expect(calls[0].cmd[0]).toBe('chpasswd');
      expect(calls[0].cmd).not.toContain('-c');
    });

    it('lock/unlock commands use only fixed arguments (no caller input)', () => {
      expect(sg.unlockCmd()).toEqual(['usermod', '-U', 'noot']);
      const lock = sg.lockCmd();
      expect(lock[0]).toBe('sh');
      expect(lock[1]).toBe('-c');
      // The sh string contains only the constant username, no interpolation.
      expect(lock[2]).not.toContain('$');
      expect(lock[2]).toContain('noot');
    });
  });

  describe('generateNootPassword', () => {
    it('provides sufficient entropy (>=20 base64url characters, url-safe alphabet)', () => {
      const a = sg.generateNootPassword();
      const b = sg.generateNootPassword();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(20);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('expiry detection', () => {
    it('getExpiredSudoGrants selects exactly the grants with until <= now', () => {
      setSudoGrant('c-verlopen', 1000);
      setSudoGrant('c-actief', 5000);
      const expired = getExpiredSudoGrants(2000);
      expect(expired).toEqual(['c-verlopen']);
    });

    it('a grant on the boundary (until == now) counts as expired', () => {
      setSudoGrant('c-grens', 3000);
      expect(getExpiredSudoGrants(3000)).toContain('c-grens');
    });
  });

  describe('sweepExpiredSudoGrants', () => {
    it('locks and removes only the expired grants; active ones remain', async () => {
      setSudoGrant('c-verlopen', 1000);
      setSudoGrant('c-actief', 9_999_999);
      const now = 2000 * 1000; // ms → nowSec 2000
      const { exec, calls } = makeExec(0);
      const locked = await sg.sweepExpiredSudoGrants(exec, now);

      expect(locked).toEqual(['c-verlopen']);
      // Only the expired container is locked.
      expect(calls.map(c => c.container)).toEqual(['c-verlopen']);
      expect(calls[0].cmd[0]).toBe('sh');
      // The expired grant's row is gone, the active one remains.
      expect(getSudoGrant('c-verlopen')).toBeUndefined();
      expect(getSudoGrant('c-actief')).toEqual({ until: 9_999_999 });
    });

    it('keeps the (still-expired) grant row when the lock exec throws, so a later sweep retries', async () => {
      setSudoGrant('c-weg', 1000);
      const exec = async () => { throw new Error('no such container'); };
      const locked = await sg.sweepExpiredSudoGrants(exec, 2000 * 1000);
      expect(locked).toEqual([]);
      // NOT dropped: the account may still be unlocked. The row stays expired so
      // the next sweep re-locks it once the container is reachable again.
      expect(getSudoGrant('c-weg')).toEqual({ until: 1000 });
    });

    it('keeps the grant row when the lock exec returns a non-zero exit', async () => {
      setSudoGrant('c-fail', 1000);
      const { exec } = makeExec(1);
      const locked = await sg.sweepExpiredSudoGrants(exec, 2000 * 1000);
      expect(locked).toEqual([]);
      expect(getSudoGrant('c-fail')).toEqual({ until: 1000 });
    });
  });

  describe('revokeSudo', () => {
    it('locks and removes the grant', async () => {
      setSudoGrant(CID, 9_999_999);
      const { exec, calls } = makeExec(0);
      await sg.revokeSudo(CID, exec);
      expect(calls[0].cmd[0]).toBe('sh'); // lock command
      expect(getSudoGrant(CID)).toBeUndefined();
    });

    it('marks the grant expired (for a later sweep) when the lock exec throws', async () => {
      setSudoGrant(CID, 9_999_999);
      const exec = async () => { throw new Error('container gone'); };
      await sg.revokeSudo(CID, exec, 5000 * 1000); // nowMs → nowSec 5000
      // NOT dropped (that would strand an unlocked account); set to expired-now so
      // the sweeper re-locks it and the UI immediately shows it as inactive.
      expect(getSudoGrant(CID)).toEqual({ until: 5000 });
      expect(getExpiredSudoGrants(5000)).toContain(CID);
    });

    it('getAllSudoGrants returns all grants as a map', () => {
      setSudoGrant('a', 111);
      setSudoGrant('b', 222);
      expect(getAllSudoGrants()).toEqual({ a: { until: 111 }, b: { until: 222 } });
    });
  });
});
