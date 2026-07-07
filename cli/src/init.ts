import { execSync } from 'child_process';
import { bold, green, dim, yellow } from './utils';
import { resolveRuntime } from './runtime';
import fs from 'fs';
import os from 'os';
import path from 'path';

const IMAGE = 'ghcr.io/infosupport/huddle:latest';
const CONTAINER = 'huddle';
const VOLUME = 'huddle-data';
const INTERNAL_NET = 'devcontainer-net';
const HOST_PORT = process.env.HUDDLE_PORT ?? '3000';

/**
 * Devcontainer-base-images die de gateway gebruikt om workspaces te starten.
 * We pullen ze alvast tijdens init zodat de eerste `huddle start` niet hoeft te
 * wachten op een pull (of een lokale build als fallback). De namen komen overeen
 * met getBaseImageName() in de gateway; een override kan via BASE_IMAGE_<IDE>.
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
 * Pullt de devcontainer-base-images alvast. Best-effort: als een image (nog)
 * niet beschikbaar is in het register, waarschuwen we alleen — de gateway bouwt
 * hem dan bij de eerste start alsnog uit de meegeleverde Dockerfile.
 */
function pullBaseImages(rt: string): void {
  console.log(dim(`Pull devcontainer base-images (${BASE_IMAGES.length})`));
  const failed: string[] = [];
  for (const image of BASE_IMAGES) {
    console.log(dim(`  Pull ${image}`));
    try {
      run(`${rt} pull ${image}`);
    } catch {
      failed.push(image);
      console.log(yellow(`  [!] Kon ${image} niet pullen — gateway bouwt hem later indien nodig.`));
    }
  }
  if (failed.length === BASE_IMAGES.length) {
    console.log(yellow('[!] Geen enkele base-image kon gepulld worden. Ben je ingelogd op ghcr.io?'));
  }
}

export async function runInit(opts: InitOptions = {}): Promise<void> {
  console.log(`${bold('Huddle opstarten...')}\n`);

  const runtime = resolveRuntime(opts.runtime);
  const rt = runtime.name;
  console.log(dim(`Container runtime: ${rt}`));

  console.log(dim(`Pull ${IMAGE}`));
  run(`${rt} pull ${IMAGE}`);

  pullBaseImages(rt);

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`${rt} volume inspect ${VOLUME}`) || run(`${rt} volume create ${VOLUME}`);

  console.log(dim(`Netwerk: ${INTERNAL_NET}`));
  runSilent(`${rt} network inspect ${INTERNAL_NET}`) || run(`${rt} network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Verwijder oude container als die bestaat`));
  runSilent(`${rt} rm -f ${CONTAINER}`);

  console.log(dim(`Maak /tmp/dc-sockets aan`));
  // Create a host directory for dc-sockets in a cross-platform way.
  // On Unix-like systems we use /tmp/dc-sockets. On Windows we create
  // a directory inside the OS temp dir (e.g. C:\\Users\\...\\AppData\\Local\\Temp\\dc-sockets)
  // and mount that into the container at /tmp/dc-sockets.
  const hostTmpSockets = process.platform === 'win32'
    ? path.resolve(os.tmpdir(), 'dc-sockets')
    : '/tmp/dc-sockets';
  try {
    fs.mkdirSync(hostTmpSockets, { recursive: true });
  } catch (err) {
    console.log(yellow(`[!] Kon ${hostTmpSockets} niet aanmaken: ${err}`));
  }

  // Optionele diagnose: geef HUDDLE_DEBUG_GATE door zodat de source-IP gate elke
  // beslissing logt (bekijk met `<runtime> logs huddle`). Handig om een 403
  // "endpoint not allowed from devcontainer network" vanaf de host te herleiden.
  const debugGate = process.env.HUDDLE_DEBUG_GATE
    ? ` -e HUDDLE_DEBUG_GATE=${process.env.HUDDLE_DEBUG_GATE}`
    : '';

  console.log(dim(`Start container`));
  run(
    `${rt} run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${INTERNAL_NET}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${runtime.socketPath}:/var/run/docker.sock` +
    ` -v "${hostTmpSockets}:/tmp/dc-sockets"` +
    ` ${IMAGE}`,
  );

  runSilent(`${rt} network connect ${runtime.defaultNetwork} ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle draait op http://localhost:${HOST_PORT}`));
}
