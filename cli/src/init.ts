import { execFileSync } from 'child_process';
import crypto from 'crypto';
import { bold, green, dim, yellow } from './utils';
import { resolveRuntime } from './runtime';
import { ResolvedImages, gatewayEnvArgs } from './images';
import { readConfig, updateConfig, CONFIG_DIR } from './config';
import fs from 'fs';
import os from 'os';
import path from 'path';

const CONTAINER = 'huddle';
const VOLUME = 'huddle-data';
/**
 * The shared, internal network that `huddle init` creates (`--internal`, so it
 * has no route to the internet of its own). Devcontainers attach to it to reach
 * the Huddle proxy — it is the only way out. Exported so `huddle migrate` can
 * point an existing Compose project at the exact same network.
 */
export const INTERNAL_NET = 'devcontainer-net';
/**
 * Directory on the Docker ENGINE host where the gateway serves each
 * devcontainer's filtered Docker socket (`<HOST_SOCKET_DIR>/<container_name>`).
 * Kept in sync with SOCKET_DIR in gateway/src/docker.ts. Exported so
 * `huddle migrate` can generate the matching bind mount.
 */
export const HOST_SOCKET_DIR = '/tmp/dc-sockets';
const HOST_PORT = process.env.HUDDLE_PORT ?? '3000';

export interface InitOptions {
  runtime?: string;
}

// Run a binary with an argv array — NO shell. Values that originate from config
// (team-folder paths, which are writable via `huddle firewall folder set` and the
// authenticated settings API) must never be interpolated into a shell string, or
// a path containing `$()`/quotes would execute on the host. Used for `docker run`.
function runArgs(file: string, args: string[]): void {
  execFileSync(file, args, { stdio: 'inherit' });
}

function runArgsSilent(file: string, args: string[]): boolean {
  try {
    execFileSync(file, args, { stdio: 'ignore' });
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
      runArgs(rt, ['pull', image]);
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
    runArgs(rt, ['pull', IMAGE]);
    pullBaseImages(rt, images.baseImages.map((b) => b.image));
  }

  console.log(dim(`Volume: ${VOLUME}`));
  runArgsSilent(rt, ['volume', 'inspect', VOLUME]) || runArgs(rt, ['volume', 'create', VOLUME]);

  console.log(dim(`Network: ${INTERNAL_NET}`));
  runArgsSilent(rt, ['network', 'inspect', INTERNAL_NET]) || runArgs(rt, ['network', 'create', '--internal', INTERNAL_NET]);

  console.log(dim(`Removing old container if it exists`));
  runArgsSilent(rt, ['rm', '-f', CONTAINER]);

  console.log(dim(`Socket directory: /tmp/dc-sockets`));
  // The mount SOURCE must be the path on the Docker ENGINE host (on Windows:
  // the WSL2/Linux VM), even when the CLI itself runs on Windows. The gateway
  // (SOCKET_DIR in docker.ts) and every devcontainer socket mount rely on
  // /tmp/dc-sockets on the engine host; mounting a Windows temp dir splits
  // gateway and devcontainers across two filesystems, and Unix sockets are
  // unreliable on such a drvfs/9p mount anyway.
  const hostTmpSockets = HOST_SOCKET_DIR;
  if (runtime.isRemote) {
    if (runtime.name === 'podman') {
      // Podman does NOT create a missing bind source itself (unlike Docker
      // Desktop) and fails with "statfs: no such file or directory". So create
      // the directory explicitly in the machine VM; the socket lives there too.
      console.log(dim(`  (Podman: creating ${hostTmpSockets} in the machine VM)`));
      if (!runArgsSilent('podman', ['machine', 'ssh', `mkdir -p ${hostTmpSockets}`])) {
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
  // SELinux-labeled proxy socket. (Applied as argv below via runtime.securityOpts.)

  // Operator token for control-plane auth. Reuse the token from the config (so an
  // existing browser session/CLI keeps working across re-inits), otherwise
  // generate one. We pass it to the gateway via env AND store it locally so that
  // subsequent `huddle` commands can authenticate.
  const cfg = readConfig();
  const operatorToken =
    process.env.HUDDLE_OPERATOR_TOKEN?.trim() ||
    (cfg.operatorToken && cfg.operatorToken.trim()) ||
    crypto.randomBytes(32).toString('base64url');
  if (cfg.operatorToken !== operatorToken) {
    updateConfig({ operatorToken });
  }
  // The container is created on the engine's default network first (with -p),
  // then joins devcontainer-net (--internal) afterwards: Docker skips the host
  // port-forward entirely when a container is created directly on an --internal
  // network (moby/moby#36174). Which source IP the gateway sees for forwarded
  // traffic no longer matters — the control plane authenticates with the
  // operator token instead of source-IP filtering.
  // Team-managed folders (#69). Bind the CLI config dir (~/.huddle) read-write so
  // the gateway/portal read and write the folder paths there (config.json is the
  // single source of truth), then bind each configured team folder to a FIXED
  // path so the gateway reads it without knowing the host path. The firewall-rules
  // folder is bound read-write so the portal's "Sync to folder" can write the
  // groups back out; extensions stay read-only (loaded, never written).
  const fwFolder = cfg.firewallRulesFolder?.trim();
  const extFolder = cfg.extensionsFolder?.trim();
  if (fwFolder) console.log(dim(`  Mounting firewall-rules folder: ${fwFolder} -> /firewall-rules`));
  if (extFolder) console.log(dim(`  Mounting extensions folder:     ${extFolder} -> /extensions`));
  // Build the container command as an argv array (runArgs → execFileSync, no
  // shell). The folder paths below come from config and are operator-writable via
  // the settings API, so they must never reach a shell as a string.
  const dockerArgs: string[] = ['run', '-d', '--name', CONTAINER, '--network', runtime.defaultNetwork];
  for (const opt of runtime.securityOpts) dockerArgs.push('--security-opt', opt);
  dockerArgs.push('-e', `HUDDLE_RUNTIME=${runtime.name}`);
  dockerArgs.push('-e', `HUDDLE_OPERATOR_TOKEN=${operatorToken}`);
  dockerArgs.push('-p', `${HOST_PORT}:3000`);
  // Docker Sandboxes (sbx, experimental): publish the gateway's dedicated sbx
  // proxy port to host loopback so the host sbx daemon can forward sandbox egress
  // to Huddle at http://localhost:<port>. Kept on 127.0.0.1 (local only). Must
  // match the gateway's HUDDLE_SBX_PROXY_PORT (default 32768).
  const sbxProxyPort = process.env.HUDDLE_SBX_PROXY_PORT?.trim() || '32768';
  dockerArgs.push('-p', `127.0.0.1:${sbxProxyPort}:${sbxProxyPort}`);
  dockerArgs.push('-e', `HUDDLE_SBX_PROXY_PORT=${sbxProxyPort}`);
  dockerArgs.push('-v', `${VOLUME}:/data`);
  dockerArgs.push('-v', `${runtime.socketPath}:/var/run/docker.sock`);
  dockerArgs.push('-v', `${hostTmpSockets}:/tmp/dc-sockets`);
  dockerArgs.push('-v', `${CONFIG_DIR}:/huddle-home:rw`, '-e', 'HUDDLE_HOME_DIR=/huddle-home');
  if (fwFolder) dockerArgs.push('-v', `${fwFolder}:/firewall-rules:rw`);
  if (extFolder) dockerArgs.push('-v', `${extFolder}:/extensions:ro`);
  // Docker Sandboxes (sbx, experimental): the gateway can't run sbx itself (sbx
  // runs on the host / on Windows). We bridge with a simple FILE MAILBOX over a
  // shared folder — no sockets, no networking. The container's `sbx` (baked into
  // the image) drops a request file here; a host watcher (bridge/sbx-watcher.sh)
  // runs the real sbx and writes the response back. Mount that folder in and tell
  // the gateway where it is. See run-sandbox-mode.sh + bridge/.
  // The folder itself is created (with req/ res/) by run-sandbox-mode.sh, the host
  // watcher, and the container-side mailbox client — so we don't mkdir here (a
  // git-bash path like /c/Users/... resolves wrong under Windows node anyway).
  const sbxBridgeHost =
    process.env.HUDDLE_SBX_BRIDGE_WIN?.trim() || path.join(os.homedir(), '.huddle-sbx');
  console.log(dim(`  Mounting sbx bridge folder:     ${sbxBridgeHost} -> /sbx-bridge`));
  dockerArgs.push('-v', `${sbxBridgeHost}:/sbx-bridge`);
  dockerArgs.push('-e', 'HUDDLE_SBX_BRIDGE=/sbx-bridge');
  dockerArgs.push(...gatewayEnvArgs(images));
  dockerArgs.push(IMAGE);
  runArgs(rt, dockerArgs);

  // Attaching devcontainer-net after the container has started pollutes
  // resolv.conf on Podman with that network's internal aardvark-DNS; the
  // gateway cleans that up itself (see dns-egress.ts / the startup sanitize in
  // index.ts).
  runArgsSilent(rt, ['network', 'connect', INTERNAL_NET, CONTAINER]);

  console.log();
  console.log(green(`[OK] Huddle is running at http://localhost:${HOST_PORT}`));
  console.log();

  // Docker Sandboxes (sbx): auto-start the host bridge so the containerized
  // gateway can drive sbx (create/list/exec/policy) over the mounted folder.
  // Only when sbx is actually installed — otherwise it's a no-op the user
  // doesn't need. Best-effort; never fails the init.
  try {
    const { resolveSbxBin, startBridge } = await import('./sbx-bridge');
    const bin = resolveSbxBin();
    const sbxPresent = (() => { try { execFileSync(bin, ['version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } })();
    if (sbxPresent) {
      startBridge({ quiet: false });
    } else {
      console.log(dim('  (sbx not found on PATH — sandbox bridge not started; install Docker Sandboxes to use sbx boxes)'));
    }
  } catch (err) {
    console.log(dim(`  (could not start sbx bridge: ${(err as Error).message})`));
  }
  console.log();
  // Full auto-login link: open it and the portal logs you in automatically with
  // the operator token (the frontend reads ?token=..., logs in and then removes it
  // from the address bar). This way you don't have to paste anything.
  const loginUrl = `http://localhost:${HOST_PORT}/?token=${encodeURIComponent(operatorToken)}`;
  console.log(bold('Open the portal (auto-login link):'));
  console.log(green(`    ${loginUrl}`));
  console.log(dim('  Opens the portal and logs you in automatically.'));
  console.log(dim(`  Manual token (if you prefer to paste it): ${operatorToken}`));
  console.log(dim('  The token is also saved to ~/.huddle/config.json for the CLI.'));
}
