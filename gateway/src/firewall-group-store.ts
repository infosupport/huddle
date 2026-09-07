// Persistence for firewall groups (#69): turning a group in the database into an
// envelope and back, and stamping a group's rules into a scope.
//
// A *group* is a named, reusable bundle of firewall rules for a product/service
// (OpenAI, GitHub, Node.js, …). This module owns only the database side of that:
// the envelope's shape and validation live in ./firewall-group-envelope, the
// team-managed folder (file I/O) in ./firewall-rules-folder.

import {
  db,
  createGroup,
  getGroup,
  getGroupByName,
  updateGroup,
  logAudit,
  type FirewallGroup,
} from './db';
import { notifyStateChanged } from './events';
import { ensurePathModeMarker } from './rules';
import {
  GROUP_ENVELOPE_KIND,
  GROUP_ENVELOPE_VERSION,
  type GroupEnvelope,
  type ShareableGroupRule,
} from './firewall-group-envelope';

export interface ImportGroupSummary {
  group: FirewallGroup;
  imported: number;
  updated: number;
  skipped: number;
}

// ── Rule lookup (statements are prepared inside the functions below, so
//    importing this module never touches an uninitialised DB) ────────────────

// The unique identity of a rule: domain case-insensitively, container and path
// with NULL and '' treated alike — exactly what the (domain, container, path)
// unique index enforces, and what the per-rule SELECT this replaces matched on.
function ruleKey(domain: string, containerId: string | null, pathPattern: string | null): string {
  return `${domain.toLowerCase()}\u0000${containerId ?? ''}\u0000${pathPattern ?? ''}`;
}

interface ExistingRule {
  id: number;
  source: string;
}

// Look the whole batch up in ONE query per ~400 domains instead of one query per
// rule: import and apply both walk a list of rules and used to run a point lookup
// inside the loop, which is an avoidable N+1 on a large envelope. Only the
// envelope's own domains are fetched, so this stays cheap on a big rules table.
function existingRuleIndex(rules: Array<{ domain: string }>): Map<string, ExistingRule> {
  const index = new Map<string, ExistingRule>();
  const domains = [...new Set(rules.map((r) => r.domain.toLowerCase()))];
  const CHUNK = 400; // comfortably under SQLite's bound-parameter limit
  for (let i = 0; i < domains.length; i += CHUNK) {
    const slice = domains.slice(i, i + CHUNK);
    // Placeholders only — no value is ever interpolated into the SQL text.
    const rows = db
      .prepare(
        `SELECT id, source, domain, container_id, path_pattern FROM rules
          WHERE domain COLLATE NOCASE IN (${slice.map(() => '?').join(', ')})`,
      )
      .all(...slice) as Array<ExistingRule & { domain: string; container_id: string | null; path_pattern: string | null }>;
    for (const row of rows) {
      index.set(ruleKey(row.domain, row.container_id, row.path_pattern), { id: row.id, source: row.source });
    }
  }
  return index;
}

// A group's members = its own rules PLUS, for any path-mode domain in the group
// (a status='deny', path_mode=1 marker), its allowed sub-path rules — those are
// created ungrouped (group_id NULL) but conceptually belong to the group. Without
// them a path-mode domain would export/apply as a bare "block at root" with no
// allowed paths.
//
// One statement, shared by export and apply, so the two can never disagree on
// what a group contains. It is a plain literal — building it from an interpolated
// column list would put a constructed string into db.prepare() for no gain, and
// apply's narrower de-duplication is done in memberRulesForScope() instead.
const MEMBER_RULES_SQL = `SELECT DISTINCT r.domain, r.container_id, r.status, r.path_pattern, r.path_mode, r.expires_at
     FROM rules r
    WHERE r.group_id = ?
       OR (
         -- Only the ALLOWED SUB-PATH entries of a grouped path-mode domain
         -- (an allow rule with a path_pattern). A requested placeholder or a
         -- redundant path-deny for the same domain/container must NOT be
         -- swept into the group's export/apply.
         r.path_pattern IS NOT NULL AND r.status = 'allow' AND EXISTS (
           SELECT 1 FROM rules m
            WHERE m.group_id = ?
              AND m.path_mode = 1 AND m.path_pattern IS NULL
              AND m.domain = r.domain COLLATE NOCASE
              AND COALESCE(m.container_id, '') = COALESCE(r.container_id, '')
         )
       )
    ORDER BY r.domain COLLATE NOCASE, COALESCE(r.container_id, ''), COALESCE(r.path_pattern, '')`;

function memberRules(groupId: number): ShareableGroupRule[] {
  return db.prepare(MEMBER_RULES_SQL).all(groupId, groupId) as ShareableGroupRule[];
}

// Members as apply() needs them: it re-targets every rule at one scope, so the
// original container_id is irrelevant and two members that differ ONLY by
// container_id would otherwise be stamped into the same scope twice (the second
// landing as an "update" of the first). Collapsing them here keeps apply's view
// identical to the `SELECT DISTINCT` without container_id that it used to run.
function memberRulesForScope(groupId: number): Omit<ShareableGroupRule, 'container_id'>[] {
  const seen = new Set<string>();
  const members: Omit<ShareableGroupRule, 'container_id'>[] = [];
  for (const { container_id: _ignored, ...m } of memberRules(groupId)) {
    const key = JSON.stringify([m.domain, m.status, m.path_pattern, m.path_mode, m.expires_at]);
    if (seen.has(key)) continue;
    seen.add(key);
    members.push(m);
  }
  return members;
}

// ── Export ─────────────────────────────────────────────────────────────────────

export function exportGroup(groupId: number): GroupEnvelope | null {
  const group = getGroup(groupId);
  if (!group) return null;
  const rules = memberRules(groupId);
  return {
    version: GROUP_ENVELOPE_VERSION,
    kind: GROUP_ENVELOPE_KIND,
    exported_at: Math.floor(Date.now() / 1000),
    group: { name: group.name, description: group.description, shared: group.shared === 1 },
    rules,
  };
}

// ── Import (create/update the group + upsert its rules) ─────────────────────────

// Create the group or update the one that already carries this name, and return
// its id. Throws when the team folder would hijack a manually-created group.
function upsertGroupRow(env: GroupEnvelope, source: string): number {
  const existingGroup = getGroupByName(env.group.name);
  if (!existingGroup) {
    return createGroup({
      name: env.group.name,
      description: env.group.description ?? '',
      shared: env.group.shared ? 1 : 0,
      source,
    });
  }
  // A team-folder reload must never hijack a manually-created (or system)
  // group: rewriting its source to 'startup-folder' would make the next
  // reload delete it. Refuse and let the caller report it instead.
  if (source === 'startup-folder' && existingGroup.source !== 'startup-folder') {
    throw new Error(
      `a ${existingGroup.source} group named "${env.group.name}" already exists — not overwriting it from the team folder`,
    );
  }
  updateGroup(existingGroup.id, {
    description: env.group.description ?? existingGroup.description,
    shared: env.group.shared ? 1 : existingGroup.shared,
    source,
  });
  return existingGroup.id;
}

// Path-scoped rules are inert over HTTPS unless their domain is in path-mode:
// establish the host-only path_mode=1 marker once per (domain, container) that got
// a path rule, mirroring the flat import and single-rule create paths. Idempotent —
// a marker already present in the envelope is left as-is. `containerOverride`
// re-targets the marker at the scope apply() is stamping into.
function ensurePathModeMarkers(
  rules: Array<Pick<ShareableGroupRule, 'domain' | 'path_pattern'> & { container_id?: string | null }>,
  containerOverride: string | null | undefined,
  groupId: number,
): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r.path_pattern) continue;
    const container = containerOverride !== undefined ? containerOverride : r.container_id ?? null;
    const key = `${r.domain.toLowerCase()}\n${container ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The marker joins the group as well, so a path-mode domain the group brings
    // along is not left sitting in "Ungrouped" (#98).
    ensurePathModeMarker(r.domain, container, groupId);
  }
}

export function importGroupEnvelope(
  env: GroupEnvelope,
  opts: { mode?: 'merge' | 'replace'; source?: string; addedBy?: string | null } = {},
): ImportGroupSummary {
  const mode = opts.mode ?? 'merge';
  const source = opts.source ?? 'manual';
  const addedBy = opts.addedBy ?? null;

  const insertRule = db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode, group_id, added_by, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateRule = db.prepare(
    `UPDATE rules SET status = ?, expires_at = ?, path_mode = ?, group_id = ?, source = ?, updated_at = unixepoch()
      WHERE id = ?`,
  );

  let imported = 0;
  let updated = 0;
  let skipped = 0;
  let group!: FirewallGroup;

  const tx = db.transaction(() => {
    const groupId = upsertGroupRow(env, source);

    // 'replace' clears the group's current members before re-inserting, so the
    // group ends up as an exact mirror of the envelope — but only for the rules
    // THIS source owns. Since apply() now leaves its copies in the group (#98),
    // a folder reload must not delete the copies an operator applied to a
    // container by hand (those are source='manual'), and a manual re-import must
    // not delete what the team folder owns.
    if (mode === 'replace') {
      db.prepare(`DELETE FROM rules WHERE group_id = ? AND source = ?`).run(groupId, source);
    }

    // Read the batch AFTER the replace-delete, so the index can never hand out
    // the id of a row this import just removed.
    const existing = existingRuleIndex(env.rules);
    const seen = new Set<string>();
    for (const r of env.rules) {
      const key = ruleKey(r.domain, r.container_id, r.path_pattern);
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const hit = existing.get(key);
      if (hit) {
        // Folder reload must not adopt a manually-created rule (that would
        // reclassify it as startup-folder and delete it on the next reload).
        if (source === 'startup-folder' && hit.source !== 'startup-folder') { skipped++; continue; }
        updateRule.run(r.status, r.expires_at, r.path_mode, groupId, source, hit.id);
        updated++;
      } else {
        const res = insertRule.run(r.domain, r.container_id, r.status, r.expires_at, r.path_pattern, r.path_mode, groupId, addedBy, source);
        // Keep the index in step with what we just wrote: the batch was read
        // before the loop, so without this a second envelope entry for the same
        // rule identity would insert again and trip the unique index.
        existing.set(key, { id: Number(res.lastInsertRowid), source });
        imported++;
      }
    }
    ensurePathModeMarkers(env.rules, undefined, groupId);
    group = getGroup(groupId)!;
  });
  tx();

  logAudit({
    containerId: null,
    domain: 'firewall',
    action: `admin:group-import-${mode}`,
    path: `group=${env.group.name} imported=${imported} updated=${updated} skipped=${skipped}`,
  });
  notifyStateChanged();
  return { group, imported, updated, skipped };
}

// ── Apply a group to a scope (global or one container) ──────────────────────────
//
// Stamps the group's member rules into the target scope as concrete, active
// rules, and LEAVES THEM IN THE GROUP (#98): applying decides *where* a group is
// in force, so a group applied to one container is still that group there —
// otherwise the copies showed up as loose "Ungrouped" rules and the group could
// no longer be exported, re-applied or removed as a unit. Re-applying is
// idempotent via the (domain, container, path) unique key: an existing rule in
// the target scope is refreshed and adopted into the group.
export function applyGroup(
  groupId: number,
  container: string | null,
  addedBy: string | null = null,
): { applied: number; updated: number } {
  const group = getGroup(groupId);
  if (!group) throw new Error('group not found');
  const members = memberRulesForScope(groupId);

  const insertRule = db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode, group_id, added_by, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual')`,
  );
  // Refresh an existing rule's policy AND make it a member of the group being
  // applied — the group defines this rule in this scope, so leaving it outside
  // the group would hide it from the group's own export/apply/delete.
  const updateRule = db.prepare(
    `UPDATE rules SET status = ?, expires_at = ?, path_mode = ?, group_id = ?, updated_at = unixepoch() WHERE id = ?`,
  );

  let applied = 0;
  let updated = 0;
  const tx = db.transaction(() => {
    const existing = existingRuleIndex(members);
    for (const m of members) {
      const key = ruleKey(m.domain, container, m.path_pattern);
      const hit = existing.get(key);
      if (hit) {
        updateRule.run(m.status, m.expires_at, m.path_mode, groupId, hit.id);
        updated++;
      } else {
        const res = insertRule.run(m.domain, container, m.status, m.expires_at, m.path_pattern, m.path_mode, groupId, addedBy);
        // The index was read before the loop; record the insert so two members
        // that collapse onto the same identity in this scope can never insert
        // twice and trip the unique index.
        existing.set(key, { id: Number(res.lastInsertRowid), source: 'manual' });
        applied++;
      }
    }
    // Ensure the host-only path-mode marker exists in the TARGET scope for every
    // applied path rule, so path-scoped rules are admitted over HTTPS CONNECT.
    ensurePathModeMarkers(members, container, groupId);
  });
  tx();

  logAudit({
    containerId: container,
    domain: 'firewall',
    action: 'admin:group-apply',
    path: `group=${group.name} applied=${applied} updated=${updated}`,
  });
  notifyStateChanged();
  return { applied, updated };
}

// ── Source re-tagging (used by the folder write-back) ───────────────────────────

// Mark a group and its member rules as folder-managed, so the next folder reload
// updates the group in place instead of aborting on the "don't overwrite a manual
// group from the folder" guard in upsertGroupRow().
export function retagGroupAsFolderManaged(groupId: number): void {
  const tx = db.transaction(() => {
    db.prepare(`UPDATE firewall_groups SET source = 'startup-folder', updated_at = unixepoch() WHERE id = ?`).run(groupId);
    db.prepare(`UPDATE rules SET source = 'startup-folder' WHERE group_id = ?`).run(groupId);
  });
  tx();
}

// Drop everything the team folder currently manages. Only source='startup-folder'
// rows are ever touched; manual (UI/API) groups and rules are left alone. Called
// inside the folder-reload transaction so a failed reload rolls this back too.
//
// `keepGroups` names the groups the folder is about to re-import. Those group
// ROWS survive (their rules are still cleared and re-imported), so a group keeps
// its id across a reload — without that, rules an operator applied to a
// container would be left pointing at a deleted group id. A folder group that is
// gone from the folder is deleted, and anything still pointing at it is
// ungrouped rather than orphaned.
export function clearFolderManagedRules(keepGroups: string[] = []): void {
  db.prepare(`DELETE FROM rules WHERE source = 'startup-folder'`).run();
  const keep = new Set(keepGroups.map((n) => n.trim().toLowerCase()));
  const folderGroups = db
    .prepare(`SELECT id, name FROM firewall_groups WHERE source = 'startup-folder'`)
    .all() as { id: number; name: string }[];
  for (const g of folderGroups) {
    if (keep.has(g.name.toLowerCase())) continue;
    db.prepare(`UPDATE rules SET group_id = NULL WHERE group_id = ?`).run(g.id);
    db.prepare(`DELETE FROM firewall_groups WHERE id = ?`).run(g.id);
  }
}
