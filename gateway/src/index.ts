import { initDb } from './db';
import { createProxyServer } from './proxy';
import { createApiServer } from './api';
import { listDevcontainers, networkExists, connectNetwork, refreshContainerIptables } from './docker';
import { createContainerProxy } from './socket-proxy';
import { initCa } from './tls-ca';
import { sanitizeResolvConf, scheduleSettlingSanitize } from './dns-egress';

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
initCa();
createProxyServer();
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

initContainerProxies();
// Reconnecten aan de devcontainer-netwerken vervuilt resolv.conf (Podman zet de
// internal-net aardvark-DNS erin); sanitize erna zodat egress-DNS blijft werken,
// óók als er (nog) geen devcontainers zijn. De settling-runs vangen bovendien de
// devcontainer-net-connect op die `huddle init` pas ná de start uitvoert.
initContainerNetworks().finally(() => { void sanitizeResolvConf(); });
scheduleSettlingSanitize();
initContainerIptables();
