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

initDb();
// Resource limits + folder mappings moved from the DB into config.json (#98).
runSettingsMigration();
initCa();
createProxyServer();
// Dedicated egress port for Docker Sandboxes (sbx) boxes. sbx cannot be pointed
// at the per-container proxy topology, so it gets its own listener; the sbx
// upstream proxy is set to this port when a sandbox is started (see sbx.ts).
// Same proxy logic/firewall as :80 — just a stable endpoint Huddle "already opens"
// so the host sbx daemon has somewhere to forward to.
createProxyServer(SBX_PROXY_PORT);
console.log(`[sbx] proxy port ${SBX_PROXY_PORT} open — upstream for sandboxes: ${sbxUpstreamUrl()}`);
// Background sbx sync: auto-reconcile Huddle→sbx + ingest blocked requests as
// pending (sbx→Huddle). Best-effort; no-op when the sbx bridge isn't running.
startAutoSync();
createApiServer().catch(err => {
  console.error('[api] failed to start', err);
  process.exit(1);
});

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
setInterval(() => { void sweepSudoGrants(); }, SUDO_SWEEP_INTERVAL_MS);
void sweepSudoGrants();

initContainerProxies();
// Reconnecting to the devcontainer networks pollutes resolv.conf (Podman puts the
// internal-net aardvark DNS in it); sanitize afterwards so egress DNS keeps
// working, even when there are (yet) no devcontainers. The settling runs also
// catch the devcontainer-net connect that `huddle init` only performs after start.
initContainerNetworks().finally(() => { void sanitizeResolvConf(); });
scheduleSettlingSanitize();
initContainerIptables();
