import { execSync } from 'child_process';

export type RuntimeName = 'docker' | 'podman';

export interface ContainerRuntime {
  name: RuntimeName;
  /** Path on the host to the container socket, mounted as /var/run/docker.sock. */
  socketPath: string;
  /** Name of the default bridge network ('bridge' for Docker, 'podman' for Podman). */
  defaultNetwork: string;
  /**
   * Draait de engine in een VM (Podman machine, Docker Desktop) i.p.v. native op
   * de host? Bepaalt of bind-sources zoals /tmp/dc-sockets in de VM aangemaakt
   * moeten worden: Docker Desktop maakt een ontbrekende source zelf aan, Podman
   * niet — dan moeten we hem via `podman machine ssh` in de VM aanmaken.
   */
  isRemote: boolean;
  /**
   * Extra `--security-opt` vlaggen voor de huddle-container. Rootless Podman
   * geeft zijn socket een SELinux-label; zonder `label=disable` mag het
   * (SELinux-confined) huddle-proces de socket niet benaderen. Docker heeft dit
   * niet nodig (leeg).
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
 * Bepaalt de ECHTE engine achter een commando, of undefined als de engine niet
 * bereikbaar is. Vertrouw niet op de commandonaam: `docker` is vaak een
 * symlink/shim naar Podman (podman-docker) en Podman emuleert dan zelfs
 * `docker --version`. Podman's `info` kent daarentegen het veld
 * Host.ServiceIsRemote; Docker's info-schema niet. Dat is een betrouwbaar
 * onderscheid dat ook via de shim werkt.
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
 * Haalt het unix-socketpad uit de JSON van `docker context inspect`. De actieve
 * context bepaalt naar welke engine het `docker`-commando praat; Rancher Desktop
 * (dockerd/moby-modus) zet een `rancher-desktop`-context waarvan
 * `Endpoints.docker.Host` naar `unix:///<home>/.rd/docker.sock` wijst i.p.v. de
 * standaard `/var/run/docker.sock`.
 *
 * Pure functie zodat we het parsen los kunnen testen. Geeft `null` terug bij
 * niet-parsebare invoer of een niet-unix endpoint (npipe:// op Windows,
 * tcp:// / ssh:// remote), want die zijn niet als bestandspad te bind-mounten.
 */
export function parseDockerContextSocket(json: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  // `docker context inspect` levert een array; één context is één element.
  const entry = Array.isArray(parsed) ? parsed[0] : parsed;
  const host = (entry as { Endpoints?: { docker?: { Host?: unknown } } } | null | undefined)
    ?.Endpoints?.docker?.Host;
  if (typeof host !== 'string' || !host.startsWith('unix://')) return null;
  const path = host.slice('unix://'.length);
  if (!path.startsWith('/')) return null;
  // Het teruggegeven pad wordt later ONgequote in een `docker run -v <pad>:...`
  // shell-commando geïnterpoleerd (init.ts). De `Host` uit `docker context
  // inspect` is beïnvloedbaar (wie een docker-context kan aanmaken/activeren
  // bepaalt de waarde), dus laat alleen tekens toe die in een echt socketpad
  // voorkomen. Zo kan een gemanipuleerde context geen shell-metatekens
  // ($(), backticks, ;, |, spaties, ...) binnensmokkelen — command injection.
  if (!/^[A-Za-z0-9._/-]+$/.test(path)) return null;
  return path;
}

/** Herkent het socketpad van Rancher Desktop (dockerd/moby-modus): `~/.rd/docker.sock`. */
export function isRancherDesktopSocket(socketPath: string | null | undefined): boolean {
  return typeof socketPath === 'string' && /(^|\/)\.rd\/docker\.sock$/.test(socketPath);
}

/** Socketpad van de actieve docker-context, of undefined als het niet op te vragen is. */
function dockerContextSocket(): string | undefined {
  const json = commandOutput('docker context inspect');
  if (!json) return undefined;
  return parseDockerContextSocket(json) ?? undefined;
}

function podmanIsRemote(): boolean {
  // Op macOS/Windows draait Podman altijd in een `podman machine`-VM; ook op
  // Linux kan de client op een remote socket wijzen. `ServiceIsRemote` is de
  // gezaghebbende bron.
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
  // Rancher Desktop (dockerd/moby-modus) ziet er als een gewone Docker-engine
  // uit, maar de socket zit niet op /var/run/docker.sock: de actieve
  // docker-context wijst naar `~/.rd/docker.sock`. Volg die context zodat we de
  // juiste socket bind-mounten; anders vallen we terug op de standaardlocatie
  // (echte native Docker, Docker Desktop). Rancher Desktop draait de engine op
  // ELK platform in een VM (Lima/WSL), dus is hij altijd 'remote'.
  const contextSocket = dockerContextSocket();
  const isRancher = isRancherDesktopSocket(contextSocket);
  return {
    name,
    socketPath: isRancher ? contextSocket! : dockerSocketPath(),
    defaultNetwork: 'bridge',
    // Docker Desktop (macOS/Windows) en Rancher Desktop draaien in een VM;
    // native Docker op Linux niet.
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

  // Auto-detectie: kijk eerst achter het `docker`-commando (dat een Podman-shim
  // kan zijn), daarna naar `podman`. Zo wint een echte Docker-engine als die er
  // is, maar herkennen we Podman ook als het zich als `docker` voordoet.
  const detected = detectEngine('docker') ?? detectEngine('podman');
  if (detected) return buildRuntime(detected);

  throw new Error(
    'No working container runtime found. Install and start Docker or Podman,\n' +
    'or pick one explicitly with --runtime <docker|podman> or the HUDDLE_RUNTIME env var.',
  );
}
