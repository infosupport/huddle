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

// ── Prepared statements (built lazily so importing this module never touches an
//    uninitialised DB) ─────────────────────────────────────────────────────────

function findRuleStmt() {
  return db.prepare(
    `SELECT id, source FROM rules
      WHERE domain = ? COLLATE NOCASE
        AND COALESCE(container_id, '') = COALESCE(?, '')
        AND COALESCE(path_pattern, '') = COALESCE(?, '')`,
  );
}

// A group's members = its own rules PLUS, for any path-mode domain in the group
// (a status='deny', path_mode=1 marker), its allowed sub-path rules — those are
// created ungrouped (group_id NULL) but conceptually belong to the group. Without
// them a path-mode domain would export/apply as a bare "block at root" with no
// allowed paths. Shared by export and apply so the two can never disagree on what
// a group contains; `columns` differs only because apply re-targets container_id.
function memberRulesSql(columns: string): string {
  return `SELECT DISTINCT ${columns}
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
           )`;
}

// ── Export ─────────────────────────────────────────────────────────────────────

export function exportGroup(groupId: number): GroupEnvelope | null {
  const group = getGroup(groupId);
  if (!group) return null;
  const rules = db
    .prepare(
      `${memberRulesSql('r.domain, r.container_id, r.status, r.path_pattern, r.path_mode, r.expires_at')}
        ORDER BY r.domain COLLATE NOCASE, COALESCE(r.container_id, ''), COALESCE(r.path_pattern, '')`,
    )
    .all(groupId, groupId) as ShareableGroupRule[];
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
  containerOverride?: string | null,
): void {
  const seen = new Set<string>();
  for (const r of rules) {
    if (!r.path_pattern) continue;
    const container = containerOverride !== undefined ? containerOverride : r.container_id ?? null;
    const key = `${r.domain.toLowerCase()}\n${container ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ensurePathModeMarker(r.domain, container);
  }
}

export function importGroupEnvelope(
  env: GroupEnvelope,
  opts: { mode?: 'merge' | 'replace'; source?: string; addedBy?: string | null } = {},
): ImportGroupSummary {
  const mode = opts.mode ?? 'merge';
  const source = opts.source ?? 'manual';
  const addedBy = opts.addedBy ?? null;

  const find = findRuleStmt();
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
    // group ends up as an exact mirror of the envelope.
    if (mode === 'replace') {
      db.prepare(`DELETE FROM rules WHERE group_id = ?`).run(groupId);
    }

    const seen = new Set<string>();
    for (const r of env.rules) {
      const key = `${r.domain.toLowerCase()} ${r.container_id ?? ''} ${r.path_pattern ?? ''}`;
      if (seen.has(key)) { skipped++; continue; }
      seen.add(key);
      const existing = find.get(r.domain, r.container_id, r.path_pattern) as { id: number; source: string } | undefined;
      if (existing) {
        // Folder reload must not adopt a manually-created rule (that would
        // reclassify it as startup-folder and delete it on the next reload).
        if (source === 'startup-folder' && existing.source !== 'startup-folder') { skipped++; continue; }
        updateRule.run(r.status, r.expires_at, r.path_mode, groupId, source, existing.id);
        updated++;
      } else {
        insertRule.run(r.domain, r.container_id, r.status, r.expires_at, r.path_pattern, r.path_mode, groupId, addedBy, source);
        imported++;
      }
    }
    ensurePathModeMarkers(env.rules);
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
// rules. The copies are ungrouped (group_id NULL): the group stays the stable
// "template" whose membership never changes, and re-applying is idempotent via
// the (domain, container, path) unique key (existing copies are just refreshed).
export function applyGroup(
  groupId: number,
  container: string | null,
  addedBy: string | null = null,
): { applied: number; updated: number } {
  const group = getGroup(groupId);
  if (!group) throw new Error('group not found');
  const members = db
    .prepare(memberRulesSql('r.domain, r.status, r.path_pattern, r.path_mode, r.expires_at'))
    .all(groupId, groupId) as Omit<ShareableGroupRule, 'container_id'>[];

  const find = findRuleStmt();
  const insertRule = db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode, group_id, added_by, source)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'manual')`,
  );
  // Refresh an existing rule's policy without re-tagging its group membership.
  const updateRule = db.prepare(
    `UPDATE rules SET status = ?, expires_at = ?, path_mode = ?, updated_at = unixepoch() WHERE id = ?`,
  );

  let applied = 0;
  let updated = 0;
  const tx = db.transaction(() => {
    for (const m of members) {
      const existing = find.get(m.domain, container, m.path_pattern) as { id: number } | undefined;
      if (existing) {
        updateRule.run(m.status, m.expires_at, m.path_mode, existing.id);
        updated++;
      } else {
        insertRule.run(m.domain, container, m.status, m.expires_at, m.path_pattern, m.path_mode, addedBy);
        applied++;
      }
    }
    // Ensure the host-only path-mode marker exists in the TARGET scope for every
    // applied path rule, so path-scoped rules are admitted over HTTPS CONNECT.
    ensurePathModeMarkers(members, container);
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
export function clearFolderManagedRules(): void {
  db.prepare(`DELETE FROM rules WHERE source = 'startup-folder'`).run();
  db.prepare(`DELETE FROM firewall_groups WHERE source = 'startup-folder'`).run();
}
