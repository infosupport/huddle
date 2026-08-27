import { initDb } from './db';
import { runSettingsMigration } from './settings-migration';
import { createProxyServer } from './proxy';
import { createApiServer } from './api';
import { listDevcontainers, networkExists, connectNetwork, refreshContainerIptables, execInContainer } from './docker';
import { sweepExpiredSudoGrants } from './sudo-grant';
import { createContainerProxy } from './socket-proxy';
import { initCa } from './tls-ca';
import { sanitizeResolvConf, scheduleSettlingSanitize } from './dns-egress';
import { SBX_PROXY_PORT, sbxUpstreamUrl } from './sbx';
import { startAutoSync } from './sandbox/auto-sync';
import { runtimeEnv } from './runtime-env';

// ECONNRESET / EPIPE are normal client-disconnect events on a TCP server.
// Without this handler Node.js crashes the process on unhandled 'error' events
// from sockets that lose their connection unexpectedly.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

const SOCKET_DIR = runtimeEnv.socketDir;

// Which halves of Huddle this process runs (docs/ADR-huddle-node-split.md).
// 'all' is the default and starts everything in one process, exactly as before;
// 'gateway' is the network data plane, 'node' the control plane on the host.
const { runsGateway, runsNode } = runtimeEnv;
if (runtimeEnv.role !== 'all') console.log(`[boot] role=${runtimeEnv.role}`);

// Both roles open the database: the proxy still reads the rules and writes audit
// rows straight from it (step 4 replaces that with a control channel), and Node
// owns everything else in there. Split across two hosts they must be pointed at
// the same DB_PATH.
initDb();
// Resource limits + folder mappings moved from the DB into config.json (#98).
// Config is Node's alone, so only Node migrates it — running it from two
// processes at once would race.
if (runsNode) runSettingsMigration();
// Also needed by both, for opposite reasons: the gateway SIGNS leaf certs with
// the CA, Node hands the CA out to containers and the host trust store. Split
// deployments must therefore share CA_DIR — two processes with private CA_DIRs
// would each mint their own root and nothing would validate.
initCa();

if (runsGateway) {
  createProxyServer();
  // Dedicated egress port for Docker Sandboxes (sbx) boxes. sbx cannot be pointed
  // at the per-container proxy topology, so it gets its own listener; the sbx
  // upstream proxy is set to this port when a sandbox is started (see sbx.ts).
  // Same proxy logic/firewall as :80 — just a stable endpoint Huddle "already opens"
  // so the host sbx daemon has somewhere to forward to.
  createProxyServer(SBX_PROXY_PORT);
  console.log(`[sbx] proxy port ${SBX_PROXY_PORT} open — upstream for sandboxes: ${sbxUpstreamUrl()}`);
}

if (runsNode) {
  // Background sbx sync: auto-reconcile Huddle→sbx + ingest blocked requests as
  // pending (sbx→Huddle). Best-effort; no-op when sbx isn't reachable.
  startAutoSync();
  createApiServer().catch(err => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });
}

// Re-create proxy sockets for all existing devcontainers (survives huddle restart)
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
        try { await connectNetwork(netName, 'huddle'); } catch {} // already connected is fine
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
// Sudo grants, socket proxies, network wiring and iptables are all driven through
// the Docker API, which is Node's to hold — the whole point of the split is that
// the network-exposed gateway stops mounting docker.sock (step 7).
if (runsNode) {
  setInterval(() => { void sweepSudoGrants(); }, SUDO_SWEEP_INTERVAL_MS);
  void sweepSudoGrants();

  initContainerProxies();
  // Reconnecting to the devcontainer networks pollutes resolv.conf (Podman puts the
  // internal-net aardvark DNS in it); sanitize afterwards so egress DNS keeps
  // working, even when there are (yet) no devcontainers. The settling runs also
  // catch the devcontainer-net connect that `huddle init` only performs after start.
  //
  // Note the seam: the connect is a Docker call (Node) but the resolv.conf it
  // breaks belongs to the GATEWAY container (see dns-egress.ts). In one process
  // that chains directly; split, Node connects and the gateway has to notice on
  // its own — which is what scheduleSettlingSanitize() below does.
  initContainerNetworks().finally(() => { if (runsGateway) void sanitizeResolvConf(); });
}

// Gateway-only, and deliberately so: this rewrites /etc/resolv.conf of the
// container it runs in. On the host that would be Huddle Node editing the
// operator's DNS configuration, which it must never do. The settling re-runs are
// also how a gateway-only process recovers from a network connect that Node
// performed in the other process.
if (runsGateway) scheduleSettlingSanitize();

if (runsNode) initContainerIptables();
