import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import {
  matchDomain,
  matchPath,
  firstSegmentPattern,
  canonicalizeHost,
  normalizePathname,
} from '../src/rule-match';

// ── Boundary A — the per-domain firewall, end to end ────────────────────────
//
// `checkRule` used to be one function over SQL. After the Node/Gateway split it
// is a pipeline across two processes (docs/ADR-huddle-node-split.md):
//
//   buildPolicyFeed   Huddle Node serves the rules
//   indexPolicy       the gateway holds them
//   decideRequest     the gateway decides, locally and synchronously
//   applyReport       Node writes down what that implied
//
// This suite drives the WHOLE of that, with the network stage removed
// (test/helpers/local-plane.ts) — so it still asserts exactly what it always
// asserted: given these rows, this answer, and these rows afterwards. What
// changed is that the two halves have to agree for it to pass, which is the
// property most worth pinning.
//
// The pure matchers moved to src/rule-match.ts and need no database at all, so
// their tests sit at the bottom of this file, outside the round-trip half.
//
// db.ts and the plane helper are pulled in from beforeAll rather than the top
// of the file, so the database is opened as part of setting the suite up.
let db: typeof import('../src/db').db;
let setAirlocked: typeof import('../src/db').setAirlocked;
let ensurePathModeMarker: typeof import('../src/rules').ensurePathModeMarker;
let control: import('./helpers/local-plane').LocalPlane;

const CID = 'container-abc';

function setRule(
  domain: string,
  containerId: string | null,
  status: string,
  expiresAt: number | null = null,
  pathPattern: string | null = null,
  pathMode = 0,
) {
  db.prepare(
    `INSERT INTO rules (domain, container_id, status, expires_at, path_pattern, path_mode) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(domain, containerId, status, expiresAt, pathPattern, pathMode);
}

/**
 * One full round trip, in the place the old `checkRule(...)` call stood.
 *
 * refresh() is the gateway picking up the policy it is served; flush() is Node
 * applying what the decision implied. Both are explicit because both are
 * asynchronous in production — a rule added a millisecond ago is genuinely not
 * yet enforced, and a `requested` row genuinely appears a moment after the
 * request it came from was already refused.
 */
async function checkRule(domain: string, containerId: string | null, path: string | null = null) {
  await control.refresh();
  const decision = control.plane.checkRule(domain, containerId, path);
  await control.flush();
  return decision;
}

async function isPathMode(domain: string, containerId: string | null): Promise<boolean> {
  await control.refresh();
  return control.plane.isPathMode(domain, containerId);
}

describe('checkRule — policy feed → decision → writes', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    setAirlocked = dbMod.setAirlocked;
    dbMod.initDb();
    ensurePathModeMarker = (await import('../src/rules')).ensurePathModeMarker;
    const { createLocalPlane } = await import('./helpers/local-plane');
    control = await createLocalPlane();
  });
  beforeEach(() => { db.exec('DELETE FROM rules'); db.exec('DELETE FROM containers'); });

  describe('finding #7: a concrete rule outranks a stale requested placeholder', () => {
    it('a matching wildcard allow wins over an exact-host requested row', async () => {
      // Host blocked earlier -> exact-host 'requested' row auto-created; operator
      // then adds a covering wildcard allow. The allow must win (not stay blocked).
      setRule('sub.example.com', null, 'requested');
      setRule('*.example.com', null, 'allow');
      expect((await checkRule('sub.example.com', null)).status).toBe('allow');
    });

    it('a matching wildcard deny also wins over an exact-host requested row', async () => {
      setRule('sub.example.com', null, 'requested');
      setRule('*.example.com', null, 'deny');
      expect((await checkRule('sub.example.com', null)).status).toBe('deny');
    });
  });

  describe('finding #6a: a path-scoped rule establishes path mode', () => {
    it('ensurePathModeMarker admits the CONNECT and makes the path rule fire', async () => {
      // `firewall add example.com --path /get*`: a path allow with no marker.
      setRule('example.com', null, 'allow', null, '/get*', 0);
      expect(await isPathMode('example.com', null)).toBe(false); // inert without the marker
      ensurePathModeMarker('example.com', null);
      expect(await isPathMode('example.com', null)).toBe(true);  // path-mode -> CONNECT admitted
      expect((await checkRule('example.com', null, '/get')).status).toBe('allow');
      expect((await checkRule('example.com', null, '/other')).status).not.toBe('allow');
    });
  });

  describe('per-container rules', () => {
    it('allow for an allowed domain', async () => {
      setRule('example.com', CID, 'allow');
      expect((await checkRule('example.com', CID)).status).toBe('allow');
    });

    it('deny for a blocked domain', async () => {
      setRule('evil.test', CID, 'deny');
      expect((await checkRule('evil.test', CID)).status).toBe('deny');
    });

    it('unknown domain is automatically created as "requested"', async () => {
      const r = await checkRule('new-domain.test', CID);
      expect(r.status).toBe('requested');
      // The gateway could not know the id — Node minted it when it applied the
      // create-requested effect, and that is the row the portal shows.
      const row = db.prepare(`SELECT status FROM rules WHERE domain=? AND container_id=?`).get('new-domain.test', CID) as any;
      expect(row?.status).toBe('requested');
    });

    it('per-container rule takes precedence over a global rule', async () => {
      setRule('split.test', null, 'deny');   // globally blocked
      setRule('split.test', CID, 'allow');    // but allowed for this container
      expect((await checkRule('split.test', CID)).status).toBe('allow');
    });
  });

  describe('global rules', () => {
    it('global allow applies when there is no per-container rule', async () => {
      setRule('global.test', null, 'allow');
      expect((await checkRule('global.test', CID)).status).toBe('allow');
    });

    it('global rules also apply without a containerId', async () => {
      setRule('global.test', null, 'deny');
      expect((await checkRule('global.test', null)).status).toBe('deny');
    });
  });

  describe('airlock', () => {
    it('airlocked container ignores a global allow rule', async () => {
      setRule('global.test', null, 'allow');
      setAirlocked(CID, true);
      // No per-container rule + global lookup skipped → requested.
      expect((await checkRule('global.test', CID)).status).toBe('requested');
    });

    it('without airlock the same global allow rule does apply', async () => {
      setRule('global.test', null, 'allow');
      expect((await checkRule('global.test', CID)).status).toBe('allow');
    });

    it('airlocked container still honors its own allow rule', async () => {
      setRule('own.test', CID, 'allow');
      setAirlocked(CID, true);
      expect((await checkRule('own.test', CID)).status).toBe('allow');
    });

    it('disabling airlock restores the global fallback', async () => {
      setRule('global.test', null, 'allow');
      setAirlocked(CID, true);
      expect((await checkRule('global.test', CID)).status).toBe('requested');
      setAirlocked(CID, false);
      db.exec('DELETE FROM rules');
      setRule('global.test', null, 'allow');
      expect((await checkRule('global.test', CID)).status).toBe('allow');
    });
  });

  describe('temp-allow expiry', () => {
    it('an expired temp-allow falls back to "requested"', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const past = Math.floor(Date.now() / 1000) - 60; // expired 1 min ago
      setRule('temp.test', CID, 'allow', past);
      expect((await checkRule('temp.test', CID)).status).toBe('requested');
      // The reset-expired effect is Node's to apply — the gateway only says so.
      const row = db.prepare(`SELECT status FROM rules WHERE domain=? AND container_id=?`).get('temp.test', CID) as any;
      expect(row?.status).toBe('requested');
      vi.useRealTimers();
    });

    it('a still-valid temp-allow stays "allow"', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-01T12:00:00Z'));
      const future = Math.floor(Date.now() / 1000) + 600; // still valid for 10 min
      setRule('temp2.test', CID, 'allow', future);
      expect((await checkRule('temp2.test', CID)).status).toBe('allow');
      vi.useRealTimers();
    });
  });

  describe('path-based rules', () => {
    it('path rule allow matches only the allowed path', async () => {
      setRule('github.com', CID, 'allow', null, '/anthropics/*');
      expect((await checkRule('github.com', CID, '/anthropics/x')).status).toBe('allow');
      // No other rule → unknown path becomes "requested"
      expect((await checkRule('github.com', CID, '/other')).status).toBe('requested');
    });

    it('path rule wins over host-only rule', async () => {
      setRule('github.com', CID, 'deny');                       // host-only deny
      setRule('github.com', CID, 'allow', null, '/anthropics/*'); // more specific
      expect((await checkRule('github.com', CID, '/anthropics/x')).status).toBe('allow');
      expect((await checkRule('github.com', CID, '/elsewhere')).status).toBe('deny');
    });

    it('per-container path rule wins over global host rule', async () => {
      setRule('github.com', null, 'deny');                      // global host-only
      setRule('github.com', CID, 'allow', null, '/org/*');      // per-container + path
      expect((await checkRule('github.com', CID, '/org/x')).status).toBe('allow');
    });

    it('wildcard domain allow matches subdomain', async () => {
      setRule('*.npmjs.org', null, 'allow');
      expect((await checkRule('registry.npmjs.org', CID)).status).toBe('allow');
      expect((await checkRule('npmjs.org', CID)).status).toBe('requested');
    });

    it('deny wins over allow on equal specificity (fail-closed)', async () => {
      // Two different wildcard domains that both match the same host:
      // equal specificity (global, wildcard, no path), distinct identity.
      setRule('*.npmjs.org', null, 'allow');
      setRule('*.org', null, 'deny');
      expect((await checkRule('registry.npmjs.org', CID)).status).toBe('deny');
    });
  });

  describe('path-allowlist mode (path_mode)', () => {
    it('host-only marker blocks the bare domain, but files subpaths as requested', async () => {
      setRule('github.com', CID, 'deny', null, null, 1); // marker

      // Unknown subpath → requested, and a grouped path rule is created.
      expect((await checkRule('github.com', CID, '/anthropics/claude')).status).toBe('requested');
      const row = db.prepare(
        `SELECT status, path_pattern, last_path FROM rules WHERE domain=? AND container_id=? AND path_pattern=?`
      ).get('github.com', CID, '/anthropics/*') as any;
      expect(row?.status).toBe('requested');
      // The full path is kept as an example and refreshed on a new hit.
      expect(row?.last_path).toBe('/anthropics/claude');
      await checkRule('github.com', CID, '/anthropics/codex?x=1');
      const row2 = db.prepare(
        `SELECT last_path FROM rules WHERE domain=? AND container_id=? AND path_pattern=?`
      ).get('github.com', CID, '/anthropics/*') as any;
      expect(row2?.last_path).toBe('/anthropics/codex?x=1');

      // The bare domain (no path / null) stays closed.
      expect((await checkRule('github.com', CID, null)).status).toBe('deny');
    });

    it('an allowed subpath wins over the host-only marker', async () => {
      setRule('github.com', CID, 'deny', null, null, 1);          // marker
      setRule('github.com', CID, 'allow', null, '/anthropics/*');  // allowed path
      expect((await checkRule('github.com', CID, '/anthropics/claude')).status).toBe('allow');
      // A different path stays unknown → requested
      expect((await checkRule('github.com', CID, '/torvalds/linux')).status).toBe('requested');
    });

    it('a rejected subpath stays deny (no re-filing as requested)', async () => {
      setRule('github.com', CID, 'deny', null, null, 1);        // marker
      setRule('github.com', CID, 'deny', null, '/secret/*');     // explicitly blocked path
      expect((await checkRule('github.com', CID, '/secret/x')).status).toBe('deny');
    });

    it('isPathMode recognizes a domain in path mode', async () => {
      setRule('github.com', null, 'deny', null, null, 1);
      expect(await isPathMode('github.com', CID)).toBe(true);
      expect(await isPathMode('elsewhere.test', CID)).toBe(false);
    });
  });

  describe('regression: path argument does not change host-only behavior', () => {
    it('explicit null path gives the same result as without an argument', async () => {
      setRule('regress.test', CID, 'allow');
      expect((await checkRule('regress.test', CID)).status).toBe('allow');
      expect((await checkRule('regress.test', CID, null)).status).toBe('allow');
    });
    it('host-only allow matches regardless of the path', async () => {
      setRule('hostonly.test', CID, 'allow');
      expect((await checkRule('hostonly.test', CID, '/any/path')).status).toBe('allow');
    });
  });

  // ── Finding #3 — uppercase bypass of exact deny rules ──────────────────────
  // The classic broad-allow/specific-deny form: `*.github.com` allow +
  // `gist.github.com` deny. A capitalized host must NOT bypass the deny (this
  // was a reliable firewall bypass via CONNECT GIST.GITHUB.COM).
  describe('regression #3: casing does not bypass an exact deny', () => {
    it('exact deny wins over wildcard allow, regardless of the host casing', async () => {
      setRule('*.github.com', null, 'allow');
      setRule('gist.github.com', null, 'deny');
      expect((await checkRule('gist.github.com', CID)).status).toBe('deny');
      // Same host, capitalized. The SQL COLLATE NOCASE this used to rely on is
      // gone: decideRequest lowercases the host and indexPolicy lowercases the
      // rows, so the case-folding is now the index's job on both sides.
      expect((await checkRule('GIST.GITHUB.COM', CID)).status).toBe('deny');
      expect((await checkRule('Gist.GitHub.Com', CID)).status).toBe('deny');
    });
    it('a deny rule that is itself stored capitalized also matches', async () => {
      // Simulate an old, non-migrated row (mixed case).
      db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES ('EVIL.TEST', NULL, 'deny')`).run();
      expect((await checkRule('evil.test', CID)).status).toBe('deny');
    });
  });

  // ── Finding #7 — path traversal through a path allowlist ───────────────────
  describe('regression #7: path normalization blocks traversal', () => {
    it('`/foo/../secret` no longer matches a `/foo/*` allow', async () => {
      setRule('example.com', CID, 'deny', null, null, 1);          // path-mode marker
      setRule('example.com', CID, 'allow', null, '/foo/*');        // only /foo/* allowed
      expect((await checkRule('example.com', CID, '/foo/bar')).status).toBe('allow');
      // Traversal → normalizes away from /foo/ → no longer 'allow'.
      expect((await checkRule('example.com', CID, '/foo/../secret')).status).not.toBe('allow');
      expect((await checkRule('example.com', CID, '/foo/..%2f..%2fadmin')).status).not.toBe('allow');
      expect((await checkRule('example.com', CID, '/foo/../')).status).not.toBe('allow');
    });
  });
});

// ── The pure matchers ───────────────────────────────────────────────────────
//
// src/rule-match.ts imports nothing — no database, no config, no clock. These
// run in every environment, which matters, because they are the part an
// attacker probes.

describe('matchDomain (pure helper)', () => {
  it('matches exact host', () => {
    expect(matchDomain('npmjs.org', 'npmjs.org')).toBe(true);
    expect(matchDomain('npmjs.org', 'other.org')).toBe(false);
  });
  it('wildcard matches subdomain', () => {
    expect(matchDomain('*.npmjs.org', 'registry.npmjs.org')).toBe(true);
    expect(matchDomain('*.npmjs.org', 'dist.npmjs.org')).toBe(true);
  });
  it('wildcard does NOT match the bare host', () => {
    expect(matchDomain('*.npmjs.org', 'npmjs.org')).toBe(false);
  });
  it('wildcard does not slip through via substring tricks', () => {
    expect(matchDomain('*.npmjs.org', 'evilnpmjs.org')).toBe(false);
    expect(matchDomain('*.npmjs.org', 'a.b.npmjs.org.attacker.com')).toBe(false);
  });
  it('is case-insensitive', () => {
    expect(matchDomain('*.NPMJS.org', 'Registry.npmjs.ORG')).toBe(true);
  });
  it('hand-written Azure DevOps wildcard domain matches the feed hosts', () => {
    expect(matchDomain('*.pkgs.dev.azure.com', 'myorg.pkgs.dev.azure.com')).toBe(true);
    expect(matchDomain('*.pkgs.dev.azure.com', 'other.pkgs.dev.azure.com')).toBe(true);
    // Bare host without a subdomain does not match.
    expect(matchDomain('*.pkgs.dev.azure.com', 'pkgs.dev.azure.com')).toBe(false);
    // No substring trick to an attacker domain.
    expect(matchDomain('*.pkgs.dev.azure.com', 'myorg.pkgs.dev.azure.com.evil.test')).toBe(false);
  });
});

describe('matchPath (pure helper)', () => {
  it('null/empty pattern matches every path', () => {
    expect(matchPath(null, '/anything')).toBe(true);
    expect(matchPath('', '/anything')).toBe(true);
    expect(matchPath(null, null)).toBe(true);
  });
  it('prefix match with trailing *', () => {
    expect(matchPath('/api/v1/*', '/api/v1/foo')).toBe(true);
    expect(matchPath('/api/v1/*', '/api/v1/')).toBe(true);
    expect(matchPath('/api/v1/*', '/api/v2/x')).toBe(false);
  });
  it('exact match without wildcard', () => {
    expect(matchPath('/exact', '/exact')).toBe(true);
    expect(matchPath('/exact', '/exact/more')).toBe(false);
  });
  it('wildcard in the middle of the path matches within one segment', () => {
    expect(matchPath('/foo/*/bar', '/foo/xyz/bar')).toBe(true);
    expect(matchPath('/foo/*/bar', '/foo/123/bar')).toBe(true);
    // `*` does not cross `/`: an extra segment is not allowed.
    expect(matchPath('/foo/*/bar', '/foo/a/b/bar')).toBe(false);
    // The literal parts must match.
    expect(matchPath('/foo/*/bar', '/foo/x/baz')).toBe(false);
  });
  it('multiple wildcards in one pattern', () => {
    expect(matchPath('/a/*/b/*/c', '/a/1/b/2/c')).toBe(true);
    expect(matchPath('/a/*/b/*/c', '/a/1/b/2/3/c')).toBe(false);
  });
  it('wildcard within a segment (not on a boundary)', () => {
    expect(matchPath('/pkg-*.nupkg', '/pkg-abc.nupkg')).toBe(true);
    expect(matchPath('/pkg-*.nupkg', '/pkg-a/b.nupkg')).toBe(false);
  });
  it('Azure DevOps NuGet feed: random segment in the middle', () => {
    // The feed GUID changes per request, the rest of the endpoint is stable.
    const pat = '/_packaging/*/nuget/v3/*';
    expect(matchPath(pat, '/_packaging/1a2b3c/nuget/v3/index.json')).toBe(true);
    // Trailing `*` may cross deeper segments (flat2/registrations2/…).
    expect(matchPath(pat, '/_packaging/1a2b3c/nuget/v3/flat2/newtonsoft.json/index.json')).toBe(true);
    // The random GUID segment itself may not contain a `/`.
    expect(matchPath(pat, '/_packaging/a/b/nuget/v3/index.json')).toBe(false);
    // A different endpoint falls outside the pattern.
    expect(matchPath(pat, '/_packaging/1a2b3c/npm/registry')).toBe(false);
  });
  it('mid-wildcard still leaves traversal fail-closed', () => {
    // Normalization runs before the match: `..` → null → never a match.
    expect(matchPath('/foo/*/bar', '/foo/../bar')).toBe(false);
    expect(matchPath('/_packaging/*/nuget/v3/*', '/_packaging/x/..%2f..%2fadmin')).toBe(false);
  });
  it('regex metacharacters in the pattern are literal', () => {
    // The `.` must not become "any character".
    expect(matchPath('/v3/index.json', '/v3/indexXjson')).toBe(false);
    expect(matchPath('/a.b/*', '/aXb/c')).toBe(false);
    expect(matchPath('/a.b/*', '/a.b/c')).toBe(true);
  });
  it('ReDoS-hard: many wildcards on a long segment stay fast (no backtracking explosion)', () => {
    // A pattern with many wildcards + a long, attacker-controlled segment
    // that does NOT match made the old RegExp approach (`[^/]*a[^/]*a…X$`)
    // backtrack catastrophically and hung the event loop. The linear matcher
    // is O(n·m): this must fail well within a few milliseconds.
    const evil = '/' + 'a*'.repeat(50) + 'X';
    const longSegment = '/' + 'a'.repeat(5000); // one segment, no `/`, no `X`
    const t0 = performance.now();
    const result = matchPath(evil, longSegment);
    const elapsed = performance.now() - t0;
    expect(result).toBe(false);
    expect(elapsed).toBeLessThan(100);
  });
  it('consecutive `*` are collapsed (`**` ≡ `*`)', () => {
    // `**` is one wildcard: the same segment-boundary semantics as a single `*`.
    expect(matchPath('/safe**', '/safe')).toBe(true);
    expect(matchPath('/safe**', '/safe/x')).toBe(true);
    expect(matchPath('/safe**', '/safe-danger')).toBe(false);
  });
});

describe('firstSegmentPattern (pure helper)', () => {
  it('groups by the first path segment', () => {
    expect(firstSegmentPattern('/api/v1/users')).toBe('/api/*');
    expect(firstSegmentPattern('/api')).toBe('/api/*');
  });
  it('ignores query and fragment parts', () => {
    expect(firstSegmentPattern('/api/v1?x=1')).toBe('/api/*');
    expect(firstSegmentPattern('/repos/foo#frag')).toBe('/repos/*');
  });
  it('root path becomes /*', () => {
    expect(firstSegmentPattern('/')).toBe('/*');
    expect(firstSegmentPattern('')).toBe('/*');
  });
});

describe('canonicalizeHost (pure helper)', () => {
  it('lowercase + strip trailing dot', () => {
    expect(canonicalizeHost('GIST.GITHUB.COM')).toBe('gist.github.com');
    expect(canonicalizeHost('example.com.')).toBe('example.com');
    expect(canonicalizeHost('Example.COM.')).toBe('example.com');
  });
  it('IDN → punycode (the form DNS/SNI see)', () => {
    // bücher.example → xn--bcher-kva.example
    expect(canonicalizeHost('bücher.example')).toBe('xn--bcher-kva.example');
  });
  it('rejects control chars, whitespace and empty host', () => {
    expect(canonicalizeHost('')).toBeNull();
    expect(canonicalizeHost('  ')).toBeNull();
    expect(canonicalizeHost('evil.com\r\nHost: x')).toBeNull();
    expect(canonicalizeHost('a b.com')).toBeNull();
  });
  it('is idempotent on an already-canonical host', () => {
    expect(canonicalizeHost('gist.github.com')).toBe('gist.github.com');
  });
});

describe('normalizePathname (pure helper)', () => {
  it('leaves a normal path untouched (incl. trailing slash)', () => {
    expect(normalizePathname('/api/v1/foo')).toBe('/api/v1/foo');
    expect(normalizePathname('/api/v1/')).toBe('/api/v1/');
    expect(normalizePathname('/')).toBe('/');
  });
  it('strips query and fragment', () => {
    expect(normalizePathname('/foo?x=1')).toBe('/foo');
    expect(normalizePathname('/foo#frag')).toBe('/foo');
  });
  it('folds `.` segments away', () => {
    expect(normalizePathname('/foo/./bar')).toBe('/foo/bar');
  });
  it('fail-closed on `..` traversal (plain, %-encoded, double-slash)', () => {
    expect(normalizePathname('/foo/../secret')).toBeNull();
    expect(normalizePathname('/foo/..%2f..%2fadmin')).toBeNull();
    expect(normalizePathname('/foo/../')).toBeNull();
    expect(normalizePathname('/..')).toBeNull();
  });
  it('fail-closed on broken percent-encoding', () => {
    expect(normalizePathname('/foo/%zz')).toBeNull();
    expect(normalizePathname('/foo/%2')).toBeNull();
  });
  it('treats double-encoded `..` as a literal segment (single decode)', () => {
    // %252e%252e → one decode → %2e%2e (no `..` segment) → no traversal.
    expect(normalizePathname('/foo/%252e%252e/x')).toBe('/foo/%2e%2e/x');
  });
  it('preserves legitimate %-encoded characters (no mangling of the decision)', () => {
    // %2e%2e = `..` → traversal → fail closed.
    expect(normalizePathname('/foo/%2e%2e/x')).toBeNull();
    // a plain encoded character (space) in a segment stays a valid path.
    expect(normalizePathname('/a%20b/c')).toBe('/a b/c');
  });
});

describe('matchPath: segment boundary (regression #7 tail)', () => {
  it('`*` suffix matches only on a segment boundary', () => {
    expect(matchPath('/safe*', '/safe')).toBe(true);
    expect(matchPath('/safe*', '/safe/x')).toBe(true);
    expect(matchPath('/safe*', '/safe-danger')).toBe(false);
  });
  it('`/foo/*` matches subpaths but not after traversal', () => {
    expect(matchPath('/foo/*', '/foo/bar')).toBe(true);
    expect(matchPath('/foo/*', '/foo/../secret')).toBe(false);
    expect(matchPath('/foo/*', '/foo/..%2fsecret')).toBe(false);
  });
  it('null/empty pattern (host-only) matches every path, including traversal', () => {
    // Host-only rules do not enforce a path; traversal protection lives in the
    // path rules themselves.
    expect(matchPath(null, '/foo/../secret')).toBe(true);
    expect(matchPath('', '/whatever')).toBe(true);
  });
});
