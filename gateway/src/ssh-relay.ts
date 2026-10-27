import net from 'net';
import { logAudit } from './db';

// ── Per-devcontainer SSH relay ───────────────────────────────────────────────
// A dumb TCP pipe: <gateway>:<port> → <container on dc-net-*>:22. No SSH is
// implemented here, so the gateway adds no protocol attack surface; sshd in the
// container does authentication. `huddle init` publishes the port range on the
// host's 127.0.0.1 only.
//
// The gateway is ALSO reachable from every devcontainer (huddle:<port> on its
// dc-net), so a connection whose source IP is a container is refused: otherwise
// devcontainer A could reach devcontainer B's sshd. Host connections arrive via
// the engine's port forwarder from a bridge-gateway IP, which is never a
// container IP. The lookup is fresh per connection and fails closed.

export interface SshRelayDeps {
  /** True when `ip` belongs to any container. Throwing counts as "yes" (fail closed). */
  isContainerIp(ip: string): Promise<boolean>;
  /** IP of the container on its own dc-net, or null when it is not running. */
  resolveTarget(containerName: string): Promise<string | null>;
  /** sshd port in the container; only overridden by tests. */
  targetPort?: number;
}

const relays = new Map<string, { port: number; server: net.Server }>();

export function sshRelayPort(containerName: string): number | null {
  return relays.get(containerName)?.port ?? null;
}

/** Start the relay for `containerName` on `port` (no-op when it already runs there). */
export async function ensureSshRelay(containerName: string, port: number, deps: SshRelayDeps): Promise<void> {
  const existing = relays.get(containerName);
  if (existing?.port === port) return;
  if (existing) await closeSshRelay(containerName);

  const server = net.createServer((client) => handleConnection(containerName, client, deps));
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', (err) => console.warn(`[ssh-relay] ${containerName}: ${err.message}`));
  relays.set(containerName, { port, server });
  console.log(`[ssh-relay] ${containerName} on port ${port}`);
}

export async function closeSshRelay(containerName: string): Promise<void> {
  const relay = relays.get(containerName);
  if (!relay) return;
  relays.delete(containerName);
  await new Promise<void>((resolve) => relay.server.close(() => resolve()));
}

function handleConnection(containerName: string, client: net.Socket, deps: SshRelayDeps): void {
  // Until the pipe is set up no 'data' listener exists, so the SSH banner the
  // client sends is buffered rather than lost.
  client.on('error', () => client.destroy());
  const remote = (client.remoteAddress ?? '').replace(/^::ffff:/, '');
  void (async () => {
    let fromContainer = true;
    try { fromContainer = await deps.isContainerIp(remote); } catch { /* fail closed */ }
    if (fromContainer) {
      logAudit({ containerId: containerName, domain: 'ssh', action: 'ssh:deny-container-source' });
      client.destroy();
      return;
    }
    let target: string | null = null;
    try { target = await deps.resolveTarget(containerName); } catch { /* not running */ }
    if (!target || client.destroyed) { client.destroy(); return; }

    const upstream = net.connect(deps.targetPort ?? 22, target);
    upstream.on('error', () => client.destroy());
    upstream.on('close', () => client.destroy());
    client.on('close', () => upstream.destroy());
    client.pipe(upstream);
    upstream.pipe(client);
    logAudit({ containerId: containerName, domain: 'ssh', action: 'ssh:connect' });
  })();
}
