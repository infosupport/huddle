// Firewall groups + team-managed rules folder (#69).
//
// A *group* is a named, reusable bundle of firewall rules for a product/service
// (OpenAI, GitHub, Node.js, …). Groups can be created in the portal, imported
// and exported as a JSON envelope, applied to a scope (global or one container),
// and loaded automatically from a team-managed folder that teams keep in Git.
//
// The import/export envelope and the on-disk folder files use the SAME format so
// a group can move freely between installs, repos and teammates.

import fs from 'fs';
import path from 'path';
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

export const GROUP_ENVELOPE_VERSION = 1;
export const GROUP_ENVELOPE_KIND = 'huddle-firewall-group';

type RuleStatus = 'requested' | 'allow' | 'deny';

// The shareable subset of a rule inside a group envelope — volatile columns
// (id/counters/timestamps) are stripped, exactly like the flat rules export.
export interface ShareableGroupRule {
  domain: string;
  container_id: string | null;
  status: RuleStatus;
  path_pattern: string | null;
  path_mode: number;
  expires_at: number | null;
}

export interface GroupEnvelope {
  version: number;
  kind: string;
  exported_at?: number;
  group: { name: string; description?: string; shared?: boolean };
  rules: ShareableGroupRule[];
}

export interface ImportGroupSummary {
  group: FirewallGroup;
  imported: number;
  updated: number;
  skipped: number;
}

const RULE_FIELDS = new Set(['domain', 'container_id', 'status', 'path_pattern', 'path_mode', 'expires_at']);

// Validate one incoming rule fail-closed (unknown key → reject, every field
// type-checked). Mirrors the flat-import validator so both paths behave alike.
export function validateGroupRule(raw: unknown): ShareableGroupRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('rule must be an object');
  const r = raw as Record<string, unknown>;
  const unknown = Object.keys(r).filter((k) => !RULE_FIELDS.has(k));
  if (unknown.length > 0) throw new Error(`unknown field(s): ${unknown.join(', ')}`);
  if (typeof r.domain !== 'string' || !r.domain) throw new Error('domain must be a non-empty string');
  if (r.status !== 'requested' && r.status !== 'allow' && r.status !== 'deny') {
    throw new Error(`invalid status: ${String(r.status)}`);
  }
  const container_id = r.container_id === undefined || r.container_id === null ? null : r.container_id;
  if (container_id !== null && typeof container_id !== 'string') throw new Error('container_id must be a string or null');
  const path_pattern = r.path_pattern === undefined || r.path_pattern === null ? null : r.path_pattern;
  if (path_pattern !== null && typeof path_pattern !== 'string') throw new Error('path_pattern must be a string or null');
  const path_mode = r.path_mode === undefined || r.path_mode === null ? 0 : r.path_mode;
  if (path_mode !== 0 && path_mode !== 1) throw new Error('path_mode must be 0 or 1');
  const expires_at = r.expires_at === undefined || r.expires_at === null ? null : r.expires_at;
  if (expires_at !== null && (typeof expires_at !== 'number' || !Number.isFinite(expires_at))) {
    throw new Error('expires_at must be a number or null');
  }
  return { domain: r.domain, container_id, status: r.status, path_pattern, path_mode, expires_at };
}

// Validate a whole envelope fail-closed. Accepts the versioned `kind` envelope;
// also tolerates a bare `{ name, rules }` for convenience.
export function validateGroupEnvelope(raw: unknown): GroupEnvelope {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('envelope must be an object');
  const e = raw as Record<string, unknown>;
  const groupRaw = (e.group ?? {}) as Record<string, unknown>;
  const name = typeof groupRaw.name === 'string' && groupRaw.name.trim() ? groupRaw.name.trim() : undefined;
  if (!name) throw new Error('group.name must be a non-empty string');
  const description = typeof groupRaw.description === 'string' ? groupRaw.description : '';
  const shared = groupRaw.shared === true || groupRaw.shared === 1;
  if (!Array.isArray(e.rules)) throw new Error('rules must be an array');
  const rules = e.rules.map(validateGroupRule);
  return {
    version: typeof e.version === 'number' ? e.version : GROUP_ENVELOPE_VERSION,
    kind: typeof e.kind === 'string' ? e.kind : GROUP_ENVELOPE_KIND,
    group: { name, description, shared },
    rules,
  };
}

// ── Prepared statements (built lazily so importing this module never touches an
//    uninitialised DB) ─────────────────────────────────────────────────────────

function findRuleStmt() {
  return db.prepare(
    `SELECT id FROM rules
      WHERE domain = ? COLLATE NOCASE
        AND COALESCE(container_id, '') = COALESCE(?, '')
        AND COALESCE(path_pattern, '') = COALESCE(?, '')`,
  );
}

// ── Export ─────────────────────────────────────────────────────────────────────

export function exportGroup(groupId: number): GroupEnvelope | null {
  const group = getGroup(groupId);
  if (!group) return null;
  const rules = db
    .prepare(
      `SELECT domain, container_id, status, path_pattern, path_mode, expires_at
         FROM rules WHERE group_id = ?
        ORDER BY domain COLLATE NOCASE, COALESCE(container_id, ''), COALESCE(path_pattern, '')`,
    )
    .all(groupId) as ShareableGroupRule[];
  return {
    version: GROUP_ENVELOPE_VERSION,
    kind: GROUP_ENVELOPE_KIND,
    exported_at: Math.floor(Date.now() / 1000),
    group: { name: group.name, description: group.description, shared: group.shared === 1 },
    rules,
  };
}

// ── Import (create/update the group + upsert its rules) ─────────────────────────

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
    const existingGroup = getGroupByName(env.group.name);
    let groupId: number;
    if (existingGroup) {
      groupId = existingGroup.id;
      updateGroup(groupId, {
        description: env.group.description ?? existingGroup.description,
        shared: env.group.shared ? 1 : existingGroup.shared,
        source,
      });
    } else {
      groupId = createGroup({
        name: env.group.name,
        description: env.group.description ?? '',
        shared: env.group.shared ? 1 : 0,
        source,
      });
    }

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
      const existing = find.get(r.domain, r.container_id, r.path_pattern) as { id: number } | undefined;
      if (existing) {
        updateRule.run(r.status, r.expires_at, r.path_mode, groupId, source, existing.id);
        updated++;
      } else {
        insertRule.run(r.domain, r.container_id, r.status, r.expires_at, r.path_pattern, r.path_mode, groupId, addedBy, source);
        imported++;
      }
    }
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
    .prepare(`SELECT domain, status, path_pattern, path_mode, expires_at FROM rules WHERE group_id = ?`)
    .all(groupId) as Omit<ShareableGroupRule, 'container_id'>[];

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

// ── Team-managed rules folder (startup + reload) ────────────────────────────────
//
// Reads every *.json file in the configured folder as a group envelope and loads
// it with source='startup-folder'. Idempotent: startup-folder groups/rules that
// no longer appear in the folder are removed first, so the folder is the single
// source of truth for the rules it manages. Manual (UI/API) groups are untouched.

export interface FolderReloadSummary {
  folder: string | null;
  files: number;
  groups: number;
  imported: number;
  updated: number;
  errors: { file: string; message: string }[];
}

export function reloadFirewallRulesFolder(folder: string | null): FolderReloadSummary {
  const summary: FolderReloadSummary = { folder, files: 0, groups: 0, imported: 0, updated: 0, errors: [] };
  if (!folder || !folder.trim()) return summary;

  let entries: string[] = [];
  try {
    entries = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.json')).sort();
  } catch (err) {
    summary.errors.push({ file: folder, message: `cannot read folder: ${(err as Error).message}` });
    return summary;
  }

  // Drop the previous startup-folder state first (rules then groups), so removed
  // files disappear. Only source='startup-folder' rows are touched.
  const clear = db.transaction(() => {
    db.prepare(`DELETE FROM rules WHERE source = 'startup-folder'`).run();
    db.prepare(`DELETE FROM firewall_groups WHERE source = 'startup-folder'`).run();
  });
  clear();

  for (const file of entries) {
    summary.files++;
    const full = path.join(folder, file);
    try {
      const raw = fs.readFileSync(full, 'utf8');
      const env = validateGroupEnvelope(JSON.parse(raw));
      const res = importGroupEnvelope(env, { mode: 'replace', source: 'startup-folder', addedBy: 'team-folder' });
      summary.groups++;
      summary.imported += res.imported;
      summary.updated += res.updated;
    } catch (err) {
      summary.errors.push({ file, message: (err as Error).message });
    }
  }

  logAudit({
    containerId: null,
    domain: 'firewall',
    action: 'admin:folder-reload',
    path: `folder=${folder} files=${summary.files} groups=${summary.groups} imported=${summary.imported} errors=${summary.errors.length}`,
  });
  notifyStateChanged();
  return summary;
}

export const FIREWALL_RULES_FOLDER_KEY = 'firewall_rules_folder';
export const EXTENSIONS_FOLDER_KEY = 'extensions_folder';
