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

// Ids and container names unique to this file. Vitest isolates each test file, so
// the in-memory DB should be ours alone — but this suite deletes rows by id and
// the function under test unbinds GLOBALLY, so if that isolation ever stops
// holding, colliding with another file's fixtures (proxy-env-secret-audit.test.ts
// seeds mapping id 1) would produce failures that look like a bug in the purge.
const ID_A = 9101;
const ID_B = 9102;
const CONTAINER_A = 'devcontainer-ids-a';
const CONTAINER_B = 'devcontainer-ids-b';

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
  // Only this file's fixtures — a blanket DELETE would take another suite's rows
  // with it if the per-file DB were ever shared.
  dbMod.db.prepare('DELETE FROM env_secrets WHERE mapping_id >= ?').run(ID_A);
  dbMod.db.prepare('DELETE FROM env_mapping_containers WHERE mapping_id >= ?').run(ID_A);
  dbMod.db.prepare('DELETE FROM env_mapping_workspaces WHERE mapping_id >= ?').run(ID_A);
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
  // Housekeeping only: a placeholder resolves through the uid, so a binding left
  // behind by a removed mapping is already unresolvable either way.
  const PLACEHOLDER = (mappingId: number) => 'huddle_env_' + String(mappingId).padStart(64, '0');
  const UID = (mappingId: number) => `uid-fixture-${mappingId}`;
  const seedRows = (mappingId: number, containerId: string) => {
    dbMod.setEnvSecret(UID(mappingId), `secret-${mappingId}`);
    // Placeholders are unique-constrained, so vary them per mapping.
    dbMod.setContainerEnvMappings(containerId, [{ mapping_id: mappingId, uid: UID(mappingId), placeholder: PLACEHOLDER(mappingId) }]);
  };

  it('unbinds the placeholders of a mapping the config no longer defines, keeping the rest', () => {
    writeConfig({ envMappings: [{ ...mapping('KEPT'), id: ID_B }] });
    seedRows(ID_A, CONTAINER_A);
    seedRows(ID_B, CONTAINER_B);

    expect(envMappings.purgeOrphanedEnvMappings()).toBeGreaterThan(0);

    // The stale placeholder can no longer reach any secret — which is the whole
    // point, since a recycled id would otherwise hand it the wrong one.
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)).toBeNull();
    // The live mapping is untouched.
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_B), CONTAINER_B)?.value).toBe(`secret-${ID_B}`);
  });

  // This cleanup runs unattended at every boot, against a file operators are
  // invited to hand-edit. It must never be the thing that destroys a credential.
  it('never deletes stored secrets, only the bindings', () => {
    writeConfig({ envMappings: [] });
    seedRows(ID_A, CONTAINER_A);

    envMappings.purgeOrphanedEnvMappings();

    expect(dbMod.getEnvSecret(UID(ID_A))).toBe(`secret-${ID_A}`);
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)).toBeNull();
  });

  // The dangerous failure mode: readHostConfig() flattens a broken file to {},
  // which looks exactly like "the operator deleted every mapping".
  it('refuses to act on a malformed config instead of unbinding everything', () => {
    fs.writeFileSync(CONFIG_FILE, '{ this is not json');
    seedRows(ID_A, CONTAINER_A);

    expect(envMappings.purgeOrphanedEnvMappings()).toBe(0);
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)?.value).toBe(`secret-${ID_A}`);
  });

  // Parseable, but envMappings has the wrong shape — envMappingsOf() collapses
  // that to an empty list, indistinguishable from a genuine "no mappings".
  it.each([
    ['an object', {}],
    ['a string', 'ANTHROPIC_API_KEY'],
    ['a number', 3],
    ['null', null],
  ])('refuses to act when envMappings is %s rather than a list', (_label, value) => {
    writeConfig({ envMappings: value });
    seedRows(ID_A, CONTAINER_A);

    expect(envMappings.purgeOrphanedEnvMappings()).toBe(0);
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)?.value).toBe(`secret-${ID_A}`);
  });

  it('refuses to act when the config file is missing', () => {
    fs.rmSync(CONFIG_FILE, { force: true });
    seedRows(ID_A, CONTAINER_A);

    expect(envMappings.purgeOrphanedEnvMappings()).toBe(0);
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)?.value).toBe(`secret-${ID_A}`);
  });

  // A config that simply has no mappings yet is not an error: there is nothing to
  // keep, so every binding really is an orphan.
  it('still unbinds when the config legitimately defines no mappings', () => {
    writeConfig({});
    seedRows(ID_A, CONTAINER_A);

    expect(envMappings.purgeOrphanedEnvMappings()).toBeGreaterThan(0);
    expect(dbMod.resolveEnvPlaceholder(PLACEHOLDER(ID_A), CONTAINER_A)).toBeNull();
  });
});

// ── The point of the uid: a recycled numeric id inherits nothing ─────────────

describe.skipIf(!sqliteAvailable)('secrets are keyed on the uid, not the id', () => {
  it('does not hand a hand-written entry the secret of the id it reused', () => {
    // A mapping created through the portal; its secret is filed under the uid.
    writeConfig({});
    const id = hostConfig.createEnvMapping(mapping('ORIGINAL'))!;
    const original = hostConfig.getEnvMapping(id)!;
    expect(original.uid).toBeTruthy();
    dbMod.setEnvSecret(original.uid, 'the-original-secret');

    // The operator then removes that entry by hand and writes a new one reusing
    // the same numeric id — nothing in the file format stops them — pointing at a
    // host allowlist of their own.
    writeConfig({
      envMappings: [{ ...mapping('IMPOSTOR'), id, varName: 'IMPOSTOR', secretHosts: 'evil.example.com' }],
    });

    const impostor = hostConfig.getEnvMapping(id)!;
    expect(impostor.uid).toBe(''); // hand-written entries carry no uid
    // So it owns no secret: the container gets nothing rather than the original's
    // credential redeemable towards evil.example.com.
    const built = envMappings.buildEnvEntries([impostor], dbMod.getEnvSecret);
    expect(built.entries).toEqual([]);
    expect(built.skipped[0]?.reason).toMatch(/no stored value/i);

    // And the original secret is untouched, reachable only by its uid.
    expect(dbMod.getEnvSecret(original.uid)).toBe('the-original-secret');
  });

  it('stops redeeming a placeholder the moment its uid leaves the config', () => {
    writeConfig({});
    const id = hostConfig.createEnvMapping(mapping('GONE'))!;
    const created = hostConfig.getEnvMapping(id)!;
    dbMod.setEnvSecret(created.uid, 'about-to-be-orphaned');
    const placeholder = envMappings.newEnvPlaceholder();
    dbMod.setContainerEnvMappings(CONTAINER_B, [
      { mapping_id: id, uid: created.uid, placeholder },
    ]);

    // Resolves while the mapping exists...
    expect(envMappings.lookupEnvSecret(placeholder, CONTAINER_B)?.value).toBe('about-to-be-orphaned');

    // ...and stops as soon as its definition is gone, with no cleanup required —
    // which is why the startup purge no longer has to be trusted with a secret.
    writeConfig({ envMappings: [{ ...mapping('IMPOSTOR'), id }] });
    expect(envMappings.lookupEnvSecret(placeholder, CONTAINER_B)).toBeNull();
  });
});
