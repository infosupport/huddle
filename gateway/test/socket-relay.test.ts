import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

import { syncSocketRelay, servedContainers } from '../src/socket-relay';
import { RELAY_PATH, RELAY_PROTOCOL, relayUrl } from '../src/control/socket-relay-protocol';

// The relay end to end, minus the filter: a Unix socket the gateway creates on
// the engine host, tunnelled to Huddle Node over an HTTP Upgrade. No database
// and no Docker — the point of splitting the protocol into its own module is
// that this half can be driven without either.

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-relay-'));

/** Stand-in for Huddle Node's control listener: echoes the container name back. */
function fakeNode(): Promise<{ url: string; close(): void; seen: string[] }> {
  const seen: string[] = [];
  const server = http.createServer((_req, res) => res.end());
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname !== RELAY_PATH) return socket.end('HTTP/1.1 404 Not Found\r\n\r\n');
    if (req.headers.authorization !== 'Bearer gw-token') {
      return socket.end('HTTP/1.1 401 Unauthorized\r\n\r\n');
    }
    const name = url.searchParams.get('name') ?? '';
    seen.push(name);
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${RELAY_PROTOCOL}\r\n\r\n`,
    );
    if (head?.length) socket.unshift(head);
    socket.on('data', (d) => socket.write(`${name}:${d.toString()}`));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as net.AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close(), seen });
    });
  });
}

function talk(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(socketPath, () => c.write(payload));
    c.on('data', (d) => { resolve(d.toString()); c.destroy(); });
    c.on('error', reject);
    setTimeout(() => reject(new Error('timed out')), 3000).unref?.();
  });
}

/** Connect, write, and report every byte that came back before the close. */
function closedWithout(socketPath: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = '';
    const c = net.createConnection(socketPath, () => c.write(payload));
    c.on('data', (d) => { got += d.toString(); });
    c.on('close', () => resolve(got));
    c.on('error', reject);
  });
}

/**
 * Wait for the listener the sync started; listen() is async.
 *
 * On the socket path AND the compat symlink, not just the socket: listen()
 * creates the socket file before its own callback runs, so waiting on the socket
 * alone can win the race against everything that callback still does.
 */
async function settle(socketPath: string): Promise<void> {
  const legacy = `${path.dirname(socketPath)}.sock`;
  for (let i = 0; i < 100; i++) {
    if (fs.existsSync(socketPath) && fs.existsSync(legacy)) return;
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  syncSocketRelay({ socketDir: tmp, baseUrl: 'http://127.0.0.1:1', token: 't' }, []);
  vi.restoreAllMocks();
});

describe('relay URL', () => {
  it('names the container in the query, escaped', () => {
    expect(relayUrl('http://node:24843/', 'dc-a.b_c')).toBe(
      'http://node:24843/control/docker-socket?name=dc-a.b_c',
    );
  });
});

describe('socket relay', () => {
  it('serves a socket per devcontainer and pipes it to Huddle Node', async () => {
    const node = await fakeNode();
    const opts = { socketDir: tmp, baseUrl: node.url, token: 'gw-token' };

    syncSocketRelay(opts, ['dc-alpha']);
    const sock = path.join(tmp, 'dc-alpha', 'docker.sock');
    await settle(sock);

    // The container name is the gateway's, bound to the socket path — nothing
    // the caller sent. Whatever it writes comes back tagged with that name.
    expect(await talk(sock, 'GET /_ping')).toBe('dc-alpha:GET /_ping');
    expect(node.seen).toEqual(['dc-alpha']);
    node.close();
  });

  it('adds and drops listeners as the feed changes, and is idempotent', async () => {
    const node = await fakeNode();
    const opts = { socketDir: tmp, baseUrl: node.url, token: 'gw-token' };

    syncSocketRelay(opts, ['dc-one', 'dc-two']);
    await settle(path.join(tmp, 'dc-two', 'docker.sock'));
    expect(servedContainers()).toEqual(['dc-one', 'dc-two']);

    // The same feed again must not tear down and re-listen: every poll calls this.
    syncSocketRelay(opts, ['dc-one', 'dc-two']);
    expect(servedContainers()).toEqual(['dc-one', 'dc-two']);

    syncSocketRelay(opts, ['dc-one']);
    expect(servedContainers()).toEqual(['dc-one']);
    node.close();
  });

  it('closes the client when Huddle Node refuses the token', async () => {
    const node = await fakeNode();
    syncSocketRelay({ socketDir: tmp, baseUrl: node.url, token: 'wrong' }, ['dc-bad']);
    const sock = path.join(tmp, 'dc-bad', 'docker.sock');
    await settle(sock);
    // Not a hang and not a forwarded byte: a refused upgrade ends the connection
    // rather than leaving a devcontainer's docker client waiting on a socket that
    // will never answer.
    expect(await closedWithout(sock, 'GET /_ping')).toBe('');
    node.close();
  });
});

// The layout the devcontainer mounts. It moved here with the socket itself: a
// bind of the socket FILE pins the inode, so after a restart (unlink + new
// listen) the container would hold a mount of the dead old socket forever. The
// per-container directory is what survives that, and the flat `<name>.sock`
// symlink is what containers created before it still reach the socket through.
describe('socket layout', () => {
  it('serves <dir>/<name>/docker.sock with a symlink on the old flat path', async () => {
    const node = await fakeNode();
    const opts = { socketDir: tmp, baseUrl: node.url, token: 'gw-token' };

    syncSocketRelay(opts, ['dc-layout']);
    const sock = path.join(tmp, 'dc-layout', 'docker.sock');
    await settle(sock);

    expect(fs.statSync(sock).isSocket()).toBe(true);
    const legacy = path.join(tmp, 'dc-layout.sock');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacy)).toBe(sock);
    // Reaching it through the symlink has to work too, or the compat is a lie.
    expect(await talk(legacy, 'ping')).toBe('dc-layout:ping');
    node.close();
  });

  it('re-listens on the same path after a restart', async () => {
    const node = await fakeNode();
    const opts = { socketDir: tmp, baseUrl: node.url, token: 'gw-token' };
    const sock = path.join(tmp, 'dc-restart', 'docker.sock');

    syncSocketRelay(opts, ['dc-restart']);
    await settle(sock);
    expect(await talk(sock, 'one')).toBe('dc-restart:one');

    // Drop and re-add, which is what a devcontainer restart looks like in the feed.
    syncSocketRelay(opts, []);
    syncSocketRelay(opts, ['dc-restart']);
    await settle(sock);
    expect(fs.statSync(sock).isSocket()).toBe(true);
    expect(await talk(sock, 'two')).toBe('dc-restart:two');
    node.close();
  });

  // The name arrives over the control channel and goes into path.join(). Huddle
  // Node checks it as well; this end checks it anyway, because this is the end
  // that creates files.
  it('refuses a name that could escape the socket directory', () => {
    const opts = { socketDir: tmp, baseUrl: 'http://127.0.0.1:1', token: 't' };
    syncSocketRelay(opts, ['../evil', 'a/b', '..', '.hidden', '/abs', 'foo/../bar']);
    expect(servedContainers()).toEqual([]);
    expect(fs.existsSync(path.join(tmp, '..', 'evil'))).toBe(false);
  });
});
