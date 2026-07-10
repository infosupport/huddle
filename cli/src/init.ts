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
 * Pullt de devcontainer-base-images alvast. Best-effort: als een image (nog)
 * niet beschikbaar is in het register, waarschuwen we alleen — de gateway bouwt
 * hem dan bij de eerste start alsnog uit de meegeleverde Dockerfile.
 */
function pullBaseImages(rt: string, images: string[]): void {
  console.log(dim(`Pull devcontainer base-images (${images.length})`));
  const failed: string[] = [];
  for (const image of images) {
    console.log(dim(`  Pull ${image}`));
    try {
      run(`${rt} pull ${image}`);
    } catch {
      failed.push(image);
      console.log(yellow(`  [!] Kon ${image} niet pullen — gateway bouwt hem later indien nodig.`));
    }
  }
  if (failed.length === images.length) {
    console.log(yellow('[!] Geen enkele base-image kon gepulld worden. Ben je ingelogd op ghcr.io?'));
  }
}

/**
 * Start de Huddle-gateway. Welke images er draaien (stable of experiment)
 * beslist de aanroeper via `images` (zie resolveImages() in images.ts);
 * deze functie doet alleen runtime- en container-orkestratie.
 */
export async function runInit(opts: InitOptions, images: ResolvedImages): Promise<void> {
  console.log(`${bold('Huddle opstarten...')}\n`);

  const IMAGE = images.image;
  if (images.experiment !== undefined) {
    console.log(yellow(`Experiment ${images.experiment} actief → images met tag ${images.tag}`));
  }

  const runtime = resolveRuntime(opts.runtime);
  const rt = runtime.name;
  console.log(dim(`Container runtime: ${rt}`));

  if (process.env.HUDDLE_NO_PULL === '1') {
    console.log(dim(`HUDDLE_NO_PULL=1 → pull overslaan, lokale image ${IMAGE} gebruiken`));
  } else {
    console.log(dim(`Pull ${IMAGE}`));
    run(`${rt} pull ${IMAGE}`);
    pullBaseImages(rt, images.baseImages.map((b) => b.image));
  }

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`${rt} volume inspect ${VOLUME}`) || run(`${rt} volume create ${VOLUME}`);

  console.log(dim(`Netwerk: ${INTERNAL_NET}`));
  runSilent(`${rt} network inspect ${INTERNAL_NET}`) || run(`${rt} network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Verwijder oude container als die bestaat`));
  runSilent(`${rt} rm -f ${CONTAINER}`);

  console.log(dim(`Socket-directory: /tmp/dc-sockets`));
  // De mount-SOURCE moet het pad op de Docker-ENGINE-host zijn (onder Windows:
  // de WSL2/Linux-VM), óók als de CLI zelf op Windows draait. De gateway
  // (SOCKET_DIR in docker.ts) en elke devcontainer-socket-mount rekenen op
  // /tmp/dc-sockets op de engine-host; een Windows-tempdir mounten splitst
  // gateway en devcontainers over twee filesystems, en op zo'n drvfs/9p-mount
  // zijn Unix-sockets bovendien onbetrouwbaar.
  const hostTmpSockets = '/tmp/dc-sockets';
  if (process.platform === 'win32') {
    // Niet lokaal aan te maken vanaf Windows; de engine maakt een ontbrekende
    // bind-source zelf aan in de VM bij `run`.
    console.log(dim(`  (Windows: de engine maakt ${hostTmpSockets} in de VM aan)`));
  } else {
    try {
      fs.mkdirSync(hostTmpSockets, { recursive: true });
    } catch (err) {
      console.log(yellow(`[!] Kon ${hostTmpSockets} niet aanmaken: ${err}`));
    }
  }

  console.log(dim(`Start container`));
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${INTERNAL_NET}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${runtime.socketPath}:/var/run/docker.sock` +
    ` -v "${hostTmpSockets}:/tmp/dc-sockets"` +
    gatewayEnvFlags(images) +
    ` ${IMAGE}`,
  );

  runSilent(`${rt} network connect ${runtime.defaultNetwork} ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle draait op http://localhost:${HOST_PORT}`));
}
