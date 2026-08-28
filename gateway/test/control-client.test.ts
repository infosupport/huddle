import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createControlClient, describeControlError, type ControlClient } from '../src/control/client';
import type { PolicyFeed, ReportBody } from '../src/control/feed';
import type { RuleRow } from '../src/rule-match';

// The gateway's whole binding to Huddle Node, driven against a scripted fetch.
// No database and no native binding, on purpose: this is the half of the
// firewall that keeps enforcing while Node is gone, so it has to be testable in
// exactly the environments where SQLite is not.

function rule(over: Partial<RuleRow> & { domain: string }): RuleRow {
  return {
    id: 1,
    status: 'allowed',
    expires_at: null,
    container_id: null,
    path_pattern: null,
    path_mode: 0,
    ...over,
  } as RuleRow;
}

function policy(rules: RuleRow[], version = 'v1'): PolicyFeed {
  return { version, rules, airlocked: [], sandboxes: [] };
}

interface Harness {
  client: ControlClient;
  posts: ReportBody[];
  calls: { path: string; ifNoneMatch: string | undefined }[];
  /** Replace what /control/policy answers with. */
  setPolicy(feed: PolicyFeed | null): void;
  /** Make every control call fail, as an unreachable Node does. */
  setDown(down: boolean): void;
}

function harness(opts: { reportFails?: boolean } = {}): Harness {
  let feed: PolicyFeed | null = policy([]);
  let down = false;
  const posts: ReportBody[] = [];
  const calls: { path: string; ifNoneMatch: string | undefined }[] = [];

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ path: url.replace('http://node.test', ''), ifNoneMatch: headers['if-none-match'] });
    if (down) throw new Error('ECONNREFUSED');

    // Every control call carries the gateway token as a Bearer header, never as
    // a query parameter — a token in a URL ends up in the audit log.
    expect(headers.authorization).toBe('Bearer gw-token');
    expect(url).not.toContain('gw-token');

    if (url.endsWith('/control/policy')) {
      if (!feed) return new Response('nope', { status: 500 });
      if (headers['if-none-match'] === `"${feed.version}"`) return new Response(null, { status: 304 });
      return Response.json(feed);
    }
    if (url.endsWith('/control/containers')) {
      return Response.json({ version: 'c1', byIp: { '172.20.0.5': 'dc-alpha' } });
    }
    if (url.endsWith('/control/report')) {
      if (opts.reportFails) return new Response('nope', { status: 503 });
      posts.push(JSON.parse(String(init?.body)) as ReportBody);
      return Response.json({ ok: true });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  const client = createControlClient({
    baseUrl: 'http://node.test',
    token: 'gw-token',
    fetchImpl,
    nowSeconds: () => 1_000,
    session: 'sess-1',
  });

  return {
    client,
    posts,
    calls,
    setPolicy: (f) => { feed = f; },
    setDown: (d) => { down = d; },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('control client — fail closed, then fail static', () => {
  it('denies everything before the first policy arrives', () => {
    const { client } = harness();
    expect(client.ready()).toBe(false);
    // Not `requested`: with no policy at all, filing the host as pending would
    // tell the operator a rule exists for it.
    expect(client.plane.checkRule('example.com', 'dc-alpha', null)).toEqual({ status: 'deny', ruleId: null });
    expect(client.plane.checkFleetRule('example.com', ['box'], null)).toEqual({ status: 'deny', ruleId: null });
    expect(client.plane.isPathMode('example.com', 'dc-alpha')).toBe(false);
  });

  it('keeps enforcing the last policy while Node is unreachable', async () => {
    const h = harness();
    h.setPolicy(policy([rule({ id: 7, domain: 'example.com' })]));
    await h.client.refresh();
    expect(h.client.plane.checkRule('example.com', 'dc-alpha', null).status).toBe('allowed');

    h.setDown(true);
    await h.client.refresh();
    // Still allowed, and still only that host — a control plane that is down is
    // not a reason to open the firewall, nor to break every devcontainer.
    expect(h.client.ready()).toBe(true);
    expect(h.client.plane.checkRule('example.com', 'dc-alpha', null).status).toBe('allowed');
    // Unknown host: blocked and filed as pending, which is the WITH-policy
    // answer. `deny` is reserved for having no policy at all.
    expect(h.client.plane.checkRule('evil.test', 'dc-alpha', null).status).toBe('requested');
  });

  it('a refresh failure never throws into the caller', async () => {
    const h = harness();
    h.setDown(true);
    await expect(h.client.refresh()).resolves.toBeUndefined();
  });
});

describe('control client — feed polling', () => {
  it('sends If-None-Match once it knows a version and accepts 304 without dropping policy', async () => {
    const h = harness();
    h.setPolicy(policy([rule({ id: 7, domain: 'example.com' })]));
    await h.client.refresh();
    expect(h.calls[0].ifNoneMatch).toBeUndefined();

    await h.client.refresh();
    expect(h.calls.find((c) => c.path === '/control/policy' && c.ifNoneMatch)?.ifNoneMatch).toBe('"v1"');
    expect(h.client.plane.checkRule('example.com', 'dc-alpha', null).status).toBe('allowed');
  });

  it('swaps the whole policy when the version changes', async () => {
    const h = harness();
    h.setPolicy(policy([rule({ id: 7, domain: 'example.com' })]));
    await h.client.refresh();
    h.setPolicy(policy([rule({ id: 8, domain: 'other.test' })], 'v2'));
    await h.client.refresh();
    // Snapshot, not delta: the old rule is gone rather than merged.
    expect(h.client.plane.checkRule('example.com', 'dc-alpha', null).status).toBe('requested');
    expect(h.client.plane.checkRule('other.test', 'dc-alpha', null).status).toBe('allowed');
  });

  it('resolves a container from the pushed map instead of the Docker socket', async () => {
    const h = harness();
    await h.client.refresh();
    await expect(h.client.plane.resolveContainerByIp('172.20.0.5')).resolves.toBe('dc-alpha');
    await expect(h.client.plane.resolveContainerByIp('172.20.0.9')).resolves.toBeNull();
  });
});

describe('control client — the report queue', () => {
  it('posts effects and audits together, keyed by session', async () => {
    const h = harness();
    h.setPolicy(policy([]));
    await h.client.refresh();

    const decision = h.client.plane.checkRule('blocked.test', 'dc-alpha', null);
    expect(decision.status).toBe('requested');
    const ref = h.client.plane.logAudit({
      containerId: 'dc-alpha', domain: 'blocked.test', action: 'blocked',
      method: 'GET', path: '/', ruleId: decision.ruleId, ruleRef: decision.ruleRef,
    } as never);
    h.client.plane.updateAuditResponse(ref, { status: 403 } as never);
    h.client.plane.reportSudoAudit('dc-alpha', 'COMMAND=/usr/bin/id');
    await h.client.flush();

    expect(h.posts).toHaveLength(1);
    const body = h.posts[0];
    expect(body.session).toBe('sess-1');
    expect(body.effects.some((e) => e.kind === 'create-requested')).toBe(true);
    // The rule does not exist yet, so the audit points at the effect and Node
    // fills the real id in — that is what makes the blocked host clickable.
    expect(body.audits[0].ruleFromEffect).toBe(0);
    expect(body.auditUpdates[0].ref).toBe(ref);
    expect(body.sudoAudits).toEqual([{ containerId: 'dc-alpha', entry: 'COMMAND=/usr/bin/id' }]);
  });

  it('does not post when there is nothing queued', async () => {
    const h = harness();
    await h.client.refresh();
    await h.client.flush();
    expect(h.calls.some((c) => c.path === '/control/report')).toBe(false);
  });

  it('restores a failed batch and re-posts it with the audit refs shifted', async () => {
    // A report endpoint that fails once and then succeeds, so both halves of
    // the restore path are exercised and the posted body can be inspected.
    let fail = true;
    const posts: ReportBody[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith('/control/policy')) return Response.json(policy([]));
      if (url.endsWith('/control/containers')) return Response.json({ version: 'c1', byIp: {} });
      if (url.endsWith('/control/report')) {
        if (fail) { fail = false; return new Response('nope', { status: 503 }); }
        posts.push(JSON.parse(String(init?.body)) as ReportBody);
        return Response.json({ ok: true });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;

    const client = createControlClient({
      baseUrl: 'http://node.test', token: 'gw-token', fetchImpl, nowSeconds: () => 1_000, session: 's',
    });
    await client.refresh();

    const first = client.plane.checkRule('one.test', 'dc-a', null);
    client.plane.logAudit({
      containerId: 'dc-a', domain: 'one.test', action: 'blocked',
      method: 'GET', path: '/', ruleId: first.ruleId, ruleRef: first.ruleRef,
    } as never);
    await client.flush(); // fails, restored

    const second = client.plane.checkRule('two.test', 'dc-a', null);
    client.plane.logAudit({
      containerId: 'dc-a', domain: 'two.test', action: 'blocked',
      method: 'GET', path: '/', ruleId: second.ruleId, ruleRef: second.ruleRef,
    } as never);
    await client.flush(); // succeeds

    expect(posts).toHaveLength(1);
    const body = posts[0];
    expect(body.effects).toHaveLength(2);
    // Order preserved, and the second audit was re-pointed at its effect's new
    // index. Getting this wrong attaches a blocked host to the wrong rule.
    expect(body.audits.map((a) => a.ruleFromEffect)).toEqual([0, 1]);
    expect(body.audits.map((a) => a.entry.domain)).toEqual(['one.test', 'two.test']);
  });

  it('drops the whole batch, not its oldest half, when the queue overflows', async () => {
    const h = harness({ reportFails: true });
    h.setPolicy(policy([]));
    await h.client.refresh();

    // One audit carrying more than the 32 MB byte cap. Trimming one end of the
    // batch would silently repoint the audits that index into `effects`, so the
    // cap throws everything away and says so.
    const warn = vi.mocked(console.warn);
    h.client.plane.logAudit({
      containerId: 'dc-a', domain: 'big.test', action: 'blocked', method: 'GET', path: '/',
      ruleId: null, resBody: 'x'.repeat(33 * 1024 * 1024),
    } as never);
    expect(warn.mock.calls.some((c) => String(c[0]).includes('report queue full'))).toBe(true);

    // The drop is reported to Node rather than silently forgotten.
    h.client.plane.reportSudoAudit('dc-a', 'COMMAND=/usr/bin/id');
    await h.client.flush();
    expect(h.calls.some((c) => c.path === '/control/report')).toBe(true);
  });
});

describe('describeControlError', () => {
  // `fetch failed` on its own sent us hunting the wrong half of the problem
  // once already: it is what undici says for a name that does not resolve AND
  // for a port nothing listens on, and those need opposite fixes.
  function fetchFailed(code: string, message: string): Error {
    const cause = Object.assign(new Error(message), { code });
    return Object.assign(new Error('fetch failed'), { cause });
  }

  it('names the code and says what it means', () => {
    const out = describeControlError(fetchFailed('ENOTFOUND', 'getaddrinfo ENOTFOUND host.docker.internal'));
    expect(out).toContain('ENOTFOUND');
    expect(out).toContain('does not resolve inside this container');
  });

  it('tells a refused port apart from an unresolvable name', () => {
    const refused = describeControlError(fetchFailed('ECONNREFUSED', 'connect ECONNREFUSED 192.168.65.254:24843'));
    expect(refused).toContain('nothing is listening');
    expect(refused).not.toContain('does not resolve');
  });

  it('still reports a cause it has no hint for', () => {
    const out = describeControlError(fetchFailed('ECONNRESET', 'socket hang up'));
    expect(out).toContain('ECONNRESET');
    expect(out).toContain('socket hang up');
  });

  it('falls back to the message when there is no cause', () => {
    expect(describeControlError(new Error('/control/policy \u2192 401'))).toBe('/control/policy \u2192 401');
  });

  it('survives a thrown non-Error', () => {
    expect(describeControlError('boom')).toBe('boom');
  });
});

describe('control client — attributing a request to its container', () => {
  it('resolves a dual-stack socket address against the plain feed key', async () => {
    const h = harness();
    await h.client.refresh();
    // What Node's proxy actually sees: it listens without a bind host, so the
    // socket is dual-stack and an IPv4 peer arrives IPv4-mapped. The feed is
    // keyed on what Docker reports. Miss this and every rule is filed global.
    expect(await h.client.plane.resolveContainerByIp('::ffff:172.20.0.5')).toBe('dc-alpha');
    expect(await h.client.plane.resolveContainerByIp('172.20.0.5')).toBe('dc-alpha');
  });

  it('still returns null for an address no container owns', async () => {
    const h = harness();
    await h.client.refresh();
    expect(await h.client.plane.resolveContainerByIp('::ffff:10.9.9.9')).toBeNull();
  });
});
