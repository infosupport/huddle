// The wire between the gateway's Unix socket and Huddle Node's Docker filter.
//
// A devcontainer gets its Docker access through a Unix socket bind-mounted into
// it, and that socket has to exist on the DOCKER ENGINE's host. Before the split
// it did: the process serving it was the gateway container, which runs on the
// engine. Huddle Node runs on the operator's machine instead — the same machine
// only when the engine is native Linux. On Docker Desktop, Rancher and `podman
// machine` the engine is in a VM, so Node would create the socket on
// macOS/Windows while the devcontainer mounts it out of the VM and the two never
// meet. On Windows it does not even get that far: Node's `net` has no AF_UNIX
// server, so `listen('/tmp/dc-sockets/…/docker.sock')` fails with EACCES and
// takes container creation down with it.
//
// So the two halves each do the part they can. The gateway creates the socket,
// because it lives on the engine. Node runs the filter, because the filter is
// the security boundary and belongs outside the container it protects. Between
// them: an HTTP Upgrade on the control port — the port the gateway already has
// a token for and already knows how to reach, rather than a second listener to
// find, authorise and punch through a host firewall.
//
// Types and constants only, so both halves can name the same protocol without
// the gateway importing Node's Docker code.

/** The control-channel path a socket connection is tunnelled over. */
export const RELAY_PATH = '/control/docker-socket';

/** The Upgrade token. Anything else on this path is not a relay client. */
export const RELAY_PROTOCOL = 'huddle-docker-socket';

/**
 * The URL the gateway opens for one devcontainer's socket connection.
 *
 * The container name is the gateway's assertion, and it may assert it because
 * it learned the name from the control feed and bound it to a socket path — not
 * because anything the caller sent said so. A devcontainer connecting to its own
 * mounted socket cannot name a different container: the name is fixed by which
 * socket file it opened.
 */
export function relayUrl(baseUrl: string, containerName: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${RELAY_PATH}?name=${encodeURIComponent(containerName)}`;
}
