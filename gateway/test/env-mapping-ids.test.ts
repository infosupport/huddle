import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Env-mapping ids are never recycled (#108) ────────────────────────────────
//
// A mapping's secret and the placeholders issued for it live in SQLite, keyed on
// the mapping id, and only the API's delete path cleans them up. `config.json` is
// meant to be hand-editable, so a mapping can also vanish by someone deleting the
// entry — and if the next created mapping inherited that id, an old container's
// stale placeholder would resolve against the NEW secret.
//
// host-config reads HOME_DIR at module load, so point it somewhere writable
// before anything imports it.
const HOME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ids-'));
process.env.HUDDLE_HOME_DIR = HOME_DIR;
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[env-mapping-ids.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let hostConfig: typeof import('../src/host-config');
let envMappings: typeof import('../src/env-mappings');
let dbMod: typeof import('../src/db');

const writeConfig = (config: unknown) => fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
const readConfig = () => JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));

const mapping = (name: string) => ({
  name, varName: name, value: '', secret: true,
  secretHosts: 'api.example.com', global: false, enabled: true, sortOrder: 0,
});

beforeAll(async () => {
  if (!sqliteAvailable) return;
  dbMod = await import('../src/db');
  dbMod.initDb();
  hostConfig = await import('../src/host-config');
  envMappings = await import('../src/env-mappings');
});

beforeEach(() => {
  if (!sqliteAvailable) return;
  writeConfig({});
  dbMod.db.exec('DELETE FROM env_secrets; DELETE FROM env_mapping_containers; DELETE FROM env_mapping_workspaces;');
});

afterAll(() => {
  fs.rmSync(HOME_DIR, { recursive: true, force: true });
});

describe.skipIf(!sqliteAvailable)('env-mapping id allocation', () => {
  it('hands out increasing ids', () => {
    expect(hostConfig.createEnvMapping(mapping('FIRST'))).toBe(1);
    expect(hostConfig.createEnvMapping(mapping('SECOND'))).toBe(2);
  });

  it('does not reuse the id of a mapping deleted through the API', () => {
    const first = hostConfig.createEnvMapping(mapping('FIRST'))!;
    expect(hostConfig.deleteEnvMapping(first)).toBe(true);
    expect(hostConfig.createEnvMapping(mapping('SECOND'))).toBe(first + 1);
  });

  // The case the API cannot see: the entry is removed straight out of the file.
  it('does not reuse the id of a mapping removed by hand-editing the config', () => {
    const first = hostConfig.createEnvMapping(mapping('FIRST'))!;
    const config = readConfig();
    writeConfig({ ...config, envMappings: [] });

    const second = hostConfig.createEnvMapping(mapping('SECOND'))!;
    expect(second).not.toBe(first);
    expect(second).toBe(first + 1);
  });

  it('keeps the high-water mark in the config so it survives a restart', () => {
    const id = hostConfig.createEnvMapping(mapping('FIRST'))!;
    expect(readConfig().envMappingSeq).toBe(id);
  });
});

describe.skipIf(!sqliteAvailable)('purgeOrphanedEnvMappings', () => {
  // Second line of defense, for a config edited so heavily the counter went too.
  const seedRows = (mappingId: number, containerId: string) => {
    dbMod.setEnvSecret(mappingId, `secret-${mappingId}`);
    // Placeholders are unique-constrained, so vary them per mapping.
    const placeholder = 'huddle_env_' + String(mappingId).padStart(64, '0');
    dbMod.setContainerEnvMappings(containerId, [{ mapping_id: mappingId, placeholder }]);
  };

  it('clears the rows of a mapping the config no longer defines, keeping the rest', () => {
    writeConfig({ envMappings: [{ ...mapping('KEPT'), id: 2 }] });
    seedRows(1, 'devcontainer-old');
    seedRows(2, 'devcontainer-live');

    expect(envMappings.purgeOrphanedEnvMappings()).toBeGreaterThan(0);

    expect(dbMod.getEnvSecret(1)).toBeNull();
    expect(dbMod.getEnvSecret(2)).toBe('secret-2');
  });

  // The dangerous failure mode: readHostConfig() flattens a broken file to {},
  // which looks exactly like "the operator deleted every mapping".
  it('refuses to act on a malformed config instead of wiping every secret', () => {
    fs.writeFileSync(CONFIG_FILE, '{ this is not json');
    seedRows(1, 'devcontainer-live');

    expect(envMappings.purgeOrphanedEnvMappings()).toBe(0);
    expect(dbMod.getEnvSecret(1)).toBe('secret-1');
  });

  it('refuses to act when the config file is missing', () => {
    fs.rmSync(CONFIG_FILE, { force: true });
    seedRows(1, 'devcontainer-live');

    expect(envMappings.purgeOrphanedEnvMappings()).toBe(0);
    expect(dbMod.getEnvSecret(1)).toBe('secret-1');
  });
});
