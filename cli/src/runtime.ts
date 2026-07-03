import { execSync } from 'child_process';

export type RuntimeName = 'docker' | 'podman';

export interface ContainerRuntime {
  name: RuntimeName;
  /** Pad op de host naar de container-socket, gemount als /var/run/docker.sock. */
  socketPath: string;
  /** Naam van het standaard bridge-netwerk ('bridge' bij Docker, 'podman' bij Podman). */
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
  // 'info' slaagt alleen als de daemon/machine ook echt bereikbaar is.
  return commandOutput(`${runtime} info`) !== undefined;
}

function podmanSocketPath(): string {
  // Podman weet zelf waar zijn (rootless of rootful) socket staat.
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
  throw new Error(`Onbekende container runtime: ${value}. Kies docker of podman.`);
}

/**
 * Bepaalt de te gebruiken container runtime.
 * Expliciete keuze (via --runtime of HUDDLE_RUNTIME) wint; anders wordt
 * automatisch gedetecteerd: eerst Docker, dan Podman.
 */
export function resolveRuntime(explicit?: string): ContainerRuntime {
  const requested = explicit ?? process.env.HUDDLE_RUNTIME;
  if (requested) {
    const name = parseRuntimeName(requested);
    if (!isAvailable(name)) {
      throw new Error(`Container runtime '${name}' is niet beschikbaar. Draait de daemon/machine?`);
    }
    return buildRuntime(name);
  }

  if (isAvailable('docker')) return buildRuntime('docker');
  if (isAvailable('podman')) return buildRuntime('podman');

  throw new Error(
    'Geen werkende container runtime gevonden. Installeer en start Docker of Podman,\n' +
    'of kies er expliciet een met --runtime <docker|podman> of de env-var HUDDLE_RUNTIME.',
  );
}
