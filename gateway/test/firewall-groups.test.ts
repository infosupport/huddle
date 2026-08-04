import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Exercises the real firewall-groups module (#69) against the in-memory DB
// (DB_PATH=':memory:' from vitest.config.ts): group import/export round-trip,
// merge vs replace, apply-to-scope, the team-folder loader (incl. removal of
// stale startup-folder rules), and fail-closed envelope validation.

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[firewall-groups.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let dbMod: typeof import('../src/db');
let groups: typeof import('../src/firewall-groups');

beforeAll(async () => {
  if (!sqliteAvailable) return;
  dbMod = await import('../src/db');
  groups = await import('../src/firewall-groups');
  dbMod.initDb();
});

beforeEach(() => {
  if (!sqliteAvailable) return;
  dbMod.db.exec('DELETE FROM rules; DELETE FROM firewall_groups;');
});

const envOpenAI = () => ({
  version: 1,
  kind: 'huddle-firewall-group',
  group: { name: 'OpenAI', description: 'All domains and rules required for OpenAI services.', shared: true },
  rules: [
    { domain: 'api.openai.com', container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null },
    { domain: 'files.openai.com', container_id: null, status: 'allow', path_pattern: '/*', path_mode: 1, expires_at: null },
  ],
});

describe.skipIf(!sqliteAvailable)('firewall-groups module', () => {
  it('imports a group envelope: creates the group + its rules', () => {
    const res = groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    expect(res.imported).toBe(2);
    expect(res.updated).toBe(0);
    expect(res.group.name).toBe('OpenAI');
    expect(res.group.shared).toBe(1);
    const list = dbMod.listGroups();
    expect(list).toHaveLength(1);
    expect(list[0].rule_count).toBe(2);
  });

  it('round-trips via export (strips volatile fields, keeps group meta)', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const g = dbMod.getGroupByName('OpenAI')!;
    const env = groups.exportGroup(g.id)!;
    expect(env.kind).toBe('huddle-firewall-group');
    expect(env.group).toMatchObject({ name: 'OpenAI', shared: true });
    expect(env.rules).toHaveLength(2);
    // No volatile columns leak.
    expect(Object.keys(env.rules[0]).sort()).toEqual(
      ['container_id', 'domain', 'expires_at', 'path_mode', 'path_pattern', 'status'].sort(),
    );
  });

  it('merge re-import updates existing rules instead of duplicating', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const changed = envOpenAI();
    changed.rules[0].status = 'deny';
    const res = groups.importGroupEnvelope(groups.validateGroupEnvelope(changed), { mode: 'merge' });
    expect(res.imported).toBe(0);
    expect(res.updated).toBe(2);
    const g = dbMod.getGroupByName('OpenAI')!;
    const rows = dbMod.db.prepare('SELECT status FROM rules WHERE group_id = ? AND domain = ?').get(g.id, 'api.openai.com') as { status: string };
    expect(rows.status).toBe('deny');
  });

  it('replace mirrors the envelope (removed rules disappear)', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const smaller = envOpenAI();
    smaller.rules = [smaller.rules[0]]; // drop files.openai.com
    groups.importGroupEnvelope(groups.validateGroupEnvelope(smaller), { mode: 'replace' });
    const g = dbMod.getGroupByName('OpenAI')!;
    const n = (dbMod.db.prepare('SELECT COUNT(*) AS n FROM rules WHERE group_id = ?').get(g.id) as { n: number }).n;
    expect(n).toBe(1);
  });

  it('applies a group to a container scope (idempotent)', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const g = dbMod.getGroupByName('OpenAI')!;
    const first = groups.applyGroup(g.id, 'devcontainer-x');
    expect(first.applied).toBe(2);
    const again = groups.applyGroup(g.id, 'devcontainer-x');
    expect(again.applied).toBe(0);
    expect(again.updated).toBe(2);
    const scoped = dbMod.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE container_id = 'devcontainer-x'").get() as { n: number };
    expect(scoped.n).toBe(2);
  });

  it('loads groups from a team folder and removes stale startup-folder rules on reload', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    fs.writeFileSync(
      path.join(dir, 'github.json'),
      JSON.stringify({ version: 1, kind: 'huddle-firewall-group', group: { name: 'GitHub' }, rules: [
        { domain: 'github.com', container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null },
      ] }),
    );

    const first = groups.reloadFirewallRulesFolder(dir);
    expect(first.groups).toBe(2);
    expect(first.errors).toHaveLength(0);
    expect(dbMod.listGroups().map((g) => g.name).sort()).toEqual(['GitHub', 'OpenAI']);
    // startup-folder source recorded
    expect(dbMod.getGroupByName('OpenAI')!.source).toBe('startup-folder');

    // Remove one file → reload drops that group's rules.
    fs.rmSync(path.join(dir, 'github.json'));
    const second = groups.reloadFirewallRulesFolder(dir);
    expect(second.groups).toBe(1);
    expect(dbMod.listGroups().map((g) => g.name)).toEqual(['OpenAI']);
  });

  it('does not touch manual rules when reloading the folder', () => {
    // A manual (source='manual') global rule must survive a folder reload.
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, source) VALUES ('manual.example', NULL, 'allow', 'manual')").run();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    groups.reloadFirewallRulesFolder(dir);
    const survives = dbMod.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE domain = 'manual.example'").get() as { n: number };
    expect(survives.n).toBe(1);
  });

  it('validateGroupEnvelope is fail-closed', () => {
    expect(() => groups.validateGroupEnvelope({ rules: [] } as any)).toThrow(/group.name/);
    expect(() => groups.validateGroupEnvelope({ group: { name: 'X' } } as any)).toThrow(/rules must be an array/);
    expect(() =>
      groups.validateGroupEnvelope({ group: { name: 'X' }, rules: [{ domain: 'a', status: 'bogus' }] } as any),
    ).toThrow(/invalid status/);
    expect(() =>
      groups.validateGroupEnvelope({ group: { name: 'X' }, rules: [{ domain: 'a', status: 'allow', evil: 1 }] } as any),
    ).toThrow(/unknown field/);
  });
});
