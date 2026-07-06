import { execSync } from 'child_process';
import { bold, green, dim } from './utils';
import { resolveRuntime } from './runtime';

const IMAGE = 'ghcr.io/infosupport/huddle:latest';
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

export async function runInit(opts: InitOptions = {}): Promise<void> {
  console.log(`${bold('Huddle opstarten...')}\n`);

  const runtime = resolveRuntime(opts.runtime);
  const rt = runtime.name;
  console.log(dim(`Container runtime: ${rt}`));

  console.log(dim(`Pull ${IMAGE}`));
  run(`${rt} pull ${IMAGE}`);

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`${rt} volume inspect ${VOLUME}`) || run(`${rt} volume create ${VOLUME}`);

  console.log(dim(`Netwerk: ${INTERNAL_NET}`));
  runSilent(`${rt} network inspect ${INTERNAL_NET}`) || run(`${rt} network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Verwijder oude container als die bestaat`));
  runSilent(`${rt} rm -f ${CONTAINER}`);

  console.log(dim(`Maak /tmp/dc-sockets aan`));
  execSync('mkdir -p /tmp/dc-sockets');

  console.log(dim(`Start container`));
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
  console.log(green(`[OK] Huddle draait op http://localhost:${HOST_PORT}`));
}
