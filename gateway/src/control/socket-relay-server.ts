// Huddle Node's end of the Docker-socket relay.
//
// An HTTP Upgrade on the control listener: the gateway asks for one
// devcontainer's socket, Node answers 101 and from there the connection IS the
// Docker stream — handed to exactly the same filter that serves a local Unix
// socket (../socket-proxy.ts). Nothing about what is allowed changes; only where
// the socket file lives. See ./socket-relay-protocol.ts for why it has to.

import type { Server } from 'http';
import type { IncomingMessage } from 'http';
import type net from 'net';
import { isGatewayAuthenticated } from '../auth';
import { containerProxyHandler, registerContainerProxy } from '../socket-proxy';
import { RELAY_PATH, RELAY_PROTOCOL } from './socket-relay-protocol';

/** Docker's own naming grammar — the name reaches path.join() in the registry. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function refuse(socket: net.Socket, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
}

function requestedName(req: IncomingMessage): string | null {
  const url = new URL(req.url ?? '/', 'http://node.invalid');
  if (url.pathname !== RELAY_PATH) return null;
  const name = url.searchParams.get('name') ?? '';
  return CONTAINER_NAME_RE.test(name) ? name : null;
}

/**
 * Serve the relay on an existing HTTP server.
 *
 * Fastify's request hooks never see an Upgrade, so the control server's blanket
 * 401 does not cover this — the token is checked here, with the same function
 * and the same token, before a single byte of Docker protocol is accepted.
 */
export function attachSocketRelay(server: Server): void {
  server.on('upgrade', (req, socket: net.Socket, head: Buffer) => {
    const name = requestedName(req);
    if (!name) return refuse(socket, '404 Not Found');
    if (!isGatewayAuthenticated(req.headers)) return refuse(socket, '401 Unauthorized');
    if (String(req.headers.upgrade ?? '').toLowerCase() !== RELAY_PROTOCOL) {
      return refuse(socket, '400 Bad Request');
    }

    // The name comes off the control feed, so the container is one Node listed
    // itself — but register it before serving, because the filter answers
    // "is this one of ours?" out of that registry and an unregistered
    // devcontainer would be told it may not touch itself.
    void registerContainerProxy(name)
      .catch((err: Error) => {
        // Not fatal: the registry is a cache of Docker's answer, and a container
        // that vanished between the feed and now will fail the filter's own
        // lookups anyway. Serving is still the better outcome than a dead socket.
        console.warn(`[socket-relay] ${name}: could not register (${err.message})`);
      })
      .then(() => {
        socket.setNoDelay(true);
        socket.write(
          'HTTP/1.1 101 Switching Protocols\r\n' +
          'Connection: Upgrade\r\n' +
          `Upgrade: ${RELAY_PROTOCOL}\r\n\r\n`,
        );
        // Bytes the server already read past the headers. Putting them back
        // makes the socket indistinguishable from a fresh Unix connection, which
        // is what the filter is written against.
        if (head?.length) socket.unshift(head);
        containerProxyHandler(name)(socket);
      });
  });
}
