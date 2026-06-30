import { execSync } from 'child_process';
import { bold, green, dim } from './utils';

const IMAGE = 'ghcr.io/infosupport/huddle:latest';
const CONTAINER = 'huddle';
const VOLUME = 'huddle-data';
const INTERNAL_NET = 'devcontainer-net';
const HOST_PORT = process.env.HUDDLE_PORT ?? '3000';

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

export async function runInit(): Promise<void> {
  console.log(`${bold('Huddle opstarten...')}\n`);

  console.log(dim(`Pull ${IMAGE}`));
  run(`docker pull ${IMAGE}`);

  console.log(dim(`Volume: ${VOLUME}`));
  runSilent(`docker volume inspect ${VOLUME}`) || run(`docker volume create ${VOLUME}`);

  console.log(dim(`Netwerk: ${INTERNAL_NET}`));
  runSilent(`docker network inspect ${INTERNAL_NET}`) || run(`docker network create --internal ${INTERNAL_NET}`);

  console.log(dim(`Verwijder oude container als die bestaat`));
  runSilent(`docker rm -f ${CONTAINER}`);

  const dockerSock = process.platform === 'win32' ? '//var/run/docker.sock' : '/var/run/docker.sock';

  console.log(dim(`Start container`));
  run(
    `docker run -d` +
    ` --name ${CONTAINER}` +
    ` --network ${INTERNAL_NET}` +
    ` -p ${HOST_PORT}:3000` +
    ` -v ${VOLUME}:/data` +
    ` -v ${dockerSock}:/var/run/docker.sock` +
    ` -v /tmp/dc-sockets:/tmp/dc-sockets` +
    ` ${IMAGE}`,
  );

  runSilent(`docker network connect bridge ${CONTAINER}`);

  console.log();
  console.log(green(`[OK] Huddle draait op http://localhost:${HOST_PORT}`));
}
