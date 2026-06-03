import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// ── Boundary A — per-domein firewall rules engine ───────────────────────────
// checkRule is het hart van de proxy-beslissing (allow / deny / requested).
// Draait tegen een in-memory SQLite (zie vitest.config.ts env DB_PATH).
//
// better-sqlite3 is een native module. In een DMZ-devcontainer zonder gebouwde
// binding (nodejs.org geblokkeerd → node-gyp kan geen headers halen) slaan we
// deze suite over; in de huddle-image / CI is de binding wél aanwezig en draait
// hij volledig. Probe daarom de binding voordat we db.ts importeren.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  // Niet stil overslaan — anders verbergt een verkeerde/ontbrekende native binding
  // (bv. node_modules van een ander platform) dat deze suite niet draait.
  console.warn(
    `[rules.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}\n` +
    `  Fix op je host: \`npm rebuild better-sqlite3\` (of verwijder node_modules en \`npm install\`).`
  );
}

// Dynamisch geïmporteerd (pas ná de probe) zodat het ontbreken van de binding
// niet de hele testfile laat crashen.
let db: typeof import('../src/db').db;
let checkRule: typeof import('../src/rules').checkRule;

const CID = 'container-abc';

function setRule(domain: string, containerId: string | null, status: string, expiresAt: number | null = null) {
  db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at) VALUES (?, ?, ?, ?)`
  ).run(domain, containerId, status, expiresAt);
}

describe.skipIf(!sqliteAvailable)('checkRule', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    const rulesMod = await import('../src/rules');
    db = dbMod.db;
    checkRule = rulesMod.checkRule;
    dbMod.initDb();
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); });

  describe('per-container rules', () => {
    it('allow voor een toegestaan domein', () => {
      setRule('example.com', CID, 'allow');
      expect(checkRule('example.com', CID).status).toBe('allow');
    });

    it('deny voor een geblokkeerd domein', () => {
      setRule('evil.test', CID, 'deny');
      expect(checkRule('evil.test', CID).status).toBe('deny');
    });

    it('onbekend domein wordt automatisch als "requested" aangemaakt', () => {
      const r = checkRule('new-domain.test', CID);
      expect(r.status).toBe('requested');
      const row = db.prepare(`SELECT status FROM rules WHERE domain=? AND container_id=?`).get('new-domain.test', CID) as any;
      expect(row?.status).toBe('requested');
    });

    it('per-container rule heeft voorrang op een globale rule', () => {
      setRule('split.test', null, 'deny');   // globaal geblokkeerd
      setRule('split.test', CID, 'allow');    // maar voor deze container toegestaan
      expect(checkRule('split.test', CID).status).toBe('allow');
    });
  });

  describe('global rules', () => {
    it('globale allow geldt wanneer er geen per-container rule is', () => {
      setRule('global.test', null, 'allow');
      expect(checkRule('global.test', CID).status).toBe('allow');
    });

    it('globale rules gelden ook zonder containerId', () => {
      setRule('global.test', null, 'deny');
      expect(checkRule('global.test', null).status).toBe('deny');
    });
  });

  describe('temp-allow expiry', () => {
    it('een verlopen temp-allow valt terug naar "requested"', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const past = Math.floor(Date.now() / 1000) - 60; // 1 min geleden verlopen
      setRule('temp.test', CID, 'allow', past);
      expect(checkRule('temp.test', CID).status).toBe('requested');
      const row = db.prepare(`SELECT status FROM rules WHERE domain=? AND container_id=?`).get('temp.test', CID) as any;
      expect(row?.status).toBe('requested');
      vi.useRealTimers();
    });

    it('een nog-geldige temp-allow blijft "allow"', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const future = Math.floor(Date.now() / 1000) + 600; // nog 10 min geldig
      setRule('temp2.test', CID, 'allow', future);
      expect(checkRule('temp2.test', CID).status).toBe('allow');
      vi.useRealTimers();
    });
  });
});
