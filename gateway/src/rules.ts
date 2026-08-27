import { db, getAirlocked } from './db';
import { notifyStateChanged } from './events';
import { matchDomain, type RuleRow, type RuleStatus } from './rule-match';
import { decide, type Candidate, type PolicyDecision, type PolicyEffect, type PolicySnapshot } from './control/decide';

// The rule vocabulary and the pure host/path matching now live in ./rule-match,
// and the decision itself in ./control/decide. Re-exported here so every caller
// and test keeps importing them from './rules' — this module remains the place
// where rules meet the database.
export type { RuleStatus, RuleRow } from './rule-match';
export { canonicalizeHost, normalizePathname, matchDomain, matchPath, firstSegmentPattern } from './rule-match';

let stmts: ReturnType<typeof prepareStmts> | null = null;

function prepareStmts() {
  return {
    // COLLATE NOCASE: the exact-host lookup must be case-insensitive, just like
    // matchDomain (which lowercases both sides). Without this an exact deny rule
    // was bypassed by capitalizing the host differently (finding #3). Domains
    // are moreover stored lowercase (see checkRule + db.ts migration) — this is
    // the belt-and-suspenders SQL side.
    selectPerContainer: db.prepare<[string, string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND container_id = ?`
    ),
    selectGlobal: db.prepare<[string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND container_id IS NULL`
    ),
    selectWildcardPerContainer: db.prepare<[string]>(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain LIKE '*.%' AND container_id = ?`
    ),
    selectWildcardGlobal: db.prepare(
      `SELECT id, domain, status, expires_at, container_id, path_pattern, path_mode FROM rules WHERE domain LIKE '*.%' AND container_id IS NULL`
    ),
    touchRule: db.prepare<[number]>(
      `UPDATE rules SET last_seen = unixepoch(), request_count = request_count + 1 WHERE id = ?`
    ),
    setLastPath: db.prepare<[string, number]>(
      `UPDATE rules SET last_path = ? WHERE id = ?`
    ),
    insertRequested: db.prepare<[string, string | null]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status) VALUES (?, ?, 'requested')`
    ),
    insertRequestedPath: db.prepare<[string, string | null, string]>(
      `INSERT OR IGNORE INTO rules (domain, container_id, status, path_pattern) VALUES (?, ?, 'requested', ?)`
    ),
    resetExpired: db.prepare<[number]>(
      `UPDATE rules SET status='requested', updated_at=unixepoch() WHERE id=?`
    ),
  };
}

function s() {
  if (!stmts) stmts = prepareStmts();
  return stmts;
}
// Fetch every rule that could apply to this request. The airlock is applied
// here rather than in decide(): an isolated container gets NO global-rule
// fallback — only its own allow rules count, and all other traffic is filed as
// requested — so its snapshot simply carries no global rows.
function readPolicySnapshot(domain: string, containerId: string | null): PolicySnapshot {
  const { selectPerContainer, selectGlobal, selectWildcardPerContainer, selectWildcardGlobal } = s();
  const airlocked = containerId ? getAirlocked(containerId) : false;
  return {
    containerId,
    perContainerExact: containerId ? (selectPerContainer.all(domain, containerId) as RuleRow[]) : [],
    perContainerWildcard: containerId ? (selectWildcardPerContainer.all(containerId) as RuleRow[]) : [],
    globalExact: airlocked ? [] : (selectGlobal.all(domain) as RuleRow[]),
    globalWildcard: airlocked ? [] : (selectWildcardGlobal.all() as RuleRow[]),
  };
}

// File a host (or an unknown subpath group) as 'requested' and return the id the
// database gave it. INSERT OR IGNORE deliberately swallows a concurrent insert,
// so the row is read back rather than assumed: two proxied requests for the same
// blocked host must end up pointing at the same rule.
function createRequestedRule(effect: Extract<PolicyEffect, { kind: 'create-requested' }>): number | null {
  const { selectPerContainer, selectGlobal, insertRequested, insertRequestedPath, touchRule, setLastPath } = s();
  const { domain, containerId, pathPattern, lastPath } = effect;
  const inserted = pathPattern === null
    ? insertRequested.run(domain, containerId)
    : insertRequestedPath.run(domain, containerId, pathPattern);
  // Only a genuinely new row is news for the operator's UI.
  if (inserted.changes > 0) notifyStateChanged();
  const rows = (containerId
    ? selectPerContainer.all(domain, containerId)
    : selectGlobal.all(domain)) as RuleRow[];
  const created = rows.find(r => r.path_pattern === pathPattern);
  if (!created) return null;
  if (lastPath !== null) setLastPath.run(lastPath, created.id);
  touchRule.run(created.id);
  return created.id;
}

// Perform the writes a decision implies. Creating a rule is the only effect that
// changes the answer: it mints the id the caller (and the audit entry) refers to.
function applyDecision(decision: PolicyDecision): { status: RuleStatus; ruleId: number | null } {
  const { touchRule, setLastPath, resetExpired } = s();
  let ruleId = decision.ruleId;
  for (const effect of decision.effects) {
    switch (effect.kind) {
      case 'touch': touchRule.run(effect.ruleId); break;
      case 'set-last-path': setLastPath.run(effect.path, effect.ruleId); break;
      case 'reset-expired': resetExpired.run(effect.ruleId); break;
      case 'create-requested': ruleId = createRequestedRule(effect); break;
    }
  }
  return { status: decision.status, ruleId };
}

export function checkRule(
  rawDomain: string,
  containerId: string | null,
  path: string | null = null,
): { status: RuleStatus; ruleId: number | null } {
  // Canonicalize the host once at the boundary: lowercase so that exact lookups
  // and wildcard matching operate on the same form (finding #3). The proxy
  // already performs the full punycode/trailing-dot canonicalization via
  // canonicalizeHost; here we lowercase defensively for direct callers/tests.
  const domain = rawDomain.toLowerCase();
  const snapshot = readPolicySnapshot(domain, containerId);
  const decision = decide(snapshot, domain, path, Math.floor(Date.now() / 1000));
  return applyDecision(decision);
}


/**
 * Evaluate a SANDBOX-FLEET request. Huddle's proxy can't attribute a live request
 * to a specific sandbox (all sbx egress arrives aggregated), so we match against
 * the MERGE of: all GLOBAL rules + all rules of EVERY known sandbox. Because sbx
 * has already enforced per-box (deny-by-default) before forwarding upstream, a
 * request only reaches here if some box was allowed to make it — so at the fleet
 * layer ALLOW wins if any sandbox (or global) allows the host. A GLOBAL deny is
 * authoritative (operator blocked it for everyone). Host-level only (sbx policy
 * has no paths); never creates a `requested` row (discovery is via the sbx log).
 */
export function checkFleetRule(
  rawDomain: string,
  sandboxNames: Set<string>,
  path: string | null = null,
): { status: RuleStatus; ruleId: number | null } {
  const domain = rawDomain.toLowerCase();

  // PATH MODE is fleet-wide (GLOBAL) for sandboxes — sbx can't do paths, so the
  // domain is allowed in every sandbox and Huddle enforces the paths here. If a
  // GLOBAL path-mode marker exists for this host, delegate to the global path
  // logic: admit the CONNECT tunnel (path still encrypted) so MITM can read the
  // path, then per request allow the matched paths / file unknown subpaths as a
  // global `requested`.
  if (isPathMode(domain, null)) {
    if (path === null) return { status: 'allow', ruleId: null };
    return checkRule(domain, null, path);
  }

  const { selectPerContainer, selectGlobal, selectWildcardPerContainer, selectWildcardGlobal, touchRule } = s();
  const now = Math.floor(Date.now() / 1000);

  type Tagged = { rule: Candidate; isGlobal: boolean };
  const cands: Tagged[] = [];
  const collect = (rows: RuleRow[], isGlobal: boolean, wildcard: boolean) => {
    for (const r of rows) {
      if (r.path_pattern) continue; // host-level only at the fleet layer
      if (wildcard ? matchDomain(r.domain, domain) : true) {
        cands.push({ rule: { ...r, domain_is_wildcard: wildcard }, isGlobal });
      }
    }
  };
  collect(selectGlobal.all(domain) as RuleRow[], true, false);
  collect(selectWildcardGlobal.all() as RuleRow[], true, true);
  for (const name of sandboxNames) {
    collect(selectPerContainer.all(domain, name) as RuleRow[], false, false);
    collect(selectWildcardPerContainer.all(name) as RuleRow[], false, true);
  }

  const live = (c: Tagged) => c.rule.status !== 'allow' || c.rule.expires_at === null || c.rule.expires_at >= now;
  const globalDeny = cands.find((c) => c.isGlobal && c.rule.status === 'deny');
  if (globalDeny) { touchRule.run(globalDeny.rule.id); return { status: 'deny', ruleId: globalDeny.rule.id }; }
  const allow = cands.find((c) => c.rule.status === 'allow' && live(c));
  if (allow) { touchRule.run(allow.rule.id); return { status: 'allow', ruleId: allow.rule.id }; }
  const anyDeny = cands.find((c) => c.rule.status === 'deny');
  if (anyDeny) { touchRule.run(anyDeny.rule.id); return { status: 'deny', ruleId: anyDeny.rule.id }; }
  // No match / only a stale 'requested' — block, but DON'T auto-file (can't
  // attribute to a box; discovery of blocked hosts is done via the sbx policy log).
  return { status: 'requested', ruleId: null };
}

// Is this domain in path-allowlist mode? I.e. does a host-only marker rule
// (path_mode=1) exist that applies to this container or globally. The proxy uses
// this at CONNECT (path still encrypted) to allow the HTTPS tunnel anyway, so
// that MITM can see the path and the real enforcement happens per request.
export function isPathMode(domain: string, containerId: string | null): boolean {
  const { selectPerContainer, selectGlobal } = s();
  const rows = [
    ...(containerId ? (selectPerContainer.all(domain, containerId) as RuleRow[]) : []),
    ...(selectGlobal.all(domain) as RuleRow[]),
  ];
  return rows.some(r => r.path_pattern === null && r.path_mode === 1);
}

// Ensure a domain is in path-allowlist mode after a path-scoped rule is created.
// A path rule is inert over HTTPS unless a host-only marker (path_pattern IS NULL)
// with path_mode=1 exists: the proxy only sees the host at CONNECT and admits the
// tunnel (so MITM can read the path) only for a path-mode domain. Without the
// marker the CONNECT is refused and the path rule never fires (finding #6a).
// Idempotent: creates the marker, or promotes an existing host-only row to one
// (a stale 'requested' placeholder becomes a default-deny marker; an explicit
// allow/deny keeps its decision).
export function ensurePathModeMarker(domain: string, containerId: string | null): void {
  const marker = db
    .prepare(
      `SELECT id, status, path_mode FROM rules WHERE domain = ? COLLATE NOCASE AND COALESCE(container_id, '') = COALESCE(?, '') AND path_pattern IS NULL`
    )
    .get(domain, containerId) as { id: number; status: RuleStatus; path_mode: number } | undefined;
  if (!marker) {
    db.prepare(
      `INSERT INTO rules (domain, container_id, status, path_pattern, path_mode) VALUES (?, ?, 'deny', NULL, 1)`
    ).run(domain, containerId);
  } else if (marker.path_mode !== 1) {
    const status = marker.status === 'requested' ? 'deny' : marker.status;
    db.prepare(`UPDATE rules SET path_mode = 1, status = ?, updated_at = unixepoch() WHERE id = ?`).run(status, marker.id);
  }
}
