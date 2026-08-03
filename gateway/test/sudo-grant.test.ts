import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// ── Ephemere sudo-grants ─────────────────────────────────────────────────────
// Een sudo-grant zet tijdelijk een vers wachtwoord op de admin-gebruiker 'noot'
// binnen een container en lockt het account weer bij verval. De docker-exec-grens
// is geïnjecteerd (ContainerExec) zodat de lifecycle-logica zonder levende
// docker-daemon te testen valt. De grants leven in SQLite (tabel sudo_grants).
//
// better-sqlite3 is native; in een DMZ-devcontainer zonder gebouwde binding
// skippen we (zelfde probe als grants.test.ts / rules.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[sudo-grant.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let getSudoGrant: typeof import('../src/db').getSudoGrant;
let getAllSudoGrants: typeof import('../src/db').getAllSudoGrants;
let getExpiredSudoGrants: typeof import('../src/db').getExpiredSudoGrants;
let setSudoGrant: typeof import('../src/db').setSudoGrant;

let sg: typeof import('../src/sudo-grant');

const CID = 'devcontainer-abc';

// Mock-exec die elke aanroep vastlegt en een instelbare exit-code teruggeeft.
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
    it('zet het wachtwoord via stdin, unlockt, en slaat een grant met correcte until op', async () => {
      const { exec, calls } = makeExec(0);
      const now = new Date('2026-06-01T12:00:00Z').getTime();
      const { password, until } = await sg.grantSudo(CID, 15, exec, now);

      expect(until).toBe(Math.floor(now / 1000) + 15 * 60);
      expect(getSudoGrant(CID)).toEqual({ until });

      // Eerste exec = chpasswd met 'noot:<pw>' op stdin.
      expect(calls[0].cmd).toEqual(['chpasswd']);
      expect(calls[0].stdin).toBe(`noot:${password}\n`);
      // Tweede exec = expliciete unlock.
      expect(calls[1].cmd).toEqual(['usermod', '-U', 'noot']);
    });

    it('FAIL CLOSED: bij een niet-nul exit van chpasswd gooit hij en slaat GEEN grant op', async () => {
      const { exec } = makeExec(1);
      await expect(sg.grantSudo(CID, 15, exec)).rejects.toThrow();
      expect(getSudoGrant(CID)).toBeUndefined();
    });

    it('overschrijft een bestaande grant (verlengen) i.p.v. te dupliceren', async () => {
      const { exec } = makeExec(0);
      await sg.grantSudo(CID, 5, exec, 1000_000);
      await sg.grantSudo(CID, 30, exec, 1000_000);
      const rows = db.prepare('SELECT COUNT(*) as n FROM sudo_grants WHERE container_id = ?').get(CID) as { n: number };
      expect(rows.n).toBe(1);
      expect(getSudoGrant(CID)).toEqual({ until: 1000 + 30 * 60 });
    });
  });

  describe('injectie-weerbaarheid', () => {
    it('geeft het wachtwoord NOOIT als shell-argument mee (alleen via stdin)', async () => {
      const { exec, calls } = makeExec(0);
      const { password } = await sg.grantSudo(CID, 15, exec);
      // Geen enkel commando-argument bevat het wachtwoord.
      for (const c of calls) {
        for (const arg of c.cmd) expect(arg).not.toContain(password);
      }
      // chpasswd draait zonder shell (geen 'sh -c ...').
      expect(calls[0].cmd[0]).toBe('chpasswd');
      expect(calls[0].cmd).not.toContain('-c');
    });

    it('lock/unlock-commandos gebruiken alleen vaste argumenten (geen caller-input)', () => {
      expect(sg.unlockCmd()).toEqual(['usermod', '-U', 'noot']);
      const lock = sg.lockCmd();
      expect(lock[0]).toBe('sh');
      expect(lock[1]).toBe('-c');
      // De sh-string bevat alleen de constante gebruikersnaam, geen interpolatie.
      expect(lock[2]).not.toContain('$');
      expect(lock[2]).toContain('noot');
    });
  });

  describe('generateNootPassword', () => {
    it('levert voldoende entropie (>=20 base64url-tekens, url-safe alfabet)', () => {
      const a = sg.generateNootPassword();
      const b = sg.generateNootPassword();
      expect(a).not.toBe(b);
      expect(a.length).toBeGreaterThanOrEqual(20);
      expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('verval-detectie', () => {
    it('getExpiredSudoGrants selecteert precies de grants met until <= now', () => {
      setSudoGrant('c-verlopen', 1000);
      setSudoGrant('c-actief', 5000);
      const expired = getExpiredSudoGrants(2000);
      expect(expired).toEqual(['c-verlopen']);
    });

    it('een grant op de grens (until == now) telt als verlopen', () => {
      setSudoGrant('c-grens', 3000);
      expect(getExpiredSudoGrants(3000)).toContain('c-grens');
    });
  });

  describe('sweepExpiredSudoGrants', () => {
    it('lockt en verwijdert alleen de verlopen grants; actieve blijven staan', async () => {
      setSudoGrant('c-verlopen', 1000);
      setSudoGrant('c-actief', 9_999_999);
      const now = 2000 * 1000; // ms → nowSec 2000
      const { exec, calls } = makeExec(0);
      const locked = await sg.sweepExpiredSudoGrants(exec, now);

      expect(locked).toEqual(['c-verlopen']);
      // Alleen de verlopen container is gelockt.
      expect(calls.map(c => c.container)).toEqual(['c-verlopen']);
      expect(calls[0].cmd[0]).toBe('sh');
      // Rij van de verlopen grant is weg, de actieve blijft.
      expect(getSudoGrant('c-verlopen')).toBeUndefined();
      expect(getSudoGrant('c-actief')).toEqual({ until: 9_999_999 });
    });

    it('ruimt de grant-rij ook op als de lock-exec gooit (container weg)', async () => {
      setSudoGrant('c-weg', 1000);
      const exec = async () => { throw new Error('no such container'); };
      const locked = await sg.sweepExpiredSudoGrants(exec, 2000 * 1000);
      expect(locked).toEqual([]);
      expect(getSudoGrant('c-weg')).toBeUndefined();
    });
  });

  describe('revokeSudo', () => {
    it('lockt en verwijdert de grant', async () => {
      setSudoGrant(CID, 9_999_999);
      const { exec, calls } = makeExec(0);
      await sg.revokeSudo(CID, exec);
      expect(calls[0].cmd[0]).toBe('sh'); // lock-commando
      expect(getSudoGrant(CID)).toBeUndefined();
    });

    it('verwijdert de grant ook als de lock-exec gooit', async () => {
      setSudoGrant(CID, 9_999_999);
      const exec = async () => { throw new Error('container gone'); };
      await sg.revokeSudo(CID, exec);
      expect(getSudoGrant(CID)).toBeUndefined();
    });

    it('getAllSudoGrants geeft alle grants als map terug', () => {
      setSudoGrant('a', 111);
      setSudoGrant('b', 222);
      expect(getAllSudoGrants()).toEqual({ a: { until: 111 }, b: { until: 222 } });
    });
  });
});
