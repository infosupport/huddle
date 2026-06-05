import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';

// ── Boundary B — docker-access grants ────────────────────────────────────────
// Grants gate of een devcontainer de Docker-socket-proxy mag bereiken. Ze leven
// in SQLite (tabel docker_grants) en zijn time-boxed: na `until` (unix-seconden)
// is de grant verlopen. De API-routes (PUT/DELETE /api/authz/grants/:container)
// zijn dunne wrappers om de db-helpers; we testen hier de helpers — dat is de
// echte lifecycle-logica — plus de 1–120-min validatie die in api.ts zit.
//
// better-sqlite3 is native; in een DMZ-devcontainer zonder gebouwde binding
// skippen we (zelfde probe als rules.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[grants.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let setGrant: typeof import('../src/db').setGrant;
let getGrant: typeof import('../src/db').getGrant;
let getAllGrants: typeof import('../src/db').getAllGrants;
let deleteGrant: typeof import('../src/db').deleteGrant;

const CID = 'devcontainer-abc';

// Spiegelt de validatie uit api.ts (PUT /api/authz/grants/:container):
// minutes moet 1–120 zijn, anders 400.
function validMinutes(minutes: number): boolean {
  return !(!minutes || minutes < 1 || minutes > 120);
}

function isActive(containerId: string): boolean {
  const g = getGrant(containerId);
  return !!g && g.until > Math.floor(Date.now() / 1000);
}

describe.skipIf(!sqliteAvailable)('docker grants', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    setGrant = dbMod.setGrant;
    getGrant = dbMod.getGrant;
    getAllGrants = dbMod.getAllGrants;
    deleteGrant = dbMod.deleteGrant;
    dbMod.initDb();
  });
  beforeEach(() => { db.exec('DELETE FROM docker_grants'); });
  afterEach(() => { vi.useRealTimers(); });

  describe('aanmaken (PUT)', () => {
    it('slaat een grant op met een until in de toekomst', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const minutes = 15;
      const until = Math.floor(Date.now() / 1000) + minutes * 60;
      setGrant(CID, until);
      expect(getGrant(CID)).toEqual({ until });
      expect(isActive(CID)).toBe(true);
    });

    it('overschrijft een bestaande grant (verlengen) i.p.v. te dupliceren', () => {
      setGrant(CID, 1000);
      setGrant(CID, 2000);
      expect(getGrant(CID)).toEqual({ until: 2000 });
      const rows = db.prepare('SELECT COUNT(*) as n FROM docker_grants WHERE container_id = ?').get(CID) as { n: number };
      expect(rows.n).toBe(1);
    });
  });

  describe('minuten-validatie (1–120)', () => {
    it('weigert 0, negatieve en >120', () => {
      expect(validMinutes(0)).toBe(false);
      expect(validMinutes(-5)).toBe(false);
      expect(validMinutes(121)).toBe(false);
    });
    it('staat de randen 1 en 120 toe', () => {
      expect(validMinutes(1)).toBe(true);
      expect(validMinutes(120)).toBe(true);
    });
  });

  describe('ophalen (GET)', () => {
    it('getAllGrants geeft alle grants als map terug', () => {
      setGrant('devcontainer-a', 1111);
      setGrant('devcontainer-b', 2222);
      expect(getAllGrants()).toEqual({
        'devcontainer-a': { until: 1111 },
        'devcontainer-b': { until: 2222 },
      });
    });
    it('getGrant geeft niets terug voor een onbekende container', () => {
      expect(getGrant('does-not-exist')).toBeUndefined();
    });
  });

  describe('verlopen', () => {
    it('een grant met until in het verleden is niet meer actief', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const past = Math.floor(Date.now() / 1000) - 60; // 1 min geleden verlopen
      setGrant(CID, past);
      // De rij blijft bestaan (geen auto-cleanup), maar geldt niet meer.
      expect(getGrant(CID)).toEqual({ until: past });
      expect(isActive(CID)).toBe(false);
    });

    it('wordt actief en daarna inactief als de tijd voorbij until schuift', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const until = Math.floor(Date.now() / 1000) + 600; // 10 min geldig
      setGrant(CID, until);
      expect(isActive(CID)).toBe(true);
      vi.setSystemTime(new Date('2026-06-01T12:11:00Z')); // 11 min later
      expect(isActive(CID)).toBe(false);
    });
  });

  describe('verwijderen (DELETE)', () => {
    it('verwijdert een bestaande grant', () => {
      setGrant(CID, 9999);
      deleteGrant(CID);
      expect(getGrant(CID)).toBeUndefined();
    });
    it('is idempotent — verwijderen van een onbekende grant gooit niet', () => {
      expect(() => deleteGrant('never-existed')).not.toThrow();
    });
  });
});
