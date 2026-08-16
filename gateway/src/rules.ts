import { db, getAirlocked } from './db';
import { notifyStateChanged } from './events';

export type RuleStatus = 'allow' | 'deny' | 'requested';

interface RuleRow {
  id: number;
  domain: string;
  status: RuleStatus;
  expires_at: number | null;
  container_id: string | null;
  path_pattern: string | null;
  path_mode: number;
}

// ── Pure match helpers (no DB) ───────────────────────────────────────────────
// Deliberately decoupled from the DB so they are deterministically testable
// without a running SQLite binding.

// Canonicalize a host to exactly the form in which the downstream (OS resolver,
// SNI, upstream server) will interpret it, so the proxy normalizes in one place
// — at the boundary — and then both matches and forwards on that same value.
// Prevents the parser-differential class (finding #3 and its tail: uppercase,
// IDN/punycode, trailing dot, control chars).
//
// Returns the canonical host (lowercase, punycode, without trailing dot) or
// null when the host is invalid/suspicious (control chars, whitespace, empty or
// unparseable host) — the caller must then fail-closed and reject.
export function canonicalizeHost(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // Control chars and whitespace never belong in a host (request smuggling /
  // log injection) — reject them explicitly before parsing.
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(trimmed)) return null;
  let host: string;
  try {
    // The WHATWG URL parser performs exactly the canonicalization the
    // downstream also does: lowercasing, applying IDNA/punycode, validating the
    // host and normalizing bracketed IPv6. We only feed in the authority.
    host = new URL(`http://${trimmed}`).hostname;
  } catch {
    return null;
  }
  if (!host) return null;
  // Strip one trailing dot (FQDN root): `a.b.` and `a.b` are the same host for
  // DNS/SNI. A double dot at the end is invalid → drop it.
  if (host.endsWith('.') && !host.endsWith('..')) host = host.slice(0, -1);
  return host.toLowerCase();
}

// Normalize a request path to the form in which the upstream will interpret it,
// so path-allowlist matching cannot be bypassed with traversal (finding #7).
// Strategy: drop query/fragment, percent-decode once, and fail-closed reject
// (null) as soon as a `..` segment remains or the encoding is broken. `.`
// segments are folded away. Deliberately NO further canonicalization than that:
// the path we forward stays the original (encoded) bytes, so legitimate
// %-encoded characters are not mangled — we decide on the decoded form, but
// traversal is always blocked, so `..` bytes are never forwarded.
export function normalizePathname(raw: string | null): string | null {
  const input = raw ?? '';
  // Query and fragment are not part of the path; strip them before decoding.
  let p = input.split('#')[0].split('?')[0];
  if (p === '') p = '/';
  let decoded: string;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // Broken percent-encoding (e.g. `%zz`, `%2`) → fail closed.
    return null;
  }
  const segs = decoded.split('/');
  // Every `..` segment after one decode is traversal — legitimate flows do not
  // need it. Fail closed instead of trying to resolve (which opens double-decode
  // and clamp-to-root variants).
  if (segs.some(s => s === '..')) return null;
  // `.` segments (current directory) are harmless but pollute the match; fold
  // them away. Empty segments (`//`, leading `/`) remain so that a trailing
  // slash is preserved.
  const out = segs.filter(s => s !== '.');
  let result = out.join('/');
  if (!result.startsWith('/')) result = '/' + result;
  return result;
}

// Matches a domain pattern against a host. Exact equality, or a wildcard
// `*.example.com` that matches every subdomain host (but NOT bare `example.com`).
// Deliberately strict: split on dots and compare segment by segment, so
// substring tricks (`evilexample.com`, `a.b.example.com.attacker.com`) fail.
export function matchDomain(pattern: string, host: string): boolean {
  if (!pattern || !host) return false;
  const p = pattern.toLowerCase();
  const h = host.toLowerCase();
  if (p === h) return true;
  if (!p.startsWith('*.')) return false;

  const suffix = p.slice(2).split('.'); // segments after the "*."
  const hostSegs = h.split('.');
  // A wildcard requires at least one subdomain segment before the suffix.
  if (hostSegs.length <= suffix.length) return false;
  const hostSuffix = hostSegs.slice(hostSegs.length - suffix.length);
  return suffix.every((seg, i) => seg === hostSuffix[i]);
}

// Wildcard matching is done with a LINEAR two-pointer scan instead of a RegExp.
// Reason (security, ReDoS): a `*` pattern that goes into `new RegExp` could
// backtrack catastrophically with multiple wildcards. Even if we escape all
// regex metacharacters in the literal parts, a pattern like `/a*a*a*…X` still
// yields the regex `^/a[^/]*a[^/]*a…X$` — multiple adjacent unbounded
// quantifiers that, on a long segment (attacker-controlled request path), blow
// up in polynomial/exponential time and hang the event loop. The glob algorithm
// below is O(n·m) and has no backtracking explosion.

// A token in a compiled pattern: a literal character (string), or a wildcard.
// MID matches a run of characters WITHIN one segment (never crosses `/`); CROSS
// matches everything incl. `/` (for the trailing-prefix semantics).
const MID_STAR = 0;
const CROSS_STAR = 1;
type Token = string | typeof MID_STAR | typeof CROSS_STAR;

function tokenizeMid(literal: string): Token[] {
  const out: Token[] = [];
  for (const ch of literal) out.push(ch === '*' ? MID_STAR : ch);
  return out;
}

// Classic greedy glob match with a single remembered wildcard position → O(n·m),
// no exponential backtracking. A MID_STAR may not eat `/`; a CROSS_STAR may.
function matchTokens(tokens: Token[], str: string): boolean {
  let ti = 0;
  let si = 0;
  let starTi = -1;
  let starCross = false;
  let mark = 0;
  const n = tokens.length;
  const m = str.length;
  while (si < m) {
    if (ti < n && typeof tokens[ti] === 'string' && tokens[ti] === str[si]) {
      ti++;
      si++;
    } else if (ti < n && typeof tokens[ti] !== 'string') {
      starTi = ti;
      starCross = tokens[ti] === CROSS_STAR;
      mark = si;
      ti++;
    } else if (starTi !== -1) {
      // Stretch the last-seen wildcard by one character. A MID_STAR stops at `/`.
      if (!starCross && str[mark] === '/') return false;
      ti = starTi + 1;
      mark++;
      si = mark;
    } else {
      return false;
    }
  }
  while (ti < n && typeof tokens[ti] !== 'string') ti++;
  return ti === n;
}

// Matches a path pattern with `*` wildcards against a path. Semantics:
//   • Every `*` in the MIDDLE of the pattern matches within one segment (does
//     not cross `/`) — exactly what the Azure DevOps case needs
//     (`/_packaging/<random>/…`).
//   • A `*` at the END may cross segment boundaries (prefix match), so `/foo/*`
//     also matches `/foo/a/b`. If there is NO `/` right before that trailing
//     `*`, the rest must be empty or start on a segment boundary (`/safe*`
//     matches `/safe` and `/safe/x`, but NOT `/safe-danger`).
// Consecutive `*` are collapsed into one (`**` ≡ `*`); that is deliberate
// (avoids adjacent wildcards) and semantically insignificant.
function matchWildcardPath(rawPattern: string, path: string): boolean {
  const pattern = rawPattern.replace(/\*+/g, '*');
  if (pattern.endsWith('*')) {
    const core = pattern.slice(0, -1); // pattern without the trailing `*`
    const crossSegment = core === '' || core.endsWith('/');
    if (crossSegment) {
      return matchTokens([...tokenizeMid(core), CROSS_STAR], path);
    }
    // Trailing `*` not on a boundary: rest empty (exact core) OR `/` + anything.
    if (matchTokens(tokenizeMid(core), path)) return true;
    return matchTokens([...tokenizeMid(core), '/', CROSS_STAR], path);
  }
  return matchTokens(tokenizeMid(pattern), path);
}

// Matches a path pattern against a path. A null/empty pattern is a host-only
// rule and matches every path. A pattern may contain `*` wildcards (see
// matchWildcardPath: middle = within one segment, end = prefix match that may
// cross segments). Without `*`, exact equality applies.
//
// The path is normalized first (drop query, one decode, `..` fail-closed) so
// that traversal tricks (`/foo/../secret`, `/foo/..%2fsecret`) do not slip
// through a `/foo/*` allow (finding #7). A path that does not normalize safely
// never matches.
export function matchPath(pattern: string | null, path: string | null): boolean {
  if (pattern === null || pattern === '') return true;
  const reqPath = normalizePathname(path);
  if (reqPath === null) return false; // traversal / broken encoding → fail closed
  if (!pattern.includes('*')) return reqPath === pattern;
  return matchWildcardPath(pattern, reqPath);
}

// Groups a path by its first segment into a prefix pattern, e.g.
// `/api/v1/users?x=1` → `/api/*`. This is the pattern under which an unknown
// subpath of a path-allowlist domain is filed as 'requested'; the operator can
// refine it later into something more specific (`/api/v1/*` or exact `/api/v1/x`).
export function firstSegmentPattern(path: string): string {
  const clean = path.split('?')[0].split('#')[0];
  const segs = clean.split('/').filter(Boolean);
  if (segs.length === 0) return '/*';
  return `/${segs[0]}/*`;
}

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

type Candidate = RuleRow & { domain_is_wildcard: boolean };

// Specificity of a candidate rule. Higher = more specific = wins. Order:
// per-container > global; exact host > wildcard host; with path > without path.
function specificity(c: Candidate): number {
  let score = 0;
  if (c.container_id !== null) score += 4;
  if (!c.domain_is_wildcard) score += 2;
  if (c.path_pattern !== null && c.path_pattern !== '') score += 1;
  return score;
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
  const {
    selectPerContainer, selectGlobal, selectWildcardPerContainer, selectWildcardGlobal,
    touchRule, setLastPath, insertRequested, insertRequestedPath, resetExpired,
  } = s();

  // Collect all candidate rules: exact-host (per-container + global) and
  // wildcard-host (per-container + global). Then filter in TypeScript.
  const candidates: Candidate[] = [];

  const addExact = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchPath(r.path_pattern, path)) candidates.push({ ...r, domain_is_wildcard: false });
    }
  };
  const addWildcard = (rows: RuleRow[]) => {
    for (const r of rows) {
      if (matchDomain(r.domain, domain) && matchPath(r.path_pattern, path)) {
        candidates.push({ ...r, domain_is_wildcard: true });
      }
    }
  };

  // Airlock: an isolated container gets NO global-rule fallback. Only its own
  // allow rules count; all other traffic is filed as requested (see the no-match
  // branch at the bottom). The global lookup is skipped.
  const airlocked = containerId ? getAirlocked(containerId) : false;

  if (containerId) {
    addExact(selectPerContainer.all(domain, containerId) as RuleRow[]);
    addWildcard(selectWildcardPerContainer.all(containerId) as RuleRow[]);
  }
  if (!airlocked) {
    addExact(selectGlobal.all(domain) as RuleRow[]);
    addWildcard(selectWildcardGlobal.all() as RuleRow[]);
  }

  if (candidates.length > 0) {
    // Pick the winning rule. A concrete decision (allow/deny) always outranks an
    // unresolved 'requested' placeholder, regardless of host-specificity —
    // otherwise a stale exact-host 'requested' row (auto-created on an earlier
    // block) would shadow a matching wildcard allow and keep the host blocked
    // even after the operator added a covering rule (finding #7). Among concrete
    // rules the most specific wins, and on equal specificity deny beats allow
    // (fail-closed).
    candidates.sort((a, b) => {
      const concrete = (st: RuleStatus) => (st === 'requested' ? 0 : 1);
      const c = concrete(b.status) - concrete(a.status);
      if (c !== 0) return c;
      const d = specificity(b) - specificity(a);
      if (d !== 0) return d;
      const rank = (st: RuleStatus) => (st === 'deny' ? 0 : st === 'allow' ? 1 : 2);
      return rank(a.status) - rank(b.status);
    });
    const best = candidates[0];

    // Path-allowlist mode: a host-only marker rule exists (path_mode=1). If only
    // that marker matched (no more specific path rule), this subpath is still
    // unknown: file it — grouped by the first path segment — as 'requested' so
    // the operator can review it, instead of silently rejecting it. A path rule
    // that does match (allow/deny/requested) is simply honored below.
    const inPathMode = candidates.some(c => c.path_pattern === null && c.path_mode === 1);
    if (inPathMode && path !== null) {
      const hostOnlyBest = best.path_pattern === null || best.path_pattern === '';
      if (hostOnlyBest) {
        // Only the host-only marker matched → unknown subpath: group by the
        // first segment and file it as requested. Keep the full path as a
        // concrete example for the operator.
        const grp = firstSegmentPattern(path);
        const containerForRule = best.container_id;
        const inserted = insertRequestedPath.run(domain, containerForRule, grp);
        if (inserted.changes > 0) notifyStateChanged();
        const created = (containerForRule
          ? (selectPerContainer.all(domain, containerForRule) as RuleRow[])
          : (selectGlobal.all(domain) as RuleRow[])).find(r => r.path_pattern === grp);
        if (created) { setLastPath.run(path, created.id); touchRule.run(created.id); }
        return { status: 'requested', ruleId: created?.id ?? null };
      }
      if (best.status === 'requested') {
        // Existing requested group hit again → refresh the example path.
        setLastPath.run(path, best.id);
        touchRule.run(best.id);
        return { status: 'requested', ruleId: best.id };
      }
      // Otherwise an explicit allow/deny path rule won → normal handling.
    }

    if (best.status === 'allow' && best.expires_at !== null && best.expires_at < Math.floor(Date.now() / 1000)) {
      resetExpired.run(best.id);
      return { status: 'requested', ruleId: null };
    }
    touchRule.run(best.id);
    return { status: best.status, ruleId: best.id };
  }

  // No match → create a host-only requested rule so the operator sees it in the
  // UI. (The path is not recorded: the operator chooses the scope themselves.)
  const inserted = insertRequested.run(domain, containerId);
  if (inserted.changes > 0) notifyStateChanged();
  const created = (containerId
    ? (selectPerContainer.all(domain, containerId) as RuleRow[]).find(r => r.path_pattern === null)
    : (selectGlobal.all(domain) as RuleRow[]).find(r => r.path_pattern === null)) as RuleRow | undefined;
  if (created) {
    touchRule.run(created.id);
  }

  return { status: 'requested', ruleId: created?.id ?? null };
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
