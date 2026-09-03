// The control channel: the gateway's side door into Huddle Node.
//
// Four endpoints, and deliberately only four. This is not a second management
// API and must not grow into one — the whole point of the split
// (docs/ADR-huddle-node-split.md) is that the network-exposed half of Huddle can
// do less, not that it gets a private way to do the same things. Anything an
// operator does stays on /api/*, behind the operator token.
//
// AUTH: gateway token only, checked in api.ts's onRequest hook before any of
// these run. The operator token does NOT open /control/* and this token does NOT
// open /api/* — see auth.ts for why the two are kept apart.
//
// The two feeds are polled with If-None-Match. A gateway that already holds the
// current version gets a 304 and keeps using what it has, which also means a
// Node that is briefly unreachable costs nothing: the gateway keeps deciding
// from its last known policy instead of failing open or blocking all egress.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { applyReport } from './apply';
import { buildContainerFeed, buildPolicyFeed } from './feed-build';
import type { ReportBody } from './feed';
import { presentedVersion } from './http';
import { markSocketReady } from '../db';
import { notifyStateChanged } from '../events';

// Serve a versioned feed with ETag semantics. In one place so both feeds answer
// a conditional request identically.
async function serveFeed<T extends { version: string }>(
  req: FastifyRequest,
  reply: FastifyReply,
  build: () => T | Promise<T>,
): Promise<T | undefined> {
  const feed = await build();
  reply.header('etag', `"${feed.version}"`);
  if (presentedVersion(req.headers['if-none-match']) === feed.version) {
    reply.code(304);
    return undefined;
  }
  return feed;
}

export function registerControlRoutes(app: FastifyInstance): void {
  // Is the control plane up, and is this token the right one? The gateway calls
  // this at startup so a misconfigured token fails loudly at boot rather than
  // silently at the first blocked request.
  app.get('/control/health', async () => ({ ok: true, role: 'node' }));

  // The firewall policy, whole. The gateway builds per-request snapshots from it
  // locally; see ./decide for what it does with them.
  app.get('/control/policy', async (req, reply) => serveFeed(req, reply, buildPolicyFeed));

  // The IP→container mapping the proxy attributes connections with. Separate
  // from the policy feed because it changes on a completely different clock:
  // containers come and go far more often than rules do.
  app.get('/control/containers', async (req, reply) => serveFeed(req, reply, buildContainerFeed));

  // Gateway-only acknowledgement: a registered name is not ready merely
  // because it appeared in a feed; its Unix listener must have bound first.
  app.post<{ Body: { name?: unknown } }>('/control/socket-ready', async (req, reply) => {
    const name = req.body?.name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name)) {
      return reply.code(400).send({ error: 'invalid container name' });
    }
    if (!markSocketReady(name)) return reply.code(404).send({ error: 'not registered' });
    notifyStateChanged();
    return { ok: true };
  });

  // The write half: what the gateway decided, batched. The requests these
  // describe have already been answered — this is the operator's record of them
  // (the audit log) and the blocked hosts they filed for review. Applied in
  // order and never re-decided; see ./apply.
  app.post<{ Body: ReportBody }>('/control/report', async (req) => applyReport(req.body));
}
