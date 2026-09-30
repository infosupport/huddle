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
import { containerSnapshot } from '../docker';
import { containerProxyHandler, registerContainerProxy } from '../socket-proxy';
import { authorizedDevcontainerNames } from './feed-build';
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
    // req.url is attacker-controlled and reaches `new URL(...)` below — a
    // malformed request line (bad escapes, stray control characters, an
    // embedded scheme/host that confuses the WHATWG parser) can make that
    // constructor throw. This listener runs synchronously off the 'upgrade'
    // event, so an uncaught throw here isn't just a failed request: Node
    // treats it as an uncaught exception on the process and takes the whole
    // Huddle Node down. Parse under try/catch and refuse rather than crash.
    let name: string | null;
    try {
      name = requestedName(req);
    } catch (err) {
      console.warn(`[socket-relay] malformed upgrade request (${(err as Error).message})`);
      return refuse(socket, '400 Bad Request');
    }
    if (!name) return refuse(socket, '404 Not Found');
    if (!isGatewayAuthenticated(req.headers)) return refuse(socket, '401 Unauthorized');
    if (String(req.headers.upgrade ?? '').toLowerCase() !== RELAY_PROTOCOL) {
      return refuse(socket, '400 Bad Request');
    }

    // The name is only a grammar-valid string at this point — nothing above
    // ties it to a container Node actually knows about. A gateway that is
    // compromised or has gained code execution could otherwise ask for any
    // name (a peer devcontainer, a host container) and reach the Docker
    // action filter under that identity. So before registering or serving
    // anything, check `name` against the same authorized set the container
    // feed itself is built from (./feed-build's authorizedDevcontainerNames)
    // — a fresh Docker snapshot per relay-open, not a cached feed, because
    // this endpoint is the actual authorization boundary and correctness here
    // matters more than the one extra Docker API call: buildContainerFeed()
    // already does this same containerSnapshot() call on every ~1s gateway
    // poll (see db.ts's note on it), and a relay upgrade happens far less
    // often than that.
    void containerSnapshot()
      .then(({ devcontainers: running }) => {
        if (!authorizedDevcontainerNames(running).has(name)) {
          refuse(socket, '403 Forbidden');
          return null;
        }
        // Register before serving: the filter answers "is this one of ours?"
        // out of socket-proxy's own registry, and an authorized-but-not-yet-
        // registered devcontainer would otherwise be told it may not touch
        // itself.
        return registerContainerProxy(name)
          .catch((err: Error) => {
            // Not fatal: the registry is a cache of Docker's answer, and a
            // container that vanished between the feed and now will fail the
            // filter's own lookups anyway. Serving is still the better
            // outcome than a dead socket. The authorization check above
            // (not this) is what keeps an unauthorized name out.
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
      })
      .catch((err: Error) => {
        console.warn(`[socket-relay] ${name}: authorization check failed (${err.message})`);
        refuse(socket, '500 Internal Server Error');
      });
  });
}
