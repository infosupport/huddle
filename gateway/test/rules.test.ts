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
let setAirlocked: typeof import('../src/db').setAirlocked;
let checkRule: typeof import('../src/rules').checkRule;
let matchDomain: typeof import('../src/rules').matchDomain;
let matchPath: typeof import('../src/rules').matchPath;
let firstSegmentPattern: typeof import('../src/rules').firstSegmentPattern;
let isPathMode: typeof import('../src/rules').isPathMode;
let canonicalizeHost: typeof import('../src/rules').canonicalizeHost;
let normalizePathname: typeof import('../src/rules').normalizePathname;

const CID = 'container-abc';

function setRule(
  domain: string,
  containerId: string | null,
  status: string,
  expiresAt: number | null = null,
  pathPattern: string | null = null,
  pathMode = 0,
) {
  db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(domain, containerId, status, expiresAt, pathPattern, pathMode);
}

describe.skipIf(!sqliteAvailable)('checkRule', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    const rulesMod = await import('../src/rules');
    db = dbMod.db;
    setAirlocked = dbMod.setAirlocked;
    checkRule = rulesMod.checkRule;
    matchDomain = rulesMod.matchDomain;
    matchPath = rulesMod.matchPath;
    firstSegmentPattern = rulesMod.firstSegmentPattern;
    isPathMode = rulesMod.isPathMode;
    canonicalizeHost = rulesMod.canonicalizeHost;
    normalizePathname = rulesMod.normalizePathname;
    dbMod.initDb();
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); db.exec('DELETE FROM containers'); });

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

  describe('airlock', () => {
    it('airlocked container negeert een globale allow-regel', () => {
      setRule('global.test', null, 'allow');
      setAirlocked(CID, true);
      // Geen per-container regel + globale lookup overgeslagen → requested.
      expect(checkRule('global.test', CID).status).toBe('requested');
    });

    it('zonder airlock geldt dezelfde globale allow-regel wél', () => {
      setRule('global.test', null, 'allow');
      expect(checkRule('global.test', CID).status).toBe('allow');
    });

    it('airlocked container honoreert nog steeds zijn eigen allow-regel', () => {
      setRule('own.test', CID, 'allow');
      setAirlocked(CID, true);
      expect(checkRule('own.test', CID).status).toBe('allow');
    });

    it('airlock uitschakelen herstelt de globale fallback', () => {
      setRule('global.test', null, 'allow');
      setAirlocked(CID, true);
      expect(checkRule('global.test', CID).status).toBe('requested');
      setAirlocked(CID, false);
      db.exec('DELETE FROM rules');
      setRule('global.test', null, 'allow');
      expect(checkRule('global.test', CID).status).toBe('allow');
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

  describe('matchDomain (pure helper)', () => {
    it('matcht exacte host', () => {
      expect(matchDomain('npmjs.org', 'npmjs.org')).toBe(true);
      expect(matchDomain('npmjs.org', 'other.org')).toBe(false);
    });
    it('wildcard matcht subdomein', () => {
      expect(matchDomain('*.npmjs.org', 'registry.npmjs.org')).toBe(true);
      expect(matchDomain('*.npmjs.org', 'dist.npmjs.org')).toBe(true);
    });
    it('wildcard matcht NIET de kale host', () => {
      expect(matchDomain('*.npmjs.org', 'npmjs.org')).toBe(false);
    });
    it('wildcard glipt niet via substring-trucs', () => {
      expect(matchDomain('*.npmjs.org', 'evilnpmjs.org')).toBe(false);
      expect(matchDomain('*.npmjs.org', 'a.b.npmjs.org.attacker.com')).toBe(false);
    });
    it('is hoofdletter-ongevoelig', () => {
      expect(matchDomain('*.NPMJS.org', 'Registry.npmjs.ORG')).toBe(true);
    });
  });

  describe('matchPath (pure helper)', () => {
    it('null/leeg patroon matcht elk pad', () => {
      expect(matchPath(null, '/anything')).toBe(true);
      expect(matchPath('', '/anything')).toBe(true);
      expect(matchPath(null, null)).toBe(true);
    });
    it('prefix-match met trailing *', () => {
      expect(matchPath('/api/v1/*', '/api/v1/foo')).toBe(true);
      expect(matchPath('/api/v1/*', '/api/v1/')).toBe(true);
      expect(matchPath('/api/v1/*', '/api/v2/x')).toBe(false);
    });
    it('exacte match zonder wildcard', () => {
      expect(matchPath('/exact', '/exact')).toBe(true);
      expect(matchPath('/exact', '/exact/more')).toBe(false);
    });
  });

  describe('padgebaseerde regels', () => {
    it('padregel allow matcht alleen het toegestane pad', () => {
      setRule('github.com', CID, 'allow', null, '/anthropics/*');
      expect(checkRule('github.com', CID, '/anthropics/x').status).toBe('allow');
      // Geen andere regel → onbekend pad wordt "requested"
      expect(checkRule('github.com', CID, '/other').status).toBe('requested');
    });

    it('padregel wint van host-only regel', () => {
      setRule('github.com', CID, 'deny');                       // host-only deny
      setRule('github.com', CID, 'allow', null, '/anthropics/*'); // specifieker
      expect(checkRule('github.com', CID, '/anthropics/x').status).toBe('allow');
      expect(checkRule('github.com', CID, '/elders').status).toBe('deny');
    });

    it('per-container padregel wint van globale host-regel', () => {
      setRule('github.com', null, 'deny');                      // globaal host-only
      setRule('github.com', CID, 'allow', null, '/org/*');      // per-container + pad
      expect(checkRule('github.com', CID, '/org/x').status).toBe('allow');
    });

    it('wildcard-domein allow matcht subdomein', () => {
      setRule('*.npmjs.org', null, 'allow');
      expect(checkRule('registry.npmjs.org', CID).status).toBe('allow');
      expect(checkRule('npmjs.org', CID).status).toBe('requested');
    });

    it('deny wint van allow bij gelijke specificiteit (fail-closed)', () => {
      // Twee verschillende wildcard-domeinen die allebei dezelfde host matchen:
      // gelijke specificiteit (globaal, wildcard, geen pad), distinct identity.
      setRule('*.npmjs.org', null, 'allow');
      setRule('*.org', null, 'deny');
      expect(checkRule('registry.npmjs.org', CID).status).toBe('deny');
    });
  });

  describe('firstSegmentPattern (pure helper)', () => {
    it('groepeert op het eerste padsegment', () => {
      expect(firstSegmentPattern('/api/v1/users')).toBe('/api/*');
      expect(firstSegmentPattern('/api')).toBe('/api/*');
    });
    it('negeert query- en fragment-delen', () => {
      expect(firstSegmentPattern('/api/v1?x=1')).toBe('/api/*');
      expect(firstSegmentPattern('/repos/foo#frag')).toBe('/repos/*');
    });
    it('root-pad wordt /*', () => {
      expect(firstSegmentPattern('/')).toBe('/*');
      expect(firstSegmentPattern('')).toBe('/*');
    });
  });

  describe('pad-allowlist modus (path_mode)', () => {
    it('host-only marker blokkeert het kale domein, maar voert subpaden op als requested', () => {
      setRule('github.com', CID, 'deny', null, null, 1); // marker

      // Onbekend subpad → requested, en er ontstaat een gegroepeerde padregel.
      expect(checkRule('github.com', CID, '/anthropics/claude').status).toBe('requested');
      const row = db.prepare(
        `SELECT status, path_pattern, last_path FROM rules WHERE domain=? AND container_id=? AND path_pattern=?`
      ).get('github.com', CID, '/anthropics/*') as any;
      expect(row?.status).toBe('requested');
      // Het volledige pad wordt als voorbeeld bewaard en bij een nieuwe hit ververst.
      expect(row?.last_path).toBe('/anthropics/claude');
      checkRule('github.com', CID, '/anthropics/codex?x=1');
      const row2 = db.prepare(
        `SELECT last_path FROM rules WHERE domain=? AND container_id=? AND path_pattern=?`
      ).get('github.com', CID, '/anthropics/*') as any;
      expect(row2?.last_path).toBe('/anthropics/codex?x=1');

      // Het kale domein (geen pad / null) blijft dicht.
      expect(checkRule('github.com', CID, null).status).toBe('deny');
    });

    it('een toegestaan subpad wint van de host-only marker', () => {
      setRule('github.com', CID, 'deny', null, null, 1);          // marker
      setRule('github.com', CID, 'allow', null, '/anthropics/*');  // toegestaan pad
      expect(checkRule('github.com', CID, '/anthropics/claude').status).toBe('allow');
      // Ander pad blijft onbekend → requested
      expect(checkRule('github.com', CID, '/torvalds/linux').status).toBe('requested');
    });

    it('een afgekeurd subpad blijft deny (geen her-opvoeren als requested)', () => {
      setRule('github.com', CID, 'deny', null, null, 1);        // marker
      setRule('github.com', CID, 'deny', null, '/secret/*');     // expliciet geblokkeerd pad
      expect(checkRule('github.com', CID, '/secret/x').status).toBe('deny');
    });

    it('isPathMode herkent een domein in pad-modus', () => {
      setRule('github.com', null, 'deny', null, null, 1);
      expect(isPathMode('github.com', CID)).toBe(true);
      expect(isPathMode('elders.test', CID)).toBe(false);
    });
  });

  describe('regressie: path-argument verandert host-only gedrag niet', () => {
    it('expliciet null pad geeft zelfde resultaat als zonder argument', () => {
      setRule('regress.test', CID, 'allow');
      expect(checkRule('regress.test', CID).status).toBe('allow');
      expect(checkRule('regress.test', CID, null).status).toBe('allow');
    });
    it('host-only allow matcht ongeacht het pad', () => {
      setRule('hostonly.test', CID, 'allow');
      expect(checkRule('hostonly.test', CID, '/any/path').status).toBe('allow');
    });
  });

  // ── Finding #3 — hoofdletter-bypass van exacte deny-regels ─────────────────
  // De klassieke broad-allow/specific-deny vorm: `*.github.com` allow +
  // `gist.github.com` deny. Een ge-kapitaliseerde host mocht de deny NIET
  // omzeilen (was een reliable firewall-bypass via CONNECT GIST.GITHUB.COM).
  describe('regressie #3: casing omzeilt geen exacte deny', () => {
    it('exacte deny wint van wildcard allow, ongeacht de host-casing', () => {
      setRule('*.github.com', null, 'allow');
      setRule('gist.github.com', null, 'deny');
      expect(checkRule('gist.github.com', CID).status).toBe('deny');
      // Zelfde host, ge-kapitaliseerd — checkRule lowercase't het domein-argument
      // en de exacte SQL-lookup is COLLATE NOCASE.
      expect(checkRule('GIST.GITHUB.COM', CID).status).toBe('deny');
      expect(checkRule('Gist.GitHub.Com', CID).status).toBe('deny');
    });
    it('een deny-regel die zelf ge-kapitaliseerd is opgeslagen matcht ook', () => {
      // Simuleer een oude, niet-gemigreerde rij (mixed case) — COLLATE NOCASE
      // op de index/lookup vangt hem alsnog.
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('EVIL.TEST', NULL, 'deny')`).run();
      expect(checkRule('evil.test', CID).status).toBe('deny');
    });
  });

  // ── Finding #7 — pad-traversal door een pad-allowlist ──────────────────────
  describe('regressie #7: pad-normalisatie blokkeert traversal', () => {
    it('`/foo/../secret` matcht niet langer een `/foo/*` allow', () => {
      setRule('example.com', CID, 'deny', null, null, 1);          // path-mode marker
      setRule('example.com', CID, 'allow', null, '/foo/*');        // alleen /foo/* toegestaan
      expect(checkRule('example.com', CID, '/foo/bar').status).toBe('allow');
      // Traversal → normaliseert weg van /foo/ → niet meer 'allow'.
      expect(checkRule('example.com', CID, '/foo/../secret').status).not.toBe('allow');
      expect(checkRule('example.com', CID, '/foo/..%2f..%2fadmin').status).not.toBe('allow');
      expect(checkRule('example.com', CID, '/foo/../').status).not.toBe('allow');
    });
  });

  describe('canonicalizeHost (pure helper)', () => {
    it('lowercase + trailing dot strippen', () => {
      expect(canonicalizeHost('GIST.GITHUB.COM')).toBe('gist.github.com');
      expect(canonicalizeHost('example.com.')).toBe('example.com');
      expect(canonicalizeHost('Example.COM.')).toBe('example.com');
    });
    it('IDN → punycode (de vorm die DNS/SNI zien)', () => {
      // bücher.example → xn--bcher-kva.example
      expect(canonicalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
    });
    it('weigert control chars, whitespace en lege host', () => {
      expect(canonicalizeHost('')).toBeNull();
      expect(canonicalizeHost('  ')).toBeNull();
      expect(canonicalizeHost('evil.com\r\nHost: x')).toBeNull();
      expect(canonicalizeHost('a b.com')).toBeNull();
    });
    it('is idempotent op een al-canonieke host', () => {
      expect(canonicalizeHost('gist.github.com')).toBe('gist.github.com');
    });
  });

  describe('normalizePathname (pure helper)', () => {
    it('laat een normaal pad ongemoeid (incl. trailing slash)', () => {
      expect(normalizePathname('/api/v1/foo')).toBe('/api/v1/foo');
      expect(normalizePathname('/api/v1/')).toBe('/api/v1/');
      expect(normalizePathname('/')).toBe('/');
    });
    it('strip query en fragment', () => {
      expect(normalizePathname('/foo?x=1')).toBe('/foo');
      expect(normalizePathname('/foo#frag')).toBe('/foo');
    });
    it('vouwt `.`-segmenten weg', () => {
      expect(normalizePathname('/foo/./bar')).toBe('/foo/bar');
    });
    it('fail-closed op `..`-traversal (plain, %-encoded, dubbel-slash)', () => {
      expect(normalizePathname('/foo/../secret')).toBeNull();
      expect(normalizePathname('/foo/..%2f..%2fadmin')).toBeNull();
      expect(normalizePathname('/foo/../')).toBeNull();
      expect(normalizePathname('/..')).toBeNull();
    });
    it('fail-closed op kapotte percent-encoding', () => {
      expect(normalizePathname('/foo/%zz')).toBeNull();
      expect(normalizePathname('/foo/%2')).toBeNull();
    });
    it('behandelt dubbel-encoded `..` als een letterlijk segment (single decode)', () => {
      // %252e%252e → één decode → %2e%2e (geen `..`-segment) → géén traversal.
      expect(normalizePathname('/foo/%252e%252e/x')).toBe('/foo/%2e%2e/x');
    });
    it('behoudt legitieme %-encoded tekens (geen verminking van de beslissing)', () => {
      // %2e%2e = `..` → traversal → fail closed.
      expect(normalizePathname('/foo/%2e%2e/x')).toBeNull();
      // een gewoon encoded teken (spatie) in een segment blijft een geldig pad.
      expect(normalizePathname('/a%20b/c')).toBe('/a b/c');
    });
  });

  describe('matchPath: segment-grens (regressie #7 tail)', () => {
    it('`*`-suffix matcht alleen op een segment-grens', () => {
      expect(matchPath('/safe*', '/safe')).toBe(true);
      expect(matchPath('/safe*', '/safe/x')).toBe(true);
      expect(matchPath('/safe*', '/safe-danger')).toBe(false);
    });
    it('`/foo/*` matcht subpaden maar niet na traversal', () => {
      expect(matchPath('/foo/*', '/foo/bar')).toBe(true);
      expect(matchPath('/foo/*', '/foo/../secret')).toBe(false);
      expect(matchPath('/foo/*', '/foo/..%2fsecret')).toBe(false);
    });
    it('null/leeg patroon (host-only) matcht elk pad, ook traversal', () => {
      // Host-only regels handhaven geen pad; traversal-bescherming zit in de
      // pad-regels zelf.
      expect(matchPath(null, '/foo/../secret')).toBe(true);
      expect(matchPath('', '/whatever')).toBe(true);
    });
  });
});
