import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';

import { RELAY_PATH, RELAY_PROTOCOL } from '../src/control/socket-relay-protocol';

// Huddle Node's end of the relay (control/socket-relay-server.ts): the upgrade
// handler must not serve — or even register — a container name the current
// feed has not authorized, even when the caller holds a valid gateway bearer
// token and the name is otherwise grammar-valid. Regression coverage for the
// Aikido finding: a compromised/code-execution-capable gateway could
// previously ask for ANY name and reach the Docker filter under that
// identity, because only the token and the grammar were checked.

const GW_TOKEN = 'gateway-token-for-relay-tests';

// The set containerSnapshot() reports as currently running (IDE-labeled).
// Distinct from socket_registrations, which is exercised through the real db
// below — same as feed-build-socket-registration.test.ts.
let running: string[] = [];

vi.mock('../src/docker', () => ({
  containerSnapshot: async () => ({ byIp: new Map(), devcontainers: running, allNames: running }),
  currentNetworkGeneration: () => 0,
}));

const registerContainerProxy = vi.fn(async (_name: string) => {});
const containerProxyHandler = vi.fn((name: string) => (socket: net.Socket) => {
  socket.end(`served:${name}`);
});

vi.mock('../src/socket-proxy', () => ({
  registerContainerProxy: (name: string) => registerContainerProxy(name),
  containerProxyHandler: (name: string) => containerProxyHandler(name),
}));

let db: typeof import('../src/db').db;
let registerSocketName: typeof import('../src/db').registerSocketName;
let attachSocketRelay: typeof import('../src/control/socket-relay-server').attachSocketRelay;

beforeAll(async () => {
  process.env.HUDDLE_GATEWAY_TOKEN = GW_TOKEN;
  const dbMod = await import('../src/db');
  db = dbMod.db;
  registerSocketName = dbMod.registerSocketName;
  dbMod.initDb();
  ({ attachSocketRelay } = await import('../src/control/socket-relay-server'));
});

beforeEach(() => {
  running = [];
  db.exec('DELETE FROM socket_registrations');
  registerContainerProxy.mockClear();
  containerProxyHandler.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Perform a raw HTTP Upgrade for `name` and resolve with the status line and any body/bytes that followed. */
function upgrade(port: number, name: string, token = GW_TOKEN): Promise<{ status: string; data: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({
      port,
      path: `${RELAY_PATH}?name=${encodeURIComponent(name)}`,
      headers: {
        Connection: 'Upgrade',
        Upgrade: RELAY_PROTOCOL,
        Authorization: `Bearer ${token}`,
      },
    });
    req.on('upgrade', (res, socket, head: Buffer) => {
      // Bytes that arrived in the same packet as the 101 response land here,
      // not in a later 'data' event — same reason the relay itself unshifts
      // `head` back onto the socket in socket-relay-server.ts.
      let data = head?.length ? head.toString() : '';
      socket.on('data', (d) => { data += d.toString(); });
      socket.on('end', () => resolve({ status: `${res.statusCode}`, data }));
      socket.on('close', () => resolve({ status: `${res.statusCode}`, data }));
    });
    req.on('response', (res) => {
      let data = '';
      res.on('data', (d) => { data += d.toString(); });
      res.on('end', () => resolve({ status: `${res.statusCode}`, data }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function listen(): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer((_req, res) => res.end());
  attachSocketRelay(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: (server.address() as AddressInfo).port };
}

describe('attachSocketRelay — authorization', () => {
  it('refuses a grammar-valid, correctly-authenticated name the feed never authorized', async () => {
    const { server, port } = await listen();
    try {
      running = ['dc-alpha']; // some OTHER container is authorized
      const res = await upgrade(port, 'dc-victim');
      expect(res.status).toBe('403');
      // The whole point: an unauthorized name must never reach the registry or
      // the Docker filter, not even to be told no once inside it.
      expect(registerContainerProxy).not.toHaveBeenCalled();
      expect(containerProxyHandler).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('serves a name the feed authorizes via the running/IDE-labeled set', async () => {
    const { server, port } = await listen();
    try {
      running = ['dc-alpha'];
      const res = await upgrade(port, 'dc-alpha');
      expect(res.status).toBe('101');
      expect(res.data).toBe('served:dc-alpha');
      expect(registerContainerProxy).toHaveBeenCalledWith('dc-alpha');
      expect(containerProxyHandler).toHaveBeenCalledWith('dc-alpha');
    } finally {
      server.close();
    }
  });

  it('serves a name authorized only via a socket registration (not yet running)', async () => {
    const { server, port } = await listen();
    try {
      running = [];
      registerSocketName('compose-api');
      const res = await upgrade(port, 'compose-api');
      expect(res.status).toBe('101');
      expect(registerContainerProxy).toHaveBeenCalledWith('compose-api');
    } finally {
      server.close();
    }
  });

  it('still requires the gateway token even for an authorized name', async () => {
    const { server, port } = await listen();
    try {
      running = ['dc-alpha'];
      const res = await upgrade(port, 'dc-alpha', 'wrong-token');
      expect(res.status).toBe('401');
      expect(registerContainerProxy).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });
});
