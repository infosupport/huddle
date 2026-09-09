// A control plane wired up inside one process, for tests.
//
// This is NOT a second binding in the sense plane.ts warns about: it is the real
// one. `createControlClient` is the production gateway code, unchanged; only the
// transport is replaced by a function that answers the feeds from the local
// database and hands reports straight to `applyReport`. So a suite that binds
// this exercises the actual pipeline — buildPolicyFeed → indexPolicy →
// decideRequest → applyReport — rather than a mock of the decision.
//
// Two consequences follow, and both are deliberate:
//
//   Refreshing is explicit. The gateway holds a policy snapshot; a rule inserted
//   into the database is not visible to it until it polls. Tests must therefore
//   `await refresh()` after touching the rules table, exactly as a real gateway
//   waits out its poll interval.
//
//   Reports are explicit too. The write half is asynchronous in production, so
//   nothing lands in the rules table or the audit log until `await flush()`.
//
// Everything is imported dynamically: feed-build and apply reach the database,
// and importing this helper must not open one as a side effect — the suite
// decides when db.ts loads, not the helper it borrows.

import type { ControlPlane } from '../../src/control/plane';

export interface LocalPlaneOptions {
  /** The IP→container map the plane answers from. Most suites need none. */
  containersByIp?: Record<string, string>;
  /** sha256(secret) → sandbox name, as the container feed carries it. */
  sandboxAuth?: Record<string, string>;
  /** Injected clock, unix seconds — for expiry tests. */
  nowSeconds?: () => number;
}

export interface LocalPlane {
  plane: ControlPlane;
  /** Re-read the policy from the database into the gateway's snapshot. */
  refresh(): Promise<void>;
  /** Post everything the decisions queued, and apply it to the database. */
  flush(): Promise<void>;
  /** What the last flush applied — effect/audit counts, for assertions. */
  lastApplied(): unknown;
}

export async function createLocalPlane(opts: LocalPlaneOptions = {}): Promise<LocalPlane> {
  const { buildPolicyFeed } = await import('../../src/control/feed-build');
  const { applyReport } = await import('../../src/control/apply');
  const { createControlClient } = await import('../../src/control/client');
  const { feedVersion } = await import('../../src/control/http');

  let applied: unknown = null;
  const containers = opts.containersByIp ?? {};
  const sandboxAuth = opts.sandboxAuth ?? {};

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  // Everything a control channel does, minus the network. The feeds are built
  // fresh per call, so `refresh()` always sees the current database.
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/control/policy')) return json(buildPolicyFeed());
    if (url.endsWith('/control/containers')) {
      return json({
        version: feedVersion(JSON.stringify({ containers, sandboxAuth })),
        byIp: containers,
        sandboxAuth,
      });
    }
    if (url.endsWith('/control/report')) {
      applied = applyReport(JSON.parse(String(init?.body ?? '{}')));
      return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
  };

  const client = createControlClient({
    baseUrl: 'http://control.test',
    token: 'test-token',
    fetchImpl,
    nowSeconds: opts.nowSeconds,
    session: 'test-session',
  });

  return {
    plane: client.plane,
    refresh: () => client.refresh(),
    flush: () => client.flush(),
    lastApplied: () => applied,
  };
}
