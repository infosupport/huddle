import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// ── Feature 14 — persoonlijke AI CLI-instellingen ────────────────────────────
// Twee dingen worden getest:
//  1. De settings-key/value-store in db.ts (getSetting/setSetting).
//  2. De mount-keuze: eigen host-pad (bind) wint van het named volume (feature
//     13); leeg pad valt terug op het volume; alles leeg = geen mount.
//
// better-sqlite3 is native; in een DMZ-devcontainer zonder gebouwde binding
// skippen we de db-helpers (zelfde probe als grants.test.ts). De mount-logica
// is puur en draait altijd.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[personal-settings.test] SKIPPED db — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

// Spiegelt buildProviderMount uit docker.ts (niet geëxporteerd om docker's
// zware imports buiten de test te houden — zelfde patroon als validMinutes).
interface ProviderMount { Type: 'bind' | 'volume'; Source: string; Target: string; }
function buildProviderMount(
  volName: string,
  pathSetting: string | null,
  containerTarget: string,
): ProviderMount | null {
  if (pathSetting && pathSetting.trim()) {
    return { Type: 'bind', Source: pathSetting.trim(), Target: containerTarget };
  } else if (volName) {
    return { Type: 'volume', Source: volName, Target: containerTarget };
  }
  return null;
}

describe('buildProviderMount', () => {
  const target = '/home/vscode/.claude';
  const vol = 'huddle-claude-settings';

  it('bind-mount het host-pad als dat ingevuld is (wint van volume)', () => {
    expect(buildProviderMount(vol, '/home/user/.claude', target)).toEqual({
      Type: 'bind', Source: '/home/user/.claude', Target: target,
    });
  });

  it('trimt whitespace rond het host-pad', () => {
    expect(buildProviderMount(vol, '  /home/user/.claude  ', target)).toEqual({
      Type: 'bind', Source: '/home/user/.claude', Target: target,
    });
  });

  it('valt terug op het named volume bij leeg pad', () => {
    expect(buildProviderMount(vol, '', target)).toEqual({
      Type: 'volume', Source: vol, Target: target,
    });
  });

  it('behandelt null en whitespace-only als leeg', () => {
    expect(buildProviderMount(vol, null, target)).toEqual({
      Type: 'volume', Source: vol, Target: target,
    });
    expect(buildProviderMount(vol, '   ', target)).toEqual({
      Type: 'volume', Source: vol, Target: target,
    });
  });

  it('geeft null (geen mount) als zowel pad als volume leeg zijn', () => {
    expect(buildProviderMount('', '', target)).toBeNull();
    expect(buildProviderMount('', null, target)).toBeNull();
  });
});

let getSetting: typeof import('../src/db').getSetting;
let setSetting: typeof import('../src/db').setSetting;
let db: typeof import('../src/db').db;

describe.skipIf(!sqliteAvailable)('settings store', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    getSetting = dbMod.getSetting;
    setSetting = dbMod.setSetting;
    db = dbMod.db;
    dbMod.initDb();
  });
  beforeEach(() => { db.exec('DELETE FROM settings'); });

  it('geeft null terug voor een onbekende sleutel', () => {
    expect(getSetting('claudeSettingsPath')).toBeNull();
  });

  it('slaat een waarde op en leest die terug', () => {
    setSetting('claudeSettingsPath', '/home/user/.claude');
    expect(getSetting('claudeSettingsPath')).toBe('/home/user/.claude');
  });

  it('overschrijft een bestaande sleutel i.p.v. te dupliceren', () => {
    setSetting('codexSettingsPath', '/a');
    setSetting('codexSettingsPath', '/b');
    expect(getSetting('codexSettingsPath')).toBe('/b');
    const n = (db.prepare('SELECT COUNT(*) as n FROM settings WHERE key = ?')
      .get('codexSettingsPath') as { n: number }).n;
    expect(n).toBe(1);
  });
});
