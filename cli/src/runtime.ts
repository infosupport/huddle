import { execSync } from 'child_process';

export type RuntimeName = 'docker' | 'podman';

export interface ContainerRuntime {
  name: RuntimeName;
  /** Path on the host to the container socket, mounted as /var/run/docker.sock. */
  socketPath: string;
  /** Name of the default bridge network ('bridge' for Docker, 'podman' for Podman). */
  defaultNetwork: string;
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

function buildRuntime(name: RuntimeName): ContainerRuntime {
  if (name === 'podman') {
    return { name, socketPath: podmanSocketPath(), defaultNetwork: 'podman' };
  }
  return { name, socketPath: dockerSocketPath(), defaultNetwork: 'bridge' };
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

  if (isAvailable('docker')) return buildRuntime('docker');
  if (isAvailable('podman')) return buildRuntime('podman');

  throw new Error(
    'No working container runtime found. Install and start Docker or Podman,\n' +
    'or pick one explicitly with --runtime <docker|podman> or the HUDDLE_RUNTIME env var.',
  );
}
