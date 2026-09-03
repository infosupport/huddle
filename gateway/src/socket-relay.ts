// The gateway's end of the Docker-socket relay.
//
// Creates the Unix socket each devcontainer mounts, and forwards it to Huddle
// Node's filter over the control channel. It creates them because it runs ON the
// Docker engine — the one thing Huddle Node cannot be sure of — and it does
// nothing else with them: no parsing, no decisions, bytes in and bytes out. The
// filter that decides what a devcontainer may ask Docker for stays on Node, and
// that is deliberate. This process is the half a devcontainer can reach.
//
// See ./control/socket-relay-protocol.ts for the whole of the reasoning.

import fs from 'fs';
import http from 'http';
import net from 'net';
import path from 'path';
import { RELAY_PROTOCOL, relayUrl } from './control/socket-relay-protocol';

export interface RelayOptions {
  /** Directory on the engine host, bind-mounted here at the same path. */
  socketDir: string;
  /** Where Huddle Node's control listener is. */
  baseUrl: string;
  /** The gateway token — the relay is a control-channel client like any other. */
  token: string;
}

/** The socket servers this process owns, by container name. */
const servers = new Map<string, net.Server>();

/**
 * Docker's naming grammar: no slashes, no leading dot.
 *
 * The name arrives over the control channel and goes straight into path.join(),
 * so `..` or a leading `/` would put a socket outside socketDir. Huddle Node
 * checks it too (../socket-proxy.ts); this end checks it anyway, because it is
 * the end that creates files.
 */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function dial(opts: RelayOptions, containerName: string, client: net.Socket): void {
  const url = new URL(relayUrl(opts.baseUrl, containerName));
  const req = http.request({
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: 'GET',
    headers: {
      connection: 'Upgrade',
      upgrade: RELAY_PROTOCOL,
      authorization: `Bearer ${opts.token}`,
    },
  });

  req.on('upgrade', (_res, upstream, head) => {
    if (head?.length) client.write(head);
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
    // Only now does the client start flowing: a socket with no reader is paused,
    // so nothing the devcontainer sent while the upgrade was in flight is lost.
    upstream.pipe(client);
    client.pipe(upstream);
  });

  // A status instead of a 101 means Node refused us — a wrong token, or a
  // container it does not know. Nothing to forward, so say so once and close.
  req.on('response', (res) => {
    console.warn(`[socket-relay] ${containerName}: Huddle Node answered ${res.statusCode}`);
    res.resume();
    client.destroy();
  });
  req.on('error', (err: Error) => {
    console.warn(`[socket-relay] ${containerName}: ${err.message}`);
    client.destroy();
  });
  req.end();
}

function serve(opts: RelayOptions, containerName: string, onReady?: (name: string) => void): void {
  // A directory per container, mounted as a DIRECTORY into the devcontainer: a
  // bind of the socket file itself pins the inode, so after a restart (unlink +
  // new listen) the container would hold a mount of the dead old socket forever.
  const dir = path.join(opts.socketDir, containerName);
  const socketPath = path.join(dir, 'docker.sock');
  // The old flat path. Kept as a symlink so a devcontainer created before the
  // directory mount reaches the current socket after its own restart.
  const legacyPath = path.join(opts.socketDir, `${containerName}.sock`);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.error(`[socket-relay] cannot create ${dir}:`, (err as Error).message);
    return;
  }
  try { fs.unlinkSync(socketPath); } catch {}

  const server = net.createServer((client) => dial(opts, containerName, client));
  server.on('error', (err) => {
    console.error(`[socket-relay] ${containerName}: ${err.message}`);
    servers.delete(containerName);
  });
  server.listen(socketPath, () => {
    // The devcontainer runs as its own user, and the socket's only gate is which
    // container the file is mounted into — the same property the pre-split
    // socket had.
    try { fs.chmodSync(socketPath, 0o777); } catch {}
    try { fs.unlinkSync(legacyPath); } catch {}
    try { fs.symlinkSync(socketPath, legacyPath); } catch {}
    console.log(`[socket-relay] ${containerName} → ${socketPath}`);
    onReady?.(containerName);
  });
  servers.set(containerName, server);
}

/**
 * Bring the set of served sockets in line with the containers Node reports.
 *
 * Called on every container feed, so it has to be cheap and idempotent: only
 * genuinely new names get a listener, and a name that disappeared gets its
 * listener closed. The socket FILE stays behind on purpose — a stopped
 * devcontainer that starts again still has the old mount, and the next feed
 * re-listens on the same path.
 */
export function syncSocketRelay(opts: RelayOptions, containerNames: string[], onReady?: (name: string) => void): void {
  const wanted = new Set(containerNames.filter((name) => {
    if (CONTAINER_NAME_RE.test(name)) return true;
    console.error(`[socket-relay] refusing unsafe container name ${JSON.stringify(name)}`);
    return false;
  }));
  for (const [name, server] of servers) {
    if (!wanted.has(name)) {
      server.close();
      servers.delete(name);
    }
  }
  for (const name of wanted) {
    if (!servers.has(name)) serve(opts, name, onReady);
    else onReady?.(name);
  }
}

/** For tests: the names currently served. */
export function servedContainers(): string[] {
  return [...servers.keys()].sort();
}
