// Booting Huddle Node: the control plane, on the host.
//
// Everything Huddle does that is not packet filtering: the portal and REST/WS
// API, the database, the CA, project and devcontainer orchestration through
// Docker, extensions, sudo grants, and sbx. It runs directly on the user's
// machine — outside the firewall it configures, which is the point
// (docs/ADR-huddle-node-split.md).
//
// It also serves the control channel the gateway follows: the policy and
// container feeds, and the endpoint the gateway reports its decisions to. That
// listener is deliberately NOT the portal's — see control/server.ts.

import { getGatewayToken } from './auth';
import { initDb } from './db';
import { runSettingsMigration } from './settings-migration';
import { createApiServer } from './api';
import { createControlServer } from './control/server';
import { listDevcontainers, networkExists, connectNetwork, refreshContainerIptables, execInContainer } from './docker';
import { sweepExpiredSudoGrants } from './sudo-grant';
import { createContainerProxy } from './socket-proxy';
import { initCa } from './tls-ca';
import { startAutoSync } from './sandbox/auto-sync';
import { runtimeEnv } from './runtime-env';

const SOCKET_DIR = runtimeEnv.socketDir;

// Re-create proxy sockets for all existing devcontainers (survives a restart).
async function initContainerProxies(): Promise<void> {
  try {
    const containers = await listDevcontainers();
    for (const c of containers) {
      await createContainerProxy(c.name, SOCKET_DIR);
    }
    if (containers.length) {
      console.log(`[socket-proxy] restored ${containers.length} proxy socket(s)`);
    }
  } catch (err: any) {
    console.error('[socket-proxy] init failed:', err.message);
  }
}

async function initContainerNetworks(): Promise<void> {
  try {
    const containers = await listDevcontainers();
    for (const c of containers) {
      const netName = `dc-net-${c.name}`;
      if (await networkExists(netName)) {
        try { await connectNetwork(netName, 'huddle'); } catch { /* already connected is fine */ }
      }
    }
  } catch (err: any) {
    console.error('[network] init failed:', err.message);
  }
}

async function initContainerIptables(): Promise<void> {
  try {
    const containers = await listDevcontainers();
    for (const c of containers) {
      await refreshContainerIptables(c.id, c.name);
    }
  } catch (err: any) {
    console.error('[iptables] init failed:', err.message);
  }
}

// Ephemeral sudo grants must be locked INTERNALLY in the container as soon as they
// expire — expiry is therefore not passive. This active sweeper periodically locks
// the 'noot' user in every container with an expired grant and cleans up the row.
// Best-effort per container (a disappeared container leaves the rest untouched).
const SUDO_SWEEP_INTERVAL_MS = 30_000;
async function sweepSudoGrants(): Promise<void> {
  try {
    const locked = await sweepExpiredSudoGrants(execInContainer);
    if (locked.length) console.log(`[sudo-grant] noot locked in ${locked.length} expired container(s)`);
  } catch (err: any) {
    console.error('[sudo-grant] sweep failed:', err.message);
  }
}

export function bootNode(): void {
  initDb();
  // Resource limits + folder mappings moved from the DB into config.json (#98).
  runSettingsMigration();
  // Node owns the CA: it generates it, hands it to containers and to the host
  // trust store, and bind-mounts the directory into the gateway read-only. One
  // CA, one writer — two processes each minting their own root would validate
  // nothing.
  initCa({ generate: true });

  // Mint the gateway token NOW, before either listener starts.
  //
  // It is created on first use, and the gateway's own first use is a /control
  // request — which it cannot make without already having the token. `huddle
  // init` breaks that circle by reading it out of the data dir and passing it
  // into the container, so on a fresh install the file has to exist by the time
  // Node answers at all, or init dies with a bare
  // `ENOENT: ... open '~/.huddle/gateway-token'` and never creates the gateway.
  //
  // Here rather than in control/server.ts because the two listeners start
  // concurrently: init waits for the API, so minting it on the control side
  // would leave a window where the API answers and the file is not there yet.
  getGatewayToken();

  createControlServer().catch(err => {
    console.error('[control] failed to start', err);
    process.exit(1);
  });

  createApiServer().catch(err => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });

  // Background sbx sync: auto-reconcile Huddle→sbx + ingest blocked requests as
  // pending (sbx→Huddle). Best-effort; no-op when sbx isn't reachable.
  startAutoSync();

  setInterval(() => { void sweepSudoGrants(); }, SUDO_SWEEP_INTERVAL_MS);
  void sweepSudoGrants();

  void initContainerProxies();
  // Reconnecting to the devcontainer networks pollutes resolv.conf (Podman puts
  // the internal-net aardvark DNS in it). Note the seam: the connect is a Docker
  // call (Node's) but the resolv.conf it breaks belongs to the GATEWAY container
  // (see dns-egress.ts), which notices on its own — scheduleSettlingSanitize()
  // in boot-gateway.ts.
  void initContainerNetworks();
  void initContainerIptables();
}
