// The shapes that cross the control channel.
//
// The gateway needs two things from the control plane to filter traffic: the
// firewall policy, and the callers it can be asked about — the IP→container
// mapping for devcontainers and the secret→sandbox mapping for sandboxes. It
// has none of them locally after the split — no database, no Docker socket — so
// Huddle Node serves them here and the gateway reports back what it decided.
//
// These are FEEDS, not queries. The gateway holds the whole thing in memory and
// decides locally (see ./select and ./decide) — asking Node per request would
// put Node in the hot path and stop all egress the moment it is down. Both
// feeds are therefore versioned so the gateway can poll cheaply and only pay for
// a real change; versioning is a content hash (see ./http).
//
// This module is types only, and deliberately: the gateway imports it, and it
// must not drag in the database that ./feed-build reads. Everything here is
// serialized as JSON, so keep it to plain data.

import type { RuleRow } from '../rule-match';
import type { PolicyEffect } from './decide';
import type { AuditEntry, AuditResponse } from '../db-types';
/** The firewall policy, whole. `./select` turns it into per-request snapshots. */
export interface PolicyFeed {
  version: string;
  rules: RuleRow[];
  /** Containers with no global-rule fallback; their snapshots carry no globals. */
  airlocked: string[];
}

/** Who is calling: a devcontainer by its address, a sandbox by its credential. */
export interface ContainerFeed {
  version: string;
  byIp: Record<string, string>;
  /**
   * SHA-256 of a sandbox' proxy secret, hex → the sandbox' name.
   *
   * A sandbox has no address of its own to be recognised by — every box reaches
   * the gateway as the same host-side sbx daemon — so it is recognised by the
   * credential that daemon presents (../sbx-identity.ts, docs/ADR-sbx-identity.md).
   *
   * The HASH, never the secret. The gateway has to RECOGNISE an identity, not
   * possess one, and it is deliberately the less-trusted half of the split: it
   * is the process exposed to the network, and it can be made to hand out
   * nothing it does not hold. Minting stays with Node.
   */
  sandboxAuth: Record<string, string>;
  /**
   * Running devcontainers, by name — PLUS any name `huddle migrate
   * --docker-socket` has registered (POST /api/docker/register-socket), which
   * is not filtered on "running": that container is not Huddle's, it does not
   * exist yet, and the whole point is to have the socket ready before `docker
   * compose up` starts it. See socket_registrations' comment in db.ts.
   *
   * Not for filtering — for the Docker-socket relay. The socket a devcontainer
   * mounts has to exist on the ENGINE host, which is Huddle Node's machine only
   * when the engine is native; so the gateway creates it and tunnels it back
   * (../socket-relay.ts). It needs to know which containers to create one for,
   * and it has no Docker socket of its own to ask.
   */
  devcontainers?: string[];
  /** Names explicitly pre-registered by `huddle migrate --docker-socket`. */
  socketRegistrations?: string[];
  /** Opaque registration revisions; forces a gateway refresh on re-registration. */
  socketRegistrationRevisions?: Record<string, string>;
  /**
   * Bumped every time Node successfully attaches the gateway to a devcontainer
   * network (docker.ts's `connectNetwork`). Folded into `version` so a connect
   * that does not change `byIp`/`devcontainers` — e.g. `huddle
   * rewire-gateway` reconnecting the gateway to networks whose devcontainers
   * were already listed — still changes the feed.
   *
   * That matters because a connect is also what repollutes the GATEWAY
   * container's own /etc/resolv.conf (see ../dns-egress.ts): Podman puts the
   * network's internal-only DNS at the front of it on every connect. Without
   * this the gateway would only ever notice through `devcontainers` changing,
   * which a bare reconnect does not do — it would keep enforcing a resolv.conf
   * that the connect just broke, until something unrelated changed the feed.
   */
  networkGeneration?: number;
}

// ── The write half ───────────────────────────────────────────────────────────
//
// A decision is made in the gateway but written down by Node: the rules table
// and the audit log are Node's. The gateway therefore batches what it decided
// and posts it here — asynchronously, because the request it describes has
// already been answered.

/**
 * A request the gateway logged. `ref` is the gateway's own handle for the row —
 * it cannot know the id Node's database will assign, so it mints a local one and
 * refers to it again when the response comes in. Node keeps the mapping.
 */
export interface ReportAudit {
  ref: number;
  entry: AuditEntry;
  /**
   * Index into `effects` of the `create-requested` this entry refers to. The
   * rule did not exist when the request was blocked, so its id is Node's to
   * assign and to fill in here — that id is what makes the blocked host
   * clickable in the portal.
   */
  ruleFromEffect?: number;
}

/** The response fields of a request logged earlier, by the same `ref`. */
export interface ReportAuditUpdate {
  ref: number;
  response: AuditResponse;
}

/**
 * A sudo command a devcontainer ran, on its way to the audit log.
 *
 * The devcontainer POSTs the raw sudo line to Huddle through the proxy; the
 * gateway answers that itself and forwards the line here rather than letting it
 * through to an API that no longer sits behind it (proxy-self.ts).
 *
 * `containerId` comes from the gateway's own IP→container lookup, never from the
 * body — a devcontainer cannot file sudo activity under another container's
 * name, which is the property the old ingest had for the same reason.
 */
export interface SudoAudit {
  containerId: string;
  entry: string;
}

export interface ReportBody {
  /**
   * Identifies the gateway process. Refs are per-process counters, so a restart
   * reuses low numbers; without this Node could match a fresh ref to a stale
   * mapping and attach a response to somebody else's audit row.
   */
  session: string;
  /** Applied in order. `create-requested` mints rows the audits refer to. */
  effects: PolicyEffect[];
  audits: ReportAudit[];
  auditUpdates: ReportAuditUpdate[];
  sudoAudits: SudoAudit[];
  /** What the gateway dropped when the queue overflowed, so Node can say so. */
  dropped?: number;
}
