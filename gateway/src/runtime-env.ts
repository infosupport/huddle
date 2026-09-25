// ── Runtime bindings: where this process finds the world ──────────────────────
// Huddle is being split into two runtimes (docs/ADR-huddle-node-split.md):
//
//   Huddle Node     — the application (portal, API, Docker orchestration, sbx),
//                     running directly on the user's HOST.
//   huddle-gateway  — the network enforcement point, staying in Docker.
//
// There are exactly TWO configurations, and no third: Huddle Node runs on the
// host, huddle-gateway runs in the container. Every value that differs between
// them used to be a literal scattered across db.ts, auth.ts, api.ts, docker.ts,
// terminal.ts, socket-proxy.ts, tls-ca.ts and extensions/loader.ts — some
// env-overridable, some not (API_PORT, SOCKET_DIR and nine copies of
// /var/run/docker.sock). That made "run this half over there" a matter of
// guessing which env vars exist.
//
// This module is the single answer to that question. It resolves the ROLE the
// process plays and every path/port binding once, at import time, from:
//
//   1. an explicit env var  — always wins;
//   2. the role default     — host layout for `node`, container layout for `gateway`.
//
// The role IS the deployment: there is no separate "host mode" switch, because
// the two never crossed in practice — a Node in a container has no Docker to
// orchestrate and no sbx to exec, and a gateway on the host is not an
// enforcement point. `hostMode` is therefore derived, kept only because a dozen
// call sites read better asking "am I on the host" than "is my role node".
//
// It imports nothing from the rest of the gateway (db.ts pulls it in first), so
// it can never participate in an import cycle.

import os from 'os';
import path from 'path';

/**
 * Which half of the split this process is running.
 *
 *  - `node`    — Huddle Node on the host: portal/API, Docker orchestration,
 *                config, extensions, sbx. Owns the database. No proxies.
 *  - `gateway` — the enforcement point in the container: the filtering proxies
 *                and nothing else. No database, no Docker socket, no API.
 *
 * Defaults to `node` because that is what a bare `node dist/index.js` on a
 * developer's machine should be; the image sets HUDDLE_ROLE=gateway explicitly.
 */
export type HuddleRole = 'node' | 'gateway';

const VALID_ROLES: readonly HuddleRole[] = ['node', 'gateway'];

function parseRole(raw: string | undefined): HuddleRole {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'node';
  if ((VALID_ROLES as readonly string[]).includes(value)) return value as HuddleRole;
  throw new Error(`HUDDLE_ROLE must be one of ${VALID_ROLES.join(' | ')} — got "${raw}"`);
}

function parsePort(raw: string | undefined, fallback: number, name: string): number {
  const value = (raw ?? '').trim();
  if (!value) return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name} must be a TCP port between 1 and 65535 — got "${raw}"`);
  }
  return port;
}

export interface RuntimeEnv {
  role: HuddleRole;
  /** Runs the network data plane: the :80 and sbx egress proxies. */
  runsGateway: boolean;
  /** Runs the control plane: API, UI, Docker orchestration, sbx, config. */
  runsNode: boolean;
  /** True when this process runs directly on the user's machine. Derived from the role. */
  hostMode: boolean;
  /** Portal + REST/WS API. */
  apiPort: number;
  /**
   * Interface the portal/API listens on. Loopback in host mode — see
   * resolveRuntimeEnv for why that is not the same choice as in a container.
   */
  apiBindHost: string;
  /** Port the control channel listens on (Node) — never the portal's. */
  controlPort: number;
  /** Interface the control channel listens on. See resolveRuntimeEnv. */
  controlBindHost: string;
  /** Base URL the gateway reaches Node's control channel on. Gateway-side only. */
  nodeControlUrl: string;
  /** The filtering proxy devcontainers are DNAT'ed to. Gateway-side only. */
  proxyPort: number;
  /** Dedicated egress proxy for sbx sandboxes. Gateway-side only. */
  sbxProxyPort: number;
  /** Docker Engine API endpoint (a named pipe on Windows in host mode). */
  dockerSocketPath: string;
  /**
   * Directory on the Docker ENGINE host where each devcontainer's filtered
   * socket is served. Not host-mode dependent: on Windows the engine host is the
   * WSL/Docker Desktop VM, so this stays a Linux path in both modes.
   */
  socketDir: string;
  /** Writable state: SQLite, the MITM CA, uploaded extensions. */
  dataDir: string;
  dbPath: string;
  caDir: string;
  extDir: string;
  /** Where `~/.huddle/config.json` is readable — a bind mount in container mode. */
  homeDir: string;
  /**
   * Fallback mount points for the two team-managed folders (#69), for container
   * mode and for an explicit environment override. In host mode neither is used:
   * Huddle Node reads both folders straight out of ~/.huddle/config.json, per
   * call — see firewall-rules-folder.ts and extensions/loader.ts.
   */
  firewallRulesMount: string;
  teamExtDir: string;
}

/**
 * Resolve every binding from an environment. Exported (rather than only the
 * singleton) so tests can assert both modes without mutating `process.env`.
 */
export function resolveRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const role = parseRole(env.HUDDLE_ROLE);
  // Derived, not configured: `node` is the host half by definition.
  const hostMode = role === 'node';

  // In host mode Huddle owns ~/.huddle outright: it is both the state directory
  // and the config directory the CLI already writes (cli/src/config.ts).
  const huddleHome = path.join(os.homedir(), '.huddle');
  const dataDir = env.HUDDLE_DATA_DIR?.trim() || (hostMode ? huddleHome : '/data');
  const homeDir = env.HUDDLE_HOME_DIR?.trim() || (hostMode ? huddleHome : '/huddle-home');

  // Host mode listens on Huddle Node's own port so it never collides with a
  // gateway container that still publishes 3000.
  const apiPort = parsePort(env.HUDDLE_API_PORT, hostMode ? 24842 : 3000, 'HUDDLE_API_PORT');

  // 0.0.0.0 means something different on each side of the split, which is why
  // this is a binding and not a literal.
  //
  // In the container it is the only option: Docker reaches the API through the
  // container's own veth address, and what the OUTSIDE world can see is decided
  // by `-p 3000:3000` on the host — not here.
  //
  // On the host there is no such publish step, so 0.0.0.0 would put Huddle Node
  // on every interface the machine has, including the LAN and any VPN. Huddle
  // Node is not a portal with a read-only view: it execs into containers, runs
  // terminals and rewrites firewall policy. The operator token is the only thing
  // between that and the network, and one shared secret should not be the sole
  // barrier for an interface nobody meant to open. So host mode binds loopback.
  //
  // The gateway container cannot reach a loopback-bound Node on Linux, where
  // host.docker.internal resolves to the bridge address rather than the host's
  // loopback. That is precisely why the control channel is a SEPARATE listener
  // (controlPort/controlBindHost below) instead of another route on this one:
  // widening the portal to reach the gateway would put the operator token's
  // surface on the bridge, where every container on the default network could
  // knock on it. The portal stays loopback; only the control channel moves.
  const apiBindHost = env.HUDDLE_API_HOST?.trim() || (hostMode ? '127.0.0.1' : '0.0.0.0');

  // Windows has no Unix socket for the engine; Node accepts the named pipe as a
  // socketPath verbatim. Irrelevant in container mode, where the CLI bind-mounts
  // whichever socket the runtime uses onto /var/run/docker.sock.
  const defaultDockerSocket =
    hostMode && process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';

  return {
    role,
    runsGateway: role === 'gateway',
    runsNode: role === 'node',
    hostMode,
    apiPort,
    apiBindHost,
    controlPort: parsePort(env.HUDDLE_CONTROL_PORT, 24843, 'HUDDLE_CONTROL_PORT'),
    // Loopback by default. `huddle init` overrides this with the Docker bridge
    // address on Linux, where that is the only address the gateway container can
    // reach the host on. Devcontainers cannot: their network is --internal and
    // therefore has no route off itself.
    controlBindHost: env.HUDDLE_CONTROL_HOST?.trim() || '127.0.0.1',
    // Where the GATEWAY finds Node. host.docker.internal is provided by Docker
    // Desktop and injected by `huddle init` (--add-host=…:host-gateway) on Linux.
    nodeControlUrl: env.HUDDLE_NODE_CONTROL_URL?.trim() || 'http://host.docker.internal:24843',
    proxyPort: parsePort(env.HUDDLE_PROXY_PORT, 80, 'HUDDLE_PROXY_PORT'),
    sbxProxyPort: parsePort(env.HUDDLE_SBX_PROXY_PORT, 32768, 'HUDDLE_SBX_PROXY_PORT'),
    dockerSocketPath: env.HUDDLE_DOCKER_SOCKET?.trim() || defaultDockerSocket,
    socketDir: env.HUDDLE_SOCKET_DIR?.trim() || '/tmp/dc-sockets',
    dataDir,
    dbPath: env.DB_PATH?.trim() || path.join(dataDir, 'huddle.db'),
    // Node generates the CA and owns it; the gateway only SIGNS leaf certs with
    // it and gets the directory bind-mounted read-only at /ca. One CA, one
    // writer — two halves each minting their own root would validate nothing.
    //
    // Its own subdirectory, not dataDir: the gateway needs ca.key as well as
    // ca.crt to sign with, so this directory is what gets mounted. dataDir also
    // holds the SQLite database and the operator token, and handing those to the
    // half a devcontainer can reach — read-only or not — would give back exactly
    // what the split took away.
    caDir: env.CA_DIR?.trim() || (hostMode ? path.join(dataDir, 'ca') : '/ca'),
    extDir: env.EXT_DIR?.trim() || path.join(dataDir, 'extensions'),
    homeDir,
    firewallRulesMount: env.HUDDLE_FIREWALL_RULES_MOUNT?.trim() || '/firewall-rules',
    teamExtDir: env.HUDDLE_EXTENSIONS_MOUNT?.trim() || '/extensions',
  };
}

/** The bindings for this process. Resolved once, at import. */
export const runtimeEnv: RuntimeEnv = resolveRuntimeEnv();
