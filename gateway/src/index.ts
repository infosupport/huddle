import { initDb } from './db';
import { runSettingsMigration } from './settings-migration';
import { createProxyServer } from './proxy';
import { createApiServer } from './api';
import { listDevcontainers, networkExists, connectNetwork, refreshContainerIptables, execInContainer } from './docker';
import { sweepExpiredSudoGrants } from './sudo-grant';
import { createContainerProxy } from './socket-proxy';
import { restoreSshRelays } from './ssh-link';
import { initCa } from './tls-ca';
import { sanitizeResolvConf, scheduleSettlingSanitize } from './dns-egress';
import { sbxProvider } from './environments';
import { sbxEgressIdentify } from './environments/sbx-store';
import { SBX_PROXY_PORT } from './environments/sbx-egress';

// ECONNRESET / EPIPE are normal client-disconnect events on a TCP server.
// Without this handler Node.js crashes the process on unhandled 'error' events
// from sockets that lose their connection unexpectedly.
process.on('uncaughtException', (err: NodeJS.ErrnoException) => {
  if (err.code === 'ECONNRESET' || err.code === 'EPIPE') return;
  console.error('[fatal] uncaught exception:', err);
  process.exit(1);
});

const SOCKET_DIR = '/tmp/dc-sockets';

initDb();
// Resource limits + folder mappings moved from the DB into config.json (#98).
runSettingsMigration();
initCa();
createProxyServer();
// Egress of Docker Sandboxes (docs/host-pipe.md, "sbx egress"). The sbx daemon
// on the host connects here through the loopback port `huddle init` published
// and names the sandbox with its proxy secret. No TLS interception: sandboxes do
// not trust the Huddle CA.
createProxyServer(SBX_PROXY_PORT, {
  intercept: false,
  identify: sbxEgressIdentify(() => sbxProvider.onResetSecretSeen()),
});
// Sandboxes whose secret the gateway lost (it stopped mid-create) are recreated
// once the host pipe answers; until then, try again every 30 s.
const SBX_RECONCILE_RETRY_MS = 30_000;
function reconcileSbx(): void {
  sbxProvider.reconcile()
    .catch((err) => { console.error('[sbx] reconcile failed:', err?.message ?? err); return true; })
    .then((done) => { if (!done) setTimeout(reconcileSbx, SBX_RECONCILE_RETRY_MS).unref(); });
}
reconcileSbx();
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
    // SSH relays (inbound JetBrains Gateway SSH) for devcontainers that still exist.
    await restoreSshRelays(new Set(containers.map(c => c.name)));
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
