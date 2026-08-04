import { execSync } from 'child_process';

export type RuntimeName = 'docker' | 'podman';

export interface ContainerRuntime {
  name: RuntimeName;
  /** Path on the host to the container socket, mounted as /var/run/docker.sock. */
  socketPath: string;
  /** Name of the default bridge network ('bridge' for Docker, 'podman' for Podman). */
  defaultNetwork: string;
  /**
   * Does the engine run in a VM (Podman machine, Docker Desktop) instead of
   * natively on the host? Determines whether bind-sources such as
   * /tmp/dc-sockets must be created inside the VM: Docker Desktop creates a
   * missing source itself, Podman does not — then we have to create it inside
   * the VM via `podman machine ssh`.
   */
  isRemote: boolean;
  /**
   * Extra `--security-opt` flags for the huddle container. Rootless Podman
   * gives its socket a SELinux label; without `label=disable` the
   * (SELinux-confined) huddle process is not allowed to access the socket.
   * Docker does not need this (empty).
   */
  securityOpts: string[];
}

function commandOutput(cmd: string): string | undefined {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return undefined;
  }
}

function isAvailable(runtime: RuntimeName): boolean {
  // 'info' only succeeds if the daemon/machine is actually reachable.
  return commandOutput(`${runtime} info`) !== undefined;
}

/**
 * Determines the REAL engine behind a command, or undefined if the engine is
 * not reachable. Do not trust the command name: `docker` is often a
 * symlink/shim to Podman (podman-docker), and Podman then even emulates
 * `docker --version`. Podman's `info`, on the other hand, has the field
 * Host.ServiceIsRemote; Docker's info schema does not. That is a reliable
 * distinction that also works through the shim.
 */
function detectEngine(command: RuntimeName): RuntimeName | undefined {
  if (commandOutput(`${command} info --format "{{.Host.ServiceIsRemote}}"`) !== undefined) {
    return 'podman';
  }
  if (isAvailable(command)) return 'docker';
  return undefined;
}

function podmanSocketPath(): string {
  // Podman knows where its own (rootless or rootful) socket lives.
  const reported = commandOutput(`podman info --format "{{.Host.RemoteSocket.Path}}"`);
  if (reported) {
    return reported.replace(/^unix:\/\//, '');
  }
  return '/run/podman/podman.sock';
}

function dockerSocketPath(): string {
  return process.platform === 'win32' ? '//var/run/docker.sock' : '/var/run/docker.sock';
}

/**
 * Extracts the unix socket path from the JSON of `docker context inspect`. The
 * active context determines which engine the `docker` command talks to; Rancher
 * Desktop (dockerd/moby mode) sets a `rancher-desktop` context whose
 * `Endpoints.docker.Host` points to `unix:///<home>/.rd/docker.sock` instead of
 * the default `/var/run/docker.sock`.
 *
 * Pure function so we can test the parsing in isolation. Returns `null` for
 * non-parsable input or a non-unix endpoint (npipe:// on Windows,
 * tcp:// / ssh:// remote), because those cannot be bind-mounted as a file path.
 */
export function parseDockerContextSocket(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  // `docker context inspect` returns an array; one context is one element.
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const host = (entry as { Endpoints?: { docker?: { Host?: unknown } } } | null | undefined)
    ?.Endpoints?.docker?.Host;
  if (typeof host !== 'string' || !host.startsWith('unix://')) return null;
  const path = host.slice('unix://'.length);
  if (!path.startsWith('/')) return null;
  // The returned path is later interpolated UNquoted into a `docker run -v
  // <path>:...` shell command (init.ts). The `Host` from `docker context
  // inspect` is attacker-influenceable (whoever can create/activate a docker
  // context controls the value), so only allow characters that occur in a real
  // socket path. This way a manipulated context cannot smuggle in shell
  // metacharacters ($(), backticks, ;, |, spaces, ...) — command injection.
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  return path;
}

/** Recognizes the Rancher Desktop socket path (dockerd/moby mode): `~/.rd/docker.sock`. */
export function isRancherDesktopSocket(socketPath: string | null | undefined): boolean {
  return typeof socketPath === 'string' && /(^|\/)\.rd\/docker\.sock$/.test(socketPath);
}

/** Socket path of the active docker context, or undefined if it cannot be queried. */
function dockerContextSocket(): string | undefined {
  const json = commandOutput('docker context inspect');
  if (!json) return undefined;
  return parseDockerContextSocket(json) ?? undefined;
}

function podmanIsRemote(): boolean {
  // On macOS/Windows Podman always runs in a `podman machine` VM; on Linux too
  // the client can point at a remote socket. `ServiceIsRemote` is the
  // authoritative source.
  return commandOutput(`podman info --format "{{.Host.ServiceIsRemote}}"`) === 'true';
}

function buildRuntime(name: RuntimeName): ContainerRuntime {
  if (name === 'podman') {
    return {
      name,
      socketPath: podmanSocketPath(),
      defaultNetwork: 'podman',
      isRemote: podmanIsRemote(),
      securityOpts: ['label=disable'],
    };
  }
  // Rancher Desktop (dockerd/moby mode) looks like an ordinary Docker engine,
  // but the socket is not at /var/run/docker.sock: the active docker context
  // points to `~/.rd/docker.sock`. Follow that context so we bind-mount the
  // correct socket; otherwise we fall back to the default location (real native
  // Docker, Docker Desktop). Rancher Desktop runs the engine in a VM (Lima/WSL)
  // on EVERY platform, so it is always 'remote'.
  const contextSocket = dockerContextSocket();
  const isRancher = isRancherDesktopSocket(contextSocket);
  return {
    name,
    socketPath: isRancher ? contextSocket! : dockerSocketPath(),
    defaultNetwork: 'bridge',
    // Docker Desktop (macOS/Windows) and Rancher Desktop run in a VM; native
    // Docker on Linux does not.
    isRemote: isRancher || process.platform !== 'linux',
    securityOpts: [],
  };
}

export function parseRuntimeName(value: string): RuntimeName {
  const normalized = value.toLowerCase().trim();
  if (normalized === 'docker' || normalized === 'podman') return normalized;
  throw new Error(`Unknown container runtime: ${value}. Choose docker or podman.`);
}

/**
 * Determines which container runtime to use.
 * An explicit choice (via --runtime or HUDDLE_RUNTIME) wins; otherwise it is
 * auto-detected: Docker first, then Podman.
 */
export function resolveRuntime(explicit?: string): ContainerRuntime {
  const requested = explicit ?? process.env.HUDDLE_RUNTIME;
  if (requested) {
    const name = parseRuntimeName(requested);
    if (!isAvailable(name)) {
      throw new Error(`Container runtime '${name}' is not available. Is the daemon/machine running?`);
    }
    return buildRuntime(name);
  }

  // Auto-detection: first look behind the `docker` command (which may be a
  // Podman shim), then at `podman`. This way a real Docker engine wins if there
  // is one, but we also recognize Podman when it poses as `docker`.
  const detected = detectEngine('docker') ?? detectEngine('podman');
  if (detected) return buildRuntime(detected);

  throw new Error(
    'No working container runtime found. Install and start Docker or Podman,\n' +
    'or pick one explicitly with --runtime <docker|podman> or the HUDDLE_RUNTIME env var.',
  );
}
