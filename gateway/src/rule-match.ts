// The vocabulary of a firewall rule, plus the pure matching that decides whether
// a rule applies to a request. No imports at all — not the database, not the
// event bus, not the clock.
//
// This is deliberate. Everything here is a total function of its arguments, so a
// decision made from these primitives is reproducible: the same rule set and the
// same request always yield the same match, whether that happens inside the
// gateway container or in a Huddle Node process on the host (see
// docs/ADR-huddle-node-split.md). Anything that reads or writes state lives in
// ./rules; anything that picks a winner lives in ./control/decide.
//
// Extracted verbatim from rules.ts, which re-exports all of it so existing
// callers and tests are unaffected.

export type RuleStatus = 'allow' | 'deny' | 'requested';

export interface RuleRow {
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
