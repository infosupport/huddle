import { initDb } from './db';
import { createProxyServer } from './proxy';
import { createApiServer } from './api';
import { listDevcontainers } from './docker';
import { createContainerProxy } from './socket-proxy';

const SOCKET_DIR = '/tmp/dc-sockets';

initDb();
createProxyServer();
createApiServer();

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

initContainerProxies();
