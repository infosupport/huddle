import { execSync } from 'child_process';
import crypto from 'crypto';
import { bold, green, dim, yellow } from './utils';
import { resolveRuntime } from './runtime';
import { ResolvedImages, gatewayEnvFlags } from './images';
import { readConfig, writeConfig } from './config';
import fs from 'fs';

const CONTAINER = 'huddle';
const VOLUME = 'huddle-data';
const INTERNAL_NET = 'devcontainer-net';
const HOST_PORT = process.env.HUDDLE_PORT ?? '3000';

export interface InitOptions {
  runtime?: string;
}

function run(cmd: string): void {
  execSync(cmd, { stdio: 'inherit' });
}

function runSilent(cmd: string): boolean {
  try {
    execSync(cmd, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Pulls the devcontainer base images ahead of time. Best-effort: if an image is
 * not (yet) available in the registry, we only warn — the gateway then builds it
 * from the bundled Dockerfile on the first start.
 */
function pullBaseImages(rt: string, images: string[]): void {
  console.log(dim(`Pulling devcontainer base images (${images.length})`));
  const failed: string[] = [];
  for (const image of images) {
    console.log(dim(`  Pulling ${image}`));
    try {
      run(`${rt} pull ${image}`);
    } catch {
      failed.push(image);
      console.log(yellow(`  [!] Could not pull ${image} — the gateway will build it later if needed.`));
    }
  }
  if (failed.length === images.length) {
    console.log(yellow('[!] No base image could be pulled. Are the images published and reachable?'));
  }
}

/**
 * Starts the Huddle gateway. Which images run (stable or experiment) is decided
 * by the caller via `images` (see resolveImages() in images.ts); this function
 * only does runtime and container orchestration.
 */
export async function runInit(opts: InitOptions, images: ResolvedImages): Promise<void> {
  console.log(`${bold('Starting Huddle...')}\n`);

  const IMAGE = images.image;
  if (images.experiment !== undefined) {
    console.log(yellow(`Experiment ${images.experiment} active → images with tag ${images.tag}`));
  }

  const runtime = resolveRuntime(opts.runtime);
  const rt = runtime.name;
  console.log(dim(`Container runtime: ${rt}`));

  if (process.env.HUDDLE_NO_PULL === '1') {
    console.log(dim(`HUDDLE_NO_PULL=1 → skipping pull, using local image ${IMAGE}`));
  } else {
    console.log(dim(`Pulling ${IMAGE}`));
    run(`${rt} pull ${IMAGE}`);
    pullBaseImages(rt, images.baseImages.map((b) => b.image));
  }

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`${rt} volume inspect ${VOLUME}`) || run(`${rt} volume create ${VOLUME}`);

  console.log(dim(`Network: ${INTERNAL_NET}`));
  runSilent(`${rt} network inspect ${INTERNAL_NET}`) || run(`${rt} network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Removing old container if it exists`));
  runSilent(`${rt} rm -f ${CONTAINER}`);

  console.log(dim(`Socket directory: /tmp/dc-sockets`));
  // The mount SOURCE must be the path on the Docker ENGINE host (on Windows:
  // the WSL2/Linux VM), even when the CLI itself runs on Windows. The gateway
  // (SOCKET_DIR in docker.ts) and every devcontainer socket mount rely on
  // /tmp/dc-sockets on the engine host; mounting a Windows temp dir splits
  // gateway and devcontainers across two filesystems, and Unix sockets are
  // unreliable on such a drvfs/9p mount anyway.
  const hostTmpSockets = '/tmp/dc-sockets';
  if (runtime.isRemote) {
    if (runtime.name === 'podman') {
      // Podman does NOT create a missing bind source itself (unlike Docker
      // Desktop) and fails with "statfs: no such file or directory". So create
      // the directory explicitly in the machine VM; the socket lives there too.
      console.log(dim(`  (Podman: creating ${hostTmpSockets} in the machine VM)`));
      if (!runSilent(`podman machine ssh "mkdir -p ${hostTmpSockets}"`)) {
        console.log(yellow(`[!] Could not create ${hostTmpSockets} in the Podman VM.`));
      }
    } else {
      // Docker Desktop creates a missing bind source itself in the VM on `run`.
      console.log(dim(`  (${runtime.name}: the engine creates ${hostTmpSockets} in the VM)`));
    }
  } else {
    try {
      fs.mkdirSync(hostTmpSockets, { recursive: true });
    } catch (err) {
      console.log(yellow(`[!] Could not create ${hostTmpSockets}: ${err}`));
    }
  }

  console.log(dim(`Starting container`));
  // The gateway is engine-agnostic (talks the Docker-compatible API on the
  // mounted socket), but does need to know it's Podman: it then sets
  // `--security-opt label=disable` on every devcontainer so it can reach the
  // SELinux-labeled proxy socket.
  const securityOptFlags = runtime.securityOpts.map((opt) => ` --security-opt ${opt}`).join('');

  // Operator-token voor de control-plane-auth. Hergebruik het token uit de
  // config (zodat een bestaande browser-sessie/CLI blijft werken over re-inits),
  // anders genereer er één. We geven het aan de gateway mee via env én bewaren
  // het lokaal zodat volgende `huddle`-commando's zich kunnen authenticeren.
  const cfg = readConfig();
  const operatorToken =
    process.env.HUDDLE_OPERATOR_TOKEN?.trim() ||
    (cfg.operatorToken && cfg.operatorToken.trim()) ||
    crypto.randomBytes(32).toString('base64url');
  if (cfg.operatorToken !== operatorToken) {
    writeConfig({ ...cfg, operatorToken });
  }
  // The container is created on the engine's default network first (with -p),
  // then joins devcontainer-net (--internal) afterwards: Docker skips the host
  // port-forward entirely when a container is created directly on an --internal
  // network (moby/moby#36174). Which source IP the gateway sees for forwarded
  // traffic no longer matters — the control plane authenticates with the
  // operator token instead of source-IP filtering.
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${runtime.defaultNetwork}` +
    securityOptFlags +
    ` -e HUDDLE_RUNTIME=${runtime.name}` +
    ` -e HUDDLE_OPERATOR_TOKEN=${operatorToken}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${runtime.socketPath}:/var/run/docker.sock` +
    ` -v "${hostTmpSockets}:/tmp/dc-sockets"` +
    gatewayEnvFlags(images) +
    ` ${IMAGE}`,
  );

  // Attaching devcontainer-net after the container has started pollutes
  // resolv.conf on Podman with that network's internal aardvark-DNS; the
  // gateway cleans that up itself (see dns-egress.ts / the startup sanitize in
  // index.ts).
  runSilent(`${rt} network connect ${INTERNAL_NET} ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle is running at http://localhost:${HOST_PORT}`));
  console.log();
  // Volledige auto-login-link: open deze en de portal logt je automatisch in met
  // het operator-token (de frontend leest ?token=..., logt in en verwijdert het
  // daarna uit de adresbalk). Zo hoef je niets te plakken.
  const loginUrl = `http://localhost:${HOST_PORT}/?token=${encodeURIComponent(operatorToken)}`;
  console.log(bold('Open the portal (auto-login link):'));
  console.log(green(`    ${loginUrl}`));
  console.log(dim('  Opens the portal and logs you in automatically.'));
  console.log(dim(`  Manual token (if you prefer to paste it): ${operatorToken}`));
  console.log(dim('  The token is also saved to ~/.huddle/config.json for the CLI.'));
}
