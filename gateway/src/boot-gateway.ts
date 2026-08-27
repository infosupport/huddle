// Booting huddle-gateway: the network enforcement point, in Docker.
//
// This is the whole of the gateway now. It opens two filtering proxies, keeps
// its own copy of the firewall policy in sync with Huddle Node, and signs leaf
// certs with a CA it is given. It has no database, no Docker socket, no API and
// no portal — see docs/ADR-huddle-node-split.md for why the half of Huddle that
// is reachable from a devcontainer should be able to do as little as possible.
//
// The import graph is the enforcement of that, not just the intent: nothing
// reachable from this file imports ./db, ./docker or ./api, so better-sqlite3
// and dockerode are not in this process at all. index.ts dispatches to it with a
// dynamic import for exactly that reason.

import { createProxyServer } from './proxy';
import { initCa } from './tls-ca';
import { scheduleSettlingSanitize } from './dns-egress';
import { SBX_PROXY_PORT, sbxUpstreamUrl } from './sbx-upstream';
import { getGatewayToken } from './auth';
import { runtimeEnv } from './runtime-env';
import { createControlClient } from './control/client';
import { setControlPlane } from './control/plane';

export function bootGateway(): void {
  // Load the CA, never mint one: the gateway gets CA_DIR bind-mounted read-only
  // and a self-generated root would validate nothing. Failing here is correct —
  // a gateway that cannot MITM cannot enforce path rules.
  initCa({ generate: false });

  // The control plane, before the proxies: the proxy denies everything until a
  // policy has arrived, and there is no reason to widen that window.
  const client = createControlClient({
    baseUrl: runtimeEnv.nodeControlUrl,
    token: getGatewayToken(),
  });
  setControlPlane(client.plane);
  client.start();
  console.log(`[control] following Huddle Node at ${runtimeEnv.nodeControlUrl}`);

  createProxyServer();
  // Dedicated egress port for Docker Sandboxes (sbx) boxes. sbx cannot be pointed
  // at the per-container proxy topology, so it gets its own listener; the sbx
  // upstream proxy is set to this port when a sandbox is started. Same proxy
  // logic and firewall as :80 — just a stable endpoint the host sbx daemon can
  // forward sandbox egress to.
  createProxyServer(SBX_PROXY_PORT);
  console.log(`[sbx] proxy port ${SBX_PROXY_PORT} open — upstream for sandboxes: ${sbxUpstreamUrl()}`);

  // Rewrites /etc/resolv.conf of the container this runs in, which is why it is
  // gateway-only: on the host that would be Huddle Node editing the operator's
  // DNS configuration. The settling re-runs are also how this process recovers
  // from a devcontainer-network connect that Node performed in its own process.
  scheduleSettlingSanitize();
}
