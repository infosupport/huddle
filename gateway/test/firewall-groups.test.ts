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
    // The 2 envelope rules + the path-mode marker auto-established for
    // files.openai.com (its rule is path-scoped). The marker joins the group too,
    // so the group's own path-mode domain is not left in "Ungrouped" (#98).
    expect(list[0].rule_count).toBe(3);
  });

  it('round-trips via export (strips volatile fields, keeps group meta)', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const g = dbMod.getGroupByName('OpenAI')!;
    const env = groups.exportGroup(g.id)!;
    expect(env.kind).toBe('huddle-firewall-group');
    expect(env.group).toMatchObject({ name: 'OpenAI', shared: true });
    // 2 imported rules + the path-mode marker for files.openai.com, which the
    // import establishes as a member — so the export is self-contained: a
    // re-import elsewhere puts that domain in path mode without a second pass.
    expect(env.rules).toHaveLength(3);
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
    // The group's 2 rules + the path-mode marker for files.openai.com, which is
    // a member since the import (#98) and is stamped into the scope as well.
    expect(first.applied).toBe(3);
    const again = groups.applyGroup(g.id, 'devcontainer-x');
    expect(again.applied).toBe(0);
    expect(again.updated).toBe(3);
    const scoped = dbMod.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE container_id = 'devcontainer-x'").get() as { n: number };
    // The domain rule, the path rule, and the host-only path-mode marker that
    // admits it over HTTPS.
    expect(scoped.n).toBe(3);
  });

  it('export/apply of a path-mode group include its ungrouped allowed sub-paths', () => {
    // A path-mode domain in a group: the marker (deny, path_mode=1) is assigned
    // to the group, but its allowed paths are created ungrouped (group_id NULL),
    // like the portal's "Add path" / addPath does.
    groups.importGroupEnvelope(groups.validateGroupEnvelope({
      version: 1, kind: 'huddle-firewall-group',
      group: { name: 'NPM', shared: false },
      rules: [{ domain: 'registry.npmjs.org', container_id: null, status: 'deny', path_pattern: null, path_mode: 1, expires_at: null }],
    }));
    const g = dbMod.getGroupByName('NPM')!;
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, path_pattern, path_mode, source) VALUES ('registry.npmjs.org', NULL, 'allow', '/@types/*', 0, 'manual')").run();
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, path_pattern, path_mode, source) VALUES ('registry.npmjs.org', NULL, 'allow', '/typescript/*', 0, 'manual')").run();

    // Export must carry the marker AND both allowed paths — not just the deny.
    const env = groups.exportGroup(g.id)!;
    expect(env.rules).toHaveLength(3);
    expect(env.rules.filter((r) => r.path_pattern).map((r) => r.path_pattern).sort()).toEqual(['/@types/*', '/typescript/*']);
    expect(env.rules.some((r) => r.path_mode === 1 && !r.path_pattern)).toBe(true);

    // Apply to a container must stamp the marker AND both paths there.
    groups.applyGroup(g.id, 'devcontainer-x');
    const scoped = dbMod.db
      .prepare("SELECT path_pattern, path_mode FROM rules WHERE container_id = 'devcontainer-x' AND domain = 'registry.npmjs.org'")
      .all() as { path_pattern: string | null; path_mode: number }[];
    expect(scoped).toHaveLength(3);
    expect(scoped.some((r) => r.path_mode === 1 && !r.path_pattern)).toBe(true);
    expect(scoped.filter((r) => r.path_pattern).length).toBe(2);
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

    // The loader reads the fixed mount point; point it at our temp dir.
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    const first = groups.reloadFirewallRulesFolder();
    expect(first.mounted).toBe(true);
    expect(first.groups).toBe(2);
    expect(first.errors).toHaveLength(0);
    expect(dbMod.listGroups().map((g) => g.name).sort()).toEqual(['GitHub', 'OpenAI']);
    // startup-folder source recorded
    expect(dbMod.getGroupByName('OpenAI')!.source).toBe('startup-folder');

    // Remove one file → reload drops that group's rules.
    fs.rmSync(path.join(dir, 'github.json'));
    const second = groups.reloadFirewallRulesFolder();
    expect(second.groups).toBe(1);
    expect(dbMod.listGroups().map((g) => g.name)).toEqual(['OpenAI']);
  });

  it('refuses to read a symlinked group file instead of following it', () => {
    // `evil.json -> /dev/zero` would make readFileSync consume memory until the
    // process dies, and the reload runs during API startup — so a single file in
    // the team folder could hang the whole gateway. A symlink pointing outside the
    // folder would likewise read something the operator never placed there.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    const outside = path.join(dir, '..', `huddle-outside-${process.pid}.json`);
    fs.writeFileSync(outside, JSON.stringify(envOpenAI()));
    fs.symlinkSync(outside, path.join(dir, 'linked.json'));

    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    const res = groups.reloadFirewallRulesFolder();
    expect(res.errors.map((e) => e.file)).toContain('linked.json');
    expect(res.errors.find((e) => e.file === 'linked.json')!.message).toMatch(/regular file/);
    // Fail-closed: one unreadable file aborts the reload and keeps the last-good
    // policy, so the valid file in the same folder is not imported either.
    expect(res.groups).toBe(0);
    expect(dbMod.listGroups()).toHaveLength(0);
    fs.rmSync(outside);
  });

  it('keeps a group whose name would slug into a traversal on one plain file', () => {
    // A group name is attacker-influenceable through the import API and decides the
    // file name on sync. groupFileSlug() strips it to [a-z0-9-] and envelopePath()
    // asserts the result is a bare basename, so no name can aim a write outside the
    // mounted folder.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    groups.importGroupEnvelope(
      groups.validateGroupEnvelope({ ...envOpenAI(), group: { name: '../../etc/evil' } }),
    );

    const res = groups.syncGroupsToFolder();
    expect(res.errors).toHaveLength(0);
    expect(res.written).toBe(1);
    // Written inside the mount, under a slugged name — nothing escaped upwards.
    expect(res.files[0].file).toBe('etc-evil.json');
    expect(fs.readdirSync(dir)).toEqual(['etc-evil.json']);
    expect(fs.existsSync(path.join(dir, '..', '..', 'etc', 'evil.json'))).toBe(false);
  });

  it('refuses a group file over the size limit', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    // Valid JSON, just absurdly large: the guard must trip on the stat, before the
    // file is read into memory and parsed.
    const huge = { ...envOpenAI(), description: 'x'.repeat(6 * 1024 * 1024) };
    fs.writeFileSync(path.join(dir, 'huge.json'), JSON.stringify(huge));

    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    const res = groups.reloadFirewallRulesFolder();
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0].message).toMatch(/over the .* limit/);
    expect(dbMod.listGroups()).toHaveLength(0);
  });

  it('does not touch manual rules when reloading the folder', () => {
    // A manual (source='manual') global rule must survive a folder reload.
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, source) VALUES ('manual.example', NULL, 'allow', 'manual')").run();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    groups.reloadFirewallRulesFolder();
    const survives = dbMod.db.prepare("SELECT COUNT(*) AS n FROM rules WHERE domain = 'manual.example'").get() as { n: number };
    expect(survives.n).toBe(1);
  });

  it('syncs groups out to the folder (app → files), mirrors the set, and re-tags them folder-managed', () => {
    // A manually-created group + rules (source stays 'manual' until synced).
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()), { source: 'manual' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-sync-'));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;

    const res = groups.syncGroupsToFolder();
    expect(res.mounted).toBe(true);
    expect(res.writable).toBe(true);
    expect(res.written).toBe(1);
    expect(res.files[0]).toMatchObject({ group: 'OpenAI', file: 'openai.json' });
    // The written file is a valid envelope round-trip.
    const env = groups.validateGroupEnvelope(JSON.parse(fs.readFileSync(path.join(dir, 'openai.json'), 'utf8')));
    expect(env.group.name).toBe('OpenAI');
    // The 2 envelope rules + the path-mode marker for files.openai.com, which is
    // a group member since #98 — so the group exports self-contained.
    expect(env.rules).toHaveLength(3);
    // The synced group is now folder-managed, so a follow-up reload updates it in
    // place instead of aborting on the "don't overwrite a manual group" guard.
    expect(dbMod.getGroupByName('OpenAI')!.source).toBe('startup-folder');
    const reloaded = groups.reloadFirewallRulesFolder();
    expect(reloaded.errors).toHaveLength(0);
    expect(reloaded.groups).toBe(1);

    // Now drop an unrelated (non-envelope) file, delete the group and re-sync:
    // the group's envelope file is pruned so the folder mirrors the current set,
    // while the unrelated file is left untouched.
    fs.writeFileSync(path.join(dir, 'notes.json'), '{"just":"data"}');
    dbMod.deleteGroup(dbMod.getGroupByName('OpenAI')!.id);
    const res2 = groups.syncGroupsToFolder();
    expect(res2.written).toBe(0);
    expect(res2.pruned).toBe(1);
    expect(fs.existsSync(path.join(dir, 'openai.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'notes.json'))).toBe(true);
  });

  it('reports write errors instead of throwing when the folder is read-only', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()), { source: 'manual' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-ro-'));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    fs.chmodSync(dir, 0o500); // r-x: readable/listable but not writable
    try {
      const res = groups.syncGroupsToFolder();
      // Root ignores mode bits; skip the assertion there rather than flake.
      if (process.getuid && process.getuid() === 0) return;
      expect(res.mounted).toBe(true);
      expect(res.written).toBe(0);
      expect(res.errors.length).toBeGreaterThan(0);
    } finally {
      fs.chmodSync(dir, 0o700);
    }
  });

  it('validateGroupEnvelope is fail-closed', () => {
    // A document with rules but no group is a plain rules export, not a broken
    // group envelope: the message says so instead of naming a field it lacks (#98).
    expect(() => groups.validateGroupEnvelope({ rules: [] } as any)).toThrow(/plain rules export/);
    expect(() => groups.validateGroupEnvelope({ group: { name: 'X' } } as any)).toThrow(/rules must be an array/);
    expect(() =>
      groups.validateGroupEnvelope({ group: { name: 'X' }, rules: [{ domain: 'a', status: 'bogus' }] } as any),
    ).toThrow(/invalid status/);
    expect(() =>
      groups.validateGroupEnvelope({ group: { name: 'X' }, rules: [{ domain: 'a', status: 'allow', evil: 1 }] } as any),
    ).toThrow(/unknown field/);
  });

  it('accepts a bare { name, rules } envelope (top-level group meta)', () => {
    const env = groups.validateGroupEnvelope({
      name: 'Bare', description: 'no wrapper', shared: true,
      rules: [{ domain: 'a.example', container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null }],
    } as any);
    expect(env.group).toMatchObject({ name: 'Bare', description: 'no wrapper', shared: true });
    expect(env.rules).toHaveLength(1);
  });

  // ── #98 review feedback ─────────────────────────────────────────────────────

  it('apply leaves the stamped rules inside the group, in the target scope', () => {
    // Reviewer feedback on PR #98: applying "AlbertHeijn" to one container used
    // to create UNGROUPED copies, so the group could no longer be seen, exported
    // or re-applied as a unit in that scope.
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const g = dbMod.getGroupByName('OpenAI')!;
    groups.applyGroup(g.id, 'devcontainer-ah');
    const scoped = dbMod.db
      .prepare("SELECT domain, group_id FROM rules WHERE container_id = 'devcontainer-ah' AND path_pattern IS NULL AND domain = 'api.openai.com'")
      .get() as { domain: string; group_id: number | null };
    expect(scoped.group_id).toBe(g.id);
    // Nothing landed as "Ungrouped" in that scope.
    const ungrouped = dbMod.db
      .prepare("SELECT COUNT(*) AS n FROM rules WHERE container_id = 'devcontainer-ah' AND group_id IS NULL AND path_pattern IS NULL")
      .get() as { n: number };
    expect(ungrouped.n).toBe(0);
  });

  it('apply adopts a rule that already exists in the target scope into the group', () => {
    groups.importGroupEnvelope(groups.validateGroupEnvelope(envOpenAI()));
    const g = dbMod.getGroupByName('OpenAI')!;
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, source) VALUES ('api.openai.com', 'devcontainer-ah', 'deny', 'manual')").run();
    const res = groups.applyGroup(g.id, 'devcontainer-ah');
    expect(res.updated).toBe(1);
    const row = dbMod.db
      .prepare("SELECT status, group_id FROM rules WHERE container_id = 'devcontainer-ah' AND domain = 'api.openai.com'")
      .get() as { status: string; group_id: number | null };
    expect(row).toMatchObject({ status: 'allow', group_id: g.id });
  });

  it('a folder reload keeps applied copies and the group id they point at', () => {
    // Applied copies are source='manual', so the folder must neither delete them
    // (clear + replace-import) nor strip their membership by recreating the group
    // row under a fresh id.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-apply-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    groups.reloadFirewallRulesFolder();
    const g = dbMod.getGroupByName('OpenAI')!;
    groups.applyGroup(g.id, 'devcontainer-ah');

    const second = groups.reloadFirewallRulesFolder();
    expect(second.errors).toHaveLength(0);
    const after = dbMod.getGroupByName('OpenAI')!;
    expect(after.id).toBe(g.id); // same row, so the applied copies still belong to it
    const scoped = dbMod.db
      .prepare("SELECT COUNT(*) AS n FROM rules WHERE container_id = 'devcontainer-ah' AND group_id = ?")
      .get(after.id) as { n: number };
    expect(scoped.n).toBeGreaterThan(0);
  });

  it('ungroups (never orphans) rules of a group that disappeared from the folder', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-fw-stale-'));
    fs.writeFileSync(path.join(dir, 'openai.json'), JSON.stringify(envOpenAI()));
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = dir;
    groups.reloadFirewallRulesFolder();
    const g = dbMod.getGroupByName('OpenAI')!;
    groups.applyGroup(g.id, 'devcontainer-ah');

    fs.rmSync(path.join(dir, 'openai.json'));
    groups.reloadFirewallRulesFolder();
    expect(dbMod.getGroupByName('OpenAI')).toBeUndefined();
    // The applied copies survive as ordinary rules, pointing at no group at all —
    // a dangling group_id would hide them from every bucket in the portal.
    const dangling = dbMod.db
      .prepare('SELECT COUNT(*) AS n FROM rules WHERE group_id IS NOT NULL AND group_id NOT IN (SELECT id FROM firewall_groups)')
      .get() as { n: number };
    expect(dangling.n).toBe(0);
    const kept = dbMod.db
      .prepare("SELECT COUNT(*) AS n FROM rules WHERE container_id = 'devcontainer-ah'")
      .get() as { n: number };
    expect(kept.n).toBeGreaterThan(0);
  });

  it('explains that a flat rules export is not a group envelope', () => {
    // Reported on PR #98: exporting "All rules"/"Ungrouped" yields a document
    // without a `group`, and importing it said "group.name must be a non-empty
    // string".
    const flat = { version: 1, exported_at: 1, rules: [{ domain: 'a.example', container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null }] };
    expect(() => groups.validateGroupEnvelope(flat)).toThrow(/plain rules export/);
  });

  it('imports a large envelope in one batched lookup, without duplicating rules', () => {
    // The lookup is batched (was one query per rule); a re-import must still
    // update in place, and a duplicate entry inside one envelope must be skipped
    // rather than trip the unique index.
    const many = Array.from({ length: 120 }, (_, i) => ({
      domain: `d${i}.example`, container_id: null, status: 'allow', path_pattern: null, path_mode: 0, expires_at: null,
    }));
    const env = { version: 1, kind: 'huddle-firewall-group', group: { name: 'Bulk' }, rules: [...many, many[0]] };
    const first = groups.importGroupEnvelope(groups.validateGroupEnvelope(env));
    expect(first.imported).toBe(120);
    expect(first.skipped).toBe(1);
    const second = groups.importGroupEnvelope(groups.validateGroupEnvelope(env));
    expect(second.imported).toBe(0);
    expect(second.updated).toBe(120);
    const n = (dbMod.db.prepare('SELECT COUNT(*) AS n FROM rules').get() as { n: number }).n;
    expect(n).toBe(120);
  });

  it('export/apply include only ALLOWED sub-paths, not requested/deny placeholders', () => {
    // Grouped path-mode marker for the domain.
    groups.importGroupEnvelope(groups.validateGroupEnvelope({
      version: 1, kind: 'huddle-firewall-group',
      group: { name: 'NuGet', shared: false },
      rules: [{ domain: 'nuget.org', container_id: null, status: 'deny', path_pattern: null, path_mode: 1, expires_at: null }],
    }));
    const g = dbMod.getGroupByName('NuGet')!;
    // Ungrouped sub-paths for the same domain: one allowed (belongs to the group's
    // export), one still 'requested' (a pending placeholder that must NOT travel).
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, path_pattern, path_mode, source) VALUES ('nuget.org', NULL, 'allow', '/v3/*', 0, 'manual')").run();
    dbMod.db.prepare("INSERT INTO rules (domain, container_id, status, path_pattern, path_mode, source) VALUES ('nuget.org', NULL, 'requested', '/pending/*', 0, 'manual')").run();

    const env = groups.exportGroup(g.id)!;
    // marker + the single allowed sub-path only — NOT the requested placeholder.
    expect(env.rules).toHaveLength(2);
    const patterns = env.rules.map((r) => r.path_pattern);
    expect(patterns).toContain('/v3/*');
    expect(patterns).toContain(null);
    expect(patterns).not.toContain('/pending/*');

    groups.applyGroup(g.id, 'devcontainer-y');
    const scoped = dbMod.db
      .prepare("SELECT path_pattern FROM rules WHERE container_id = 'devcontainer-y' AND domain = 'nuget.org'")
      .all() as { path_pattern: string | null }[];
    expect(scoped).toHaveLength(2); // marker + allowed sub-path, not the requested one
  });
});
