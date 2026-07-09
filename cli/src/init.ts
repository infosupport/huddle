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
  // The container is created on the engine's default network first (with -p),
  // then joins devcontainer-net (--internal) afterwards. Docker needs this
  // ordering because it skips the host port-forward entirely when a container
  // is created directly on an --internal network (moby/moby#36174). Rootless
  // Podman needs the same ordering for a different reason: its pasta port-
  // forwarder delivers host traffic in via the PRIMARY network interface, so if
  // devcontainer-net were primary the operator's browser would appear to come
  // from the devcontainer subnet and get blocked by the source-IP gate (api.ts).
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${runtime.defaultNetwork}` +
    securityOptFlags +
    ` -e HUDDLE_RUNTIME=${runtime.name}` +
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
}
