// Attaching the gateway container to the devcontainers it must filter.
//
// Each devcontainer Huddle starts gets its own `--internal` network,
// dc-net-<name>, and the gateway has to be ON that network or the devcontainer
// cannot reach `huddle` at all: no proxy, no firewall, no egress. The
// devcontainer's own iptables then DNAT port 80 to whatever `huddle` resolves
// to, which means the rules go stale the moment the gateway container is
// replaced and gets a new IP.
//
// Both halves used to be a boot concern and nothing more, because the gateway
// WAS Huddle: by the time this code ran, the container it wires up was the one
// running it. After the split that is exactly backwards — Huddle Node boots
// first and `huddle init` creates the gateway container seconds later — so
// wiring at Node's boot attaches nothing and refreshes iptables to an address
// that does not exist yet. Worse, it does so silently: the refresh script exits
// 0 when `huddle` does not resolve, so it still logs success.
//
// Hence one function, callable whenever the gateway container has (re)appeared:
// at boot, and from /api/docker/rewire-gateway when init has just created it.

import { listDevcontainers, networkExists, connectNetwork, refreshContainerIptables, refreshContainerCa } from './docker';

export interface RewireReport {
  /** Devcontainers seen. */
  containers: number;
  /** dc-net-<name> networks the gateway is now attached to. */
  attached: string[];
  /** Devcontainers whose iptables were refreshed against the current gateway IP. */
  refreshed: string[];
  /** Devcontainers that were handed a root CA they did not already trust. */
  reissued: string[];
}

/**
 * Attach the gateway to every existing devcontainer network, then point those
 * devcontainers' iptables at it.
 *
 * Best-effort per container: one devcontainer that has gone away must not stop
 * the others from being wired up. Idempotent — connecting a network the gateway
 * is already on, and rebuilding iptables that are already correct, both no-op.
 */
export async function rewireGatewayIntoDevcontainers(): Promise<RewireReport> {
  const report: RewireReport = { containers: 0, attached: [], refreshed: [], reissued: [] };

  let containers;
  try {
    containers = await listDevcontainers();
  } catch (err: any) {
    console.error('[wiring] could not list devcontainers:', err.message);
    return report;
  }
  report.containers = containers.length;
  const running = containers.filter((c) => c.running);

  for (const c of containers) {
    const netName = `dc-net-${c.name}`;
    try {
      if (await networkExists(netName)) {
        await connectNetwork(netName, 'huddle');
        report.attached.push(netName);
      }
    } catch (err: any) {
      // Already attached is the common case and not a problem.
      if (String(err.message).includes('already exists in network')) report.attached.push(netName);
      else console.error(`[wiring] ${netName}:`, err.message);
    }
  }

  // Only after the networks exist: the refresh resolves `huddle` from INSIDE the
  // devcontainer, so doing it first would resolve nothing and quietly do nothing.
  //
  // Running containers only, here and for the CA below. Both work by exec'ing
  // into the container, and the daemon answers 409 for one that is not running —
  // a stopped devcontainer would report a failure on every pass without anything
  // being wrong. It gets its rules and its CA when it starts.
  for (const c of running) {
    try {
      await refreshContainerIptables(c.id, c.name);
      report.refreshed.push(c.name);
    } catch (err: any) {
      console.error(`[wiring] iptables ${c.name}:`, err.message);
    }
  }

  // Routing a devcontainer to a gateway it does not trust is not connectivity.
  // The CA moved out of the gateway's volume and onto Huddle Node's host at the
  // split, so a container created before it still pins the previous root and
  // every HTTPS request fails the signature check. Same trigger as the rewiring
  // above because it is the same event: the enforcement point changed under a
  // container that is still running. See refreshContainerCa.
  for (const c of running) {
    try {
      if (await refreshContainerCa(c.id, c.name)) report.reissued.push(c.name);
    } catch (err: any) {
      console.error(`[wiring] CA ${c.name}:`, err.message);
    }
  }

  return report;
}
