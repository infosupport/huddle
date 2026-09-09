// The firewall-group envelope: its shape, and the fail-closed validation of
// anything claiming to be one (#69).
//
// Deliberately pure — no DB, no filesystem, no audit. Every way a group can
// enter huddle (portal upload, API body, a file in the team-managed rules
// folder) funnels through here first, so the parsing rules live in exactly one
// place and are testable without a database.
//
// The import/export envelope and the on-disk folder files use the SAME format so
// a group can move freely between installs, repos and teammates.

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
  // Full envelope keeps group meta under `group`; a bare `{ name, rules }` puts
  // it at the top level. Read from `e.group` when it is a plain object, else fall
  // back to `e` itself so the documented bare form actually works.
  const groupRaw = (e.group && typeof e.group === 'object' && !Array.isArray(e.group) ? e.group : e) as Record<string, unknown>;
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

// Serialise an envelope the way the team folder stores it (stable 2-space JSON
// with a trailing newline, so a synced folder stays Git-diff friendly).
export function serializeGroupEnvelope(env: GroupEnvelope): string {
  return JSON.stringify(env, null, 2) + '\n';
}
