// Where huddle-gateway finds Huddle Node.
//
// The gateway follows Huddle Node's control channel (policy in, decisions out).
// Node runs on the host now, so this is a container→host call, and how a
// container reaches its host is the one thing that genuinely differs per engine:
//
//   Engine in a VM (Docker Desktop, Rancher, `podman machine`)
//       `host.docker.internal` is routed to the real host, and a process bound
//       to the host's LOOPBACK is reachable through it. Node keeps 127.0.0.1.
//
//   Engine native on Linux (docker/podman on the same kernel)
//       There is no such routing: the container sees the host only as the bridge
//       gateway address (172.17.0.1 for Docker's `bridge`, 10.88.0.1 for
//       Podman's `podman`). A loopback-bound listener is simply not reachable,
//       so the control channel has to bind that address.
//
// Only the CONTROL channel moves. The portal and the REST API stay on loopback
// in both cases — they carry the operator token, which opens container
// terminals, execs and policy writes. The control channel carries a second,
// narrower token (gateway/src/auth.ts) and is the only thing worth exposing to
// the bridge. Devcontainers cannot reach even that: their network is `--internal`
// and has no route off itself.

import { execFileSync } from 'child_process';

export interface ControlAddress {
  /** HUDDLE_CONTROL_HOST for Huddle Node — the interface the control channel binds. */
  bindHost: string;
  /** HUDDLE_NODE_CONTROL_URL for the gateway — where it goes looking. */
  url: string;
  /** Extra `docker run` arguments needed to make that URL resolve. */
  runArgs: string[];
  /** Why this address was chosen, for the init log. */
  reason: string;
  /**
   * Do we believe the gateway container can actually reach this? False in the
   * one case we cannot resolve — see derive() — where init must say so out loud
   * rather than let the operator discover it as a firewall that denies
   * everything.
   */
  reachable: boolean;
}

export const HOST_ALIAS = 'host.docker.internal';

/**
 * Pull the bridge gateway address out of `network inspect` JSON.
 *
 * Two shapes, because the engines disagree: Docker nests it under
 * `IPAM.Config[].Gateway`, Podman under `subnets[].gateway`. Parsing the JSON
 * rather than passing a Go template is what makes one code path serve both.
 *
 * Pure, so the shapes can be tested without an engine.
 */
export function parseBridgeGateway(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!entry || typeof entry !== 'object') return null;

  const docker = (entry as { IPAM?: { Config?: unknown } }).IPAM?.Config;
  const podman = (entry as { subnets?: unknown }).subnets;
  const rows = Array.isArray(docker) ? docker : Array.isArray(podman) ? podman : [];

  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = (row as { Gateway?: unknown; gateway?: unknown }).Gateway
      ?? (row as { gateway?: unknown }).gateway;
    if (typeof value === 'string' && isIpLiteral(value)) return value;
  }
  return null;
}

/**
 * An IP literal and nothing else. This value ends up as a bind address and
 * inside a `-e HUDDLE_NODE_CONTROL_URL=...` argument, and it comes from whatever
 * the engine reports — so a hostname, a CIDR suffix or anything with a shell
 * metacharacter in it is rejected rather than passed on.
 */
function isIpLiteral(value: string): boolean {
  const v = value.trim();
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(v)) {
    return v.split('.').every((o) => Number(o) <= 255);
  }
  return /^[0-9a-fA-F:]+$/.test(v) && v.includes(':');
}

/** Ask the engine for the default network's gateway address. Best-effort. */
export function bridgeGateway(rt: string, network: string): string | null {
  try {
    const out = execFileSync(rt, ['network', 'inspect', network], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 15_000,
    });
    return parseBridgeGateway(out);
  } catch {
    return null;
  }
}

export interface ControlAddressInput {
  /** Does the engine run in a VM? (ContainerRuntime.isRemote) */
  isRemote: boolean;
  /** The control channel's port on the host. */
  port: number | string;
  /** The engine's bridge gateway address, if it could be determined. */
  gatewayIp: string | null;
  /** An explicit HUDDLE_NODE_CONTROL_URL, which always wins. */
  override?: string;
  /** An explicit HUDDLE_CONTROL_HOST, which always wins for the bind side. */
  bindOverride?: string;
}

/** Bracket a literal IPv6 host for use in a URL, the way every other http://host:port here does. */
function formatHost(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/**
 * Decide the pair (bind host, URL) from what we know about the engine. Pure —
 * the engine probing happens in bridgeGateway() above.
 */
export function resolveControlAddress(input: ControlAddressInput): ControlAddress {
  const override = input.override?.trim();
  const bindOverride = input.bindOverride?.trim();
  const derived = derive(input);

  // HUDDLE_CONTROL_HOST moves where Node binds; unless HUDDLE_NODE_CONTROL_URL
  // says otherwise too, the URL handed to the gateway has to move with it. Left
  // pinned to the auto-derived URL, Node ends up listening on the overridden
  // host while the gateway keeps probing the stale one — and being fail-closed,
  // denies every request. HUDDLE_NODE_CONTROL_URL, when given, still wins: it is
  // the more specific override and may legitimately name something other than
  // the bind host (a different port, a tunnel, host.docker.internal itself).
  const url = override || (bindOverride ? `http://${formatHost(bindOverride)}:${input.port}` : derived.url);

  return {
    ...derived,
    bindHost: bindOverride || derived.bindHost,
    url,
    reason: override || bindOverride
      ? 'set explicitly via HUDDLE_NODE_CONTROL_URL / HUDDLE_CONTROL_HOST'
      : derived.reason,
    // Whoever set it explicitly knows their own topology better than we do.
    reachable: derived.reachable || !!override || !!bindOverride,
    // Either override may name something other than the alias; adding a host
    // entry for a name nobody asked about would be noise at best.
    runArgs: (override || bindOverride) ? [] : derived.runArgs,
  };
}

function derive(input: ControlAddressInput): ControlAddress {
  const { port } = input;

  if (input.isRemote) {
    return {
      bindHost: '127.0.0.1',
      url: `http://${HOST_ALIAS}:${port}`,
      // Docker Desktop provides the alias already; Podman machine and Rancher
      // are less consistent about it, and asking for it twice costs nothing.
      runArgs: ['--add-host', `${HOST_ALIAS}:host-gateway`],
      reason: 'the engine runs in a VM, so the host is reachable on its loopback',
      reachable: true,
    };
  }

  if (input.gatewayIp) {
    return {
      bindHost: input.gatewayIp,
      url: `http://${formatHost(input.gatewayIp)}:${port}`,
      runArgs: [],
      reason: `native engine — the container reaches this host at ${input.gatewayIp}`,
      reachable: true,
    };
  }

  // Native engine, and we could not read the bridge address — so there is no
  // address we can honestly name. Loopback is deliberate: 0.0.0.0 would put the
  // control channel on the LAN and any VPN to fix a problem we have not even
  // confirmed. The gateway then reaches nothing and, being fail-closed, denies
  // every request until an operator sets HUDDLE_CONTROL_HOST. A visibly dead
  // firewall beats a quietly widened one.
  return {
    bindHost: '127.0.0.1',
    url: `http://${HOST_ALIAS}:${port}`,
    runArgs: ['--add-host', `${HOST_ALIAS}:host-gateway`],
    reason: 'the bridge gateway address could not be read from the engine',
    reachable: false,
  };
}
