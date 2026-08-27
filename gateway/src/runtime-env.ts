// ── Runtime bindings: where this process finds the world ──────────────────────
// Huddle is being split into two runtimes (docs/ADR-huddle-node-split.md):
//
//   Huddle Node     — the application (portal, API, Docker orchestration, sbx),
//                     running directly on the user's HOST.
//   huddle-gateway  — the network enforcement point, staying in Docker.
//
// Until that split lands, one process still plays both roles. Every value that
// differs between "inside the gateway container" and "on the host" used to be a
// literal scattered across db.ts, auth.ts, api.ts, docker.ts, terminal.ts,
// socket-proxy.ts, tls-ca.ts and extensions/loader.ts — some env-overridable,
// some not (API_PORT, SOCKET_DIR and nine copies of /var/run/docker.sock). That
// made "run the gateway on the host" a matter of guessing which env vars exist.
//
// This module is the single answer to that question. It resolves the ROLE the
// process plays and every path/port binding once, at import time, from:
//
//   1. an explicit env var        — always wins, in either mode;
//   2. the mode default           — container (today) or host (HUDDLE_HOST_MODE=1).
//
// Container defaults are byte-identical to the literals they replace, so an
// unmodified `huddle init` against an unmodified image behaves exactly as before.
// It imports nothing from the rest of the gateway (db.ts pulls it in first), so
// it can never participate in an import cycle.

import os from 'os';
import path from 'path';

/**
 * Which half of the split this process is running.
 *
 *  - `all`     — one process does everything (today's behaviour, the default).
 *  - `node`    — Huddle Node: portal/API, Docker orchestration, sbx. No proxies.
 *  - `gateway` — the enforcement point: filtering proxies only.
 *
 * Nothing branches on this yet; startup gating is the next step. It lives here
 * so there is exactly one parser for it.
 */
export type HuddleRole = 'all' | 'node' | 'gateway';

const VALID_ROLES: readonly HuddleRole[] = ['all', 'node', 'gateway'];

function parseRole(raw: string | undefined): HuddleRole {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return 'all';
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
  /** True when Huddle runs directly on the user's machine instead of in the gateway container. */
  hostMode: boolean;
  /** Portal + REST/WS API. */
  apiPort: number;
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
  /** Team-managed firewall-rules folder. Absent is fine; callers report "not mounted". */
  firewallRulesMount: string;
  /** Team-managed extensions folder. Absent is fine. */
  teamExtDir: string;
}

/**
 * Resolve every binding from an environment. Exported (rather than only the
 * singleton) so tests can assert both modes without mutating `process.env`.
 */
export function resolveRuntimeEnv(env: NodeJS.ProcessEnv = process.env): RuntimeEnv {
  const role = parseRole(env.HUDDLE_ROLE);
  const hostMode = env.HUDDLE_HOST_MODE === '1';

  // In host mode Huddle owns ~/.huddle outright: it is both the state directory
  // and the config directory the CLI already writes (cli/src/config.ts).
  const huddleHome = path.join(os.homedir(), '.huddle');
  const dataDir = env.HUDDLE_DATA_DIR?.trim() || (hostMode ? huddleHome : '/data');
  const homeDir = env.HUDDLE_HOME_DIR?.trim() || (hostMode ? huddleHome : '/huddle-home');

  // Host mode listens on Huddle Node's own port so it never collides with a
  // gateway container that still publishes 3000.
  const apiPort = parsePort(env.HUDDLE_API_PORT, hostMode ? 24842 : 3000, 'HUDDLE_API_PORT');

  // Windows has no Unix socket for the engine; Node accepts the named pipe as a
  // socketPath verbatim. Irrelevant in container mode, where the CLI bind-mounts
  // whichever socket the runtime uses onto /var/run/docker.sock.
  const defaultDockerSocket =
    hostMode && process.platform === 'win32' ? '\\\\.\\pipe\\docker_engine' : '/var/run/docker.sock';

  return {
    role,
    runsGateway: role === 'all' || role === 'gateway',
    runsNode: role === 'all' || role === 'node',
    hostMode,
    apiPort,
    proxyPort: parsePort(env.HUDDLE_PROXY_PORT, 80, 'HUDDLE_PROXY_PORT'),
    sbxProxyPort: parsePort(env.HUDDLE_SBX_PROXY_PORT, 32768, 'HUDDLE_SBX_PROXY_PORT'),
    dockerSocketPath: env.HUDDLE_DOCKER_SOCKET?.trim() || defaultDockerSocket,
    socketDir: env.HUDDLE_SOCKET_DIR?.trim() || '/tmp/dc-sockets',
    dataDir,
    dbPath: env.DB_PATH?.trim() || path.join(dataDir, 'huddle.db'),
    caDir: env.CA_DIR?.trim() || dataDir,
    extDir: env.EXT_DIR?.trim() || path.join(dataDir, 'extensions'),
    homeDir,
    firewallRulesMount: env.HUDDLE_FIREWALL_RULES_MOUNT?.trim() || '/firewall-rules',
    teamExtDir: env.HUDDLE_EXTENSIONS_MOUNT?.trim() || '/extensions',
  };
}

/** The bindings for this process. Resolved once, at import. */
export const runtimeEnv: RuntimeEnv = resolveRuntimeEnv();
