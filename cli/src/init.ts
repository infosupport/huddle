import { execSync } from 'child_process';
import { bold, green, dim, yellow } from './utils';
import { resolveRuntime } from './runtime';
import { ResolvedImages, gatewayEnvFlags } from './images';
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
  if (process.platform === 'win32') {
    // Cannot be created locally from Windows; the engine creates a missing
    // bind source itself in the VM on `run`.
    console.log(dim(`  (Windows: the engine creates ${hostTmpSockets} in the VM)`));
  } else {
    try {
      fs.mkdirSync(hostTmpSockets, { recursive: true });
    } catch (err) {
      console.log(yellow(`[!] Could not create ${hostTmpSockets}: ${err}`));
    }
  }

  console.log(dim(`Starting container`));
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${runtime.defaultNetwork}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${runtime.socketPath}:/var/run/docker.sock` +
    ` -v "${hostTmpSockets}:/tmp/dc-sockets"` +
    gatewayEnvFlags(images) +
    ` ${IMAGE}`,
  );

  runSilent(`${rt} network connect ${INTERNAL_NET} ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle is running at http://localhost:${HOST_PORT}`));
}
