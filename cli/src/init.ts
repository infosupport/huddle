import { execSync } from 'child_process';
import { bold, green, dim, yellow } from './utils';
import { resolveRuntime } from './runtime';

const IMAGE = 'ghcr.io/infosupport/huddle:latest';
const CONTAINER = 'huddle';
const VOLUME = 'huddle-data';
const INTERNAL_NET = 'devcontainer-net';
const HOST_PORT = process.env.HUDDLE_PORT ?? '3000';

/**
 * Devcontainer base images the gateway uses to start workspaces.
 * We pull them ahead of time during init so the first `huddle start` doesn't have
 * to wait on a pull (or a local build as fallback). The names match
 * getBaseImageName() in the gateway; an override is possible via BASE_IMAGE_<IDE>.
 */
const BASE_IMAGES: readonly string[] = [
  process.env.BASE_IMAGE ?? 'ghcr.io/infosupport/base-devimage',
  process.env.BASE_IMAGE_RIDER ?? 'ghcr.io/infosupport/base-devimage-rider',
  process.env.BASE_IMAGE_INTELLIJ ?? 'ghcr.io/infosupport/base-devimage-intellij',
  process.env.BASE_IMAGE_VSCODE ?? 'ghcr.io/infosupport/base-devimage-vscode',
];

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
function pullBaseImages(rt: string): void {
  console.log(dim(`Pulling devcontainer base images (${BASE_IMAGES.length})`));
  const failed: string[] = [];
  for (const image of BASE_IMAGES) {
    console.log(dim(`  Pulling ${image}`));
    try {
      run(`${rt} pull ${image}`);
    } catch {
      failed.push(image);
      console.log(yellow(`  [!] Could not pull ${image} — the gateway will build it later if needed.`));
    }
  }
  if (failed.length === BASE_IMAGES.length) {
    console.log(yellow('[!] No base image could be pulled. Are the images published and reachable?'));
  }
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  console.log(`${bold('Starting Huddle...')}\n`);

  const runtime = resolveRuntime(opts.runtime);
  const rt = runtime.name;
  console.log(dim(`Container runtime: ${rt}`));

  console.log(dim(`Pulling ${IMAGE}`));
  run(`${rt} pull ${IMAGE}`);

  pullBaseImages(rt);

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`${rt} volume inspect ${VOLUME}`) || run(`${rt} volume create ${VOLUME}`);

  console.log(dim(`Network: ${INTERNAL_NET}`));
  runSilent(`${rt} network inspect ${INTERNAL_NET}`) || run(`${rt} network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Removing old container if it exists`));
  runSilent(`${rt} rm -f ${CONTAINER}`);

  console.log(dim(`Creating /tmp/dc-sockets`));
  execSync('mkdir -p /tmp/dc-sockets');

  console.log(dim(`Starting container`));
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${INTERNAL_NET}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${runtime.socketPath}:/var/run/docker.sock` +
    ` -v /tmp/dc-sockets:/tmp/dc-sockets` +
    ` ${IMAGE}`,
  );

  runSilent(`${rt} network connect ${runtime.defaultNetwork} ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle is running at http://localhost:${HOST_PORT}`));
}
