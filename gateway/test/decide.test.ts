import { describe, it, expect } from 'vitest';
import { decide, type PolicySnapshot } from '../src/control/decide';
import type { RuleRow } from '../src/rule-match';

// ── The firewall decision, without a database ───────────────────────────────
//
// decide() is a total function of (snapshot, domain, path, now), so unlike the
// rules.test.ts suite next door this one needs no SQLite binding and runs
// everywhere — including a DMZ devcontainer where better-sqlite3 can't build.
// That is much of the point of having pulled the decision out of checkRule: the
// branch that decides whether traffic leaves the machine is now checkable
// without standing up the storage it used to be tangled with.
//
// These tests assert the DECISION and the EFFECTS it implies. Whether those
// effects are then written correctly is rules.test.ts's job.

const NOW = 1_700_000_000;

function row(over: Partial<RuleRow> & { id: number }): RuleRow {
  return {
    domain: 'example.com',
    status: 'allow',
    expires_at: null,
    container_id: null,
    path_pattern: null,
    path_mode: 0,
    ...over,
  };
}

function snapshot(over: Partial<PolicySnapshot> = {}): PolicySnapshot {
  return {
    perContainerExact: [],
    perContainerWildcard: [],
    globalExact: [],
    globalWildcard: [],
    containerId: null,
    ...over,
  };
}

describe('decide — no matching rule', () => {
  it('blocks and files the host so the operator sees it', () => {
    const d = decide(snapshot({ containerId: 'dc1' }), 'evil.test', null, NOW);
    expect(d.status).toBe('requested');
    // No rule exists yet, so there is no id to report — applying the effect mints it.
    expect(d.ruleId).toBeNull();
    expect(d.effects).toEqual([
      { kind: 'create-requested', domain: 'evil.test', containerId: 'dc1', pathPattern: null, lastPath: null },
    ]);
  });

  it('does not record the request path — the operator picks the scope', () => {
    const d = decide(snapshot(), 'evil.test', '/deep/path', NOW);
    expect(d.effects[0]).toMatchObject({ kind: 'create-requested', pathPattern: null, lastPath: null });
  });
});

describe('decide — picking a winner', () => {
  it('allows on an exact global rule and touches it', () => {
    const d = decide(snapshot({ globalExact: [row({ id: 7 })] }), 'example.com', null, NOW);
    expect(d).toEqual({ status: 'allow', ruleId: 7, effects: [{ kind: 'touch', ruleId: 7 }] });
  });

  it('matches a wildcard rule against a subdomain', () => {
    const s = snapshot({ globalWildcard: [row({ id: 3, domain: '*.example.com' })] });
    expect(decide(s, 'api.example.com', null, NOW).status).toBe('allow');
  });

  it('ignores a wildcard rule that does not cover the host', () => {
    const s = snapshot({ globalWildcard: [row({ id: 3, domain: '*.other.test' })] });
    expect(decide(s, 'api.example.com', null, NOW).status).toBe('requested');
  });

  it('prefers a per-container rule over a global one', () => {
    const d = decide(snapshot({
      perContainerExact: [row({ id: 1, status: 'deny', container_id: 'dc1' })],
      globalExact: [row({ id: 2, status: 'allow' })],
      containerId: 'dc1',
    }), 'example.com', null, NOW);
    expect(d).toMatchObject({ status: 'deny', ruleId: 1 });
  });

  it('lets deny win over allow at equal specificity — fail closed', () => {
    const d = decide(snapshot({
      globalExact: [row({ id: 1, status: 'allow' }), row({ id: 2, status: 'deny' })],
    }), 'example.com', null, NOW);
    expect(d).toMatchObject({ status: 'deny', ruleId: 2 });
  });

  it('lets a wildcard allow win over a stale exact `requested` row (finding #7)', () => {
    // The exact-host row is more specific, but it is only a placeholder created
    // by an earlier block. Once the operator adds a covering wildcard allow the
    // host must actually unblock, rather than stay stuck behind the placeholder.
    const d = decide(snapshot({
      globalExact: [row({ id: 1, status: 'requested' })],
      globalWildcard: [row({ id: 2, status: 'allow', domain: '*.test' })],
    }), 'api.test', null, NOW);
    expect(d).toMatchObject({ status: 'allow', ruleId: 2 });
  });

  it('gives an airlocked container no global fallback', () => {
    // The airlock is expressed by omission: its reader supplies no global rows.
    const globals = [row({ id: 9, status: 'allow' })];
    expect(decide(snapshot({ globalExact: globals, containerId: 'dc1' }), 'example.com', null, NOW).status).toBe('allow');
    expect(decide(snapshot({ containerId: 'dc1' }), 'example.com', null, NOW).status).toBe('requested');
  });
});

describe('decide — expiry', () => {
  it('honours a temporary allow that has not run out', () => {
    const s = snapshot({ globalExact: [row({ id: 5, expires_at: NOW + 60 })] });
    expect(decide(s, 'example.com', null, NOW)).toMatchObject({ status: 'allow', ruleId: 5 });
  });

  it('expires a temporary allow back to requested', () => {
    const s = snapshot({ globalExact: [row({ id: 5, expires_at: NOW - 1 })] });
    const d = decide(s, 'example.com', null, NOW);
    // Reported without a ruleId: the allow it came from is no longer the answer.
    expect(d).toEqual({ status: 'requested', ruleId: null, effects: [{ kind: 'reset-expired', ruleId: 5 }] });
  });

  it('reads the clock from its argument, not the process', () => {
    // Same snapshot, two moments, two answers — this is what makes the decision
    // reproducible somewhere other than where the request arrived.
    const s = snapshot({ globalExact: [row({ id: 5, expires_at: NOW })] });
    expect(decide(s, 'example.com', null, NOW - 1).status).toBe('allow');
    expect(decide(s, 'example.com', null, NOW + 1).status).toBe('requested');
  });

  it('leaves an expired DENY alone — only allows time out', () => {
    const s = snapshot({ globalExact: [row({ id: 5, status: 'deny', expires_at: NOW - 1 })] });
    expect(decide(s, 'example.com', null, NOW)).toMatchObject({ status: 'deny', ruleId: 5 });
  });
});

describe('decide — path-allowlist mode', () => {
  const marker = row({ id: 10, status: 'deny', path_mode: 1 });

  it('files an unknown subpath grouped by its first segment', () => {
    const d = decide(snapshot({ globalExact: [marker] }), 'example.com', '/v2/users/42', NOW);
    expect(d.status).toBe('requested');
    expect(d.effects).toEqual([{
      kind: 'create-requested',
      domain: 'example.com',
      containerId: null,
      pathPattern: '/v2/*',
      // The full path is kept as a concrete example for the operator.
      lastPath: '/v2/users/42',
    }]);
  });

  it('files the subpath against the container whose marker matched', () => {
    const d = decide(snapshot({
      perContainerExact: [row({ id: 11, status: 'deny', path_mode: 1, container_id: 'dc1' })],
      containerId: 'dc1',
    }), 'example.com', '/v2/x', NOW);
    expect(d.effects[0]).toMatchObject({ kind: 'create-requested', containerId: 'dc1' });
  });

  it('refreshes the example path when a requested group is hit again', () => {
    // A `requested` marker, because a concrete one outranks the group below it
    // (see the next test). Both are placeholders here, so the more specific
    // path rule wins and gets its example path refreshed in place.
    const d = decide(snapshot({
      globalExact: [
        row({ id: 10, status: 'requested', path_mode: 1 }),
        row({ id: 12, status: 'requested', path_pattern: '/v2/*' }),
      ],
    }), 'example.com', '/v2/users/43', NOW);
    expect(d).toEqual({
      status: 'requested',
      ruleId: 12,
      effects: [
        { kind: 'set-last-path', ruleId: 12, path: '/v2/users/43' },
        { kind: 'touch', ruleId: 12 },
      ],
    });
  });

  it('re-files under the default deny marker rather than refreshing in place', () => {
    // ensurePathModeMarker makes markers `deny`, and a concrete status always
    // outranks a placeholder — so the marker, not the requested group, is the
    // winner and the unknown-subpath branch runs again. Harmless: the insert is
    // OR IGNORE, so applying it lands back on the very same group row and only
    // refreshes its example path. Recorded because the effect looks like a
    // create but is idempotent.
    const d = decide(snapshot({
      globalExact: [marker, row({ id: 12, status: 'requested', path_pattern: '/v2/*' })],
    }), 'example.com', '/v2/users/43', NOW);
    expect(d.effects).toEqual([{
      kind: 'create-requested',
      domain: 'example.com',
      containerId: null,
      pathPattern: '/v2/*',
      lastPath: '/v2/users/43',
    }]);
  });

  it('honours an explicit path allow instead of filing it again', () => {
    const d = decide(snapshot({
      globalExact: [marker, row({ id: 13, status: 'allow', path_pattern: '/v2/*' })],
    }), 'example.com', '/v2/users', NOW);
    expect(d).toEqual({ status: 'allow', ruleId: 13, effects: [{ kind: 'touch', ruleId: 13 }] });
  });

  it('honours an explicit path deny', () => {
    const d = decide(snapshot({
      globalExact: [marker, row({ id: 14, status: 'deny', path_pattern: '/admin/*' })],
    }), 'example.com', '/admin/keys', NOW);
    expect(d).toMatchObject({ status: 'deny', ruleId: 14 });
  });

  it('leaves the host-only decision alone at CONNECT time, when there is no path yet', () => {
    // The proxy only sees the host at CONNECT; path enforcement happens per
    // request after MITM. With path === null the marker decides as an ordinary rule.
    const d = decide(snapshot({ globalExact: [marker] }), 'example.com', null, NOW);
    expect(d).toEqual({ status: 'deny', ruleId: 10, effects: [{ kind: 'touch', ruleId: 10 }] });
  });

  it('does not consider a path rule whose pattern does not match the request', () => {
    const d = decide(snapshot({
      globalExact: [marker, row({ id: 15, status: 'allow', path_pattern: '/v2/*' })],
    }), 'example.com', '/v3/users', NOW);
    expect(d.effects[0]).toMatchObject({ kind: 'create-requested', pathPattern: '/v3/*' });
  });
});
