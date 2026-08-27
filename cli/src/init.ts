// `huddle init` — bring up both halves of Huddle.
//
// Huddle is two processes now (docs/ADR-huddle-node-split.md):
//
//   Huddle Node     on the HOST — portal, API, database, CA, Docker
//                   orchestration, sbx. Started here, detached.
//   huddle-gateway  in a CONTAINER — the filtering proxies devcontainers are
//                   DNAT'ed to, and nothing else.
//
// Order matters: Node owns the database, the CA and the gateway token, so it has
// to exist before there is anything for the gateway to be handed. The container
// is started second and given exactly three things — where Node is, the token to
// talk to it with, and the CA directory read-only.

import { execFileSync } from 'child_process';
import { bold, green, cyan, dim, red, yellow } from './utils';
import { resolveRuntime } from './runtime';
import { ResolvedImages, baseImageEnv } from './images';
import { readConfig, updateConfig } from './config';
import { bridgeGateway, resolveControlAddress } from './control-address';
import {
  DEFAULT_NODE_PORT,
  MissingNodeEntryError,
  NODE_LOG_FILE,
  nodeCaDir,
  nodeDataDir,
  nodeProbeUrls,
  nodeUrl,
  readGatewayToken,
  readOperatorToken,
  startNodeDetached,
} from './node';
import fs from 'fs';

const CONTAINER = 'huddle';

/**
 * Ask Huddle Node to wire the freshly created gateway into every devcontainer.
 *
 * The container above is brand new, so each existing devcontainer is attached to
 * a `huddle` that no longer exists and DNATs port 80 to an IP that is gone —
 * which is silent, not loud: the devcontainer just stops reaching anything.
 *
 * Node does this itself at boot, but that only covers a first install. Re-running
 * init reuses the Node that is already up while replacing the container, so the
 * request has to come from here. Node's job and not the CLI's, because rebuilding
 * those rules means exec'ing into every devcontainer.
 *
 * Best-effort: a gateway that is up but not yet wired is worth reporting, not
 * worth failing init over — the portal offers a per-container reconnect too.
 */
async function rewireGateway(port: string, token: string | null): Promise<void> {
  const url = `${nodeProbeUrls(port)[0]}/api/docker/rewire-gateway`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const rep = (await res.json()) as { attached?: string[]; refreshed?: string[] };
    const attached = rep.attached?.length ?? 0;
    console.log(dim(`  wired into ${attached} devcontainer network(s), ${rep.refreshed?.length ?? 0} refreshed`));
  } catch (err) {
    console.log(yellow(`[!] Could not wire the gateway into the devcontainer networks: ${(err as Error).message}`));
    console.log(dim('    Existing devcontainers may not reach Huddle until you reconnect them in the portal.'));
  }
}

/**
 * Huddle Node's control channel on the host. Its own port, never the portal's:
 * the portal carries the operator token and stays on loopback, while this one
 * may have to be reachable from the gateway container. Must match
 * HUDDLE_CONTROL_PORT in gateway/src/runtime-env.ts.
 */
const CONTROL_PORT = Number(process.env.HUDDLE_CONTROL_PORT ?? 24843);
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
const HOST_PORT = process.env.HUDDLE_PORT ?? String(DEFAULT_NODE_PORT);

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
 * The directory where each devcontainer's filtered Docker socket is served.
 *
 * ARCHITECTURAL BLOCKER, recorded rather than papered over. This path is on the
 * Docker ENGINE host. That used to be the same machine as the process serving
 * the sockets, because that process was the gateway container. It is Huddle Node
 * now, and Huddle Node runs on the OPERATOR's machine — which is the engine host
 * only when the engine is native (Linux). On Docker Desktop, Rancher and
 * `podman machine` the engine lives in a VM, so Node creates the sockets on
 * macOS/Windows while the devcontainers mount them out of the VM, and the two
 * never meet.
 *
 * Solving it needs a decision that is not this step's to make (serve the sockets
 * over TCP from Node, or keep a socket-serving helper inside the engine). Until
 * then init says so plainly instead of leaving the operator with devcontainers
 * whose Docker access silently does nothing.
 */
function ensureSocketDir(runtime: { name: string; isRemote: boolean }): void {
  console.log(dim(`Socket directory: ${HOST_SOCKET_DIR}`));
  if (!runtime.isRemote) {
    try {
      fs.mkdirSync(HOST_SOCKET_DIR, { recursive: true });
    } catch (err) {
      console.log(yellow(`[!] Could not create ${HOST_SOCKET_DIR}: ${err}`));
    }
    return;
  }
  console.log(yellow(`[!] ${runtime.name} runs its engine in a VM, so ${HOST_SOCKET_DIR} on this`));
  console.log(yellow('    machine is not the directory devcontainers mount. Per-devcontainer'));
  console.log(yellow('    Docker access will not work until Huddle Node can serve those'));
  console.log(yellow('    sockets on the engine host (docs/ADR-huddle-node-split.md).'));
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

  console.log(dim(`Network: ${INTERNAL_NET}`));
  runArgsSilent(rt, ['network', 'inspect', INTERNAL_NET]) || runArgs(rt, ['network', 'create', '--internal', INTERNAL_NET]);

  console.log(dim(`Removing old container if it exists`));
  runArgsSilent(rt, ['rm', '-f', CONTAINER]);

  ensureSocketDir(runtime);

  // ── Huddle Node, on this host ──────────────────────────────────────────────
  //
  // First, because it owns everything the gateway is about to be handed: the
  // database, the CA, and the gateway token.

  // Operator token for the portal and the CLI. Reuse the one in the config (so an
  // existing browser session keeps working across re-inits), otherwise let Huddle
  // Node mint one on first boot and read it back.
  const cfg = readConfig();
  const operatorToken = process.env.HUDDLE_OPERATOR_TOKEN?.trim() || cfg.operatorToken?.trim();

  // Team-managed folders (#69). These used to be bind mounts into the container
  // at fixed paths, because the gateway could not see the host filesystem. Huddle
  // Node runs ON the host, so it just reads the paths where they are.
  const fwFolder = cfg.firewallRulesFolder?.trim();
  const extFolder = cfg.extensionsFolder?.trim();
  if (fwFolder) console.log(dim(`  Firewall-rules folder: ${fwFolder}`));
  if (extFolder) console.log(dim(`  Extensions folder:     ${extFolder}`));

  // Where the gateway will look for the control channel, and therefore which
  // interface Node has to bind it on. The two are one decision, so they are
  // resolved together (control-address.ts).
  const control = resolveControlAddress({
    isRemote: runtime.isRemote,
    port: CONTROL_PORT,
    gatewayIp: bridgeGateway(rt, runtime.defaultNetwork),
    override: process.env.HUDDLE_NODE_CONTROL_URL,
    bindOverride: process.env.HUDDLE_CONTROL_HOST,
  });

  console.log(dim('Starting Huddle Node (host)'));
  const extraEnv: NodeJS.ProcessEnv = { ...baseImageEnv(images), HUDDLE_RUNTIME: runtime.name };
  if (fwFolder) extraEnv.HUDDLE_FIREWALL_RULES_MOUNT = fwFolder;
  if (extFolder) extraEnv.HUDDLE_EXTENSIONS_MOUNT = extFolder;

  let node;
  try {
    node = await startNodeDetached({
      port: HOST_PORT,
      controlHost: control.bindHost,
      operatorToken,
      extraEnv,
    });
  } catch (err) {
    if (err instanceof MissingNodeEntryError) {
      console.error(red('No Huddle Node build found — Huddle cannot start without one.'));
      console.error('');
      console.error('  In a repo checkout, build it first:');
      console.error(cyan('    npm --prefix gateway install && npm --prefix gateway run build'));
      console.error(dim('  Or point at an existing build with HUDDLE_NODE_ENTRY.'));
      process.exit(1);
    }
    throw err;
  }
  console.log(dim(node.reused
    ? `  already running on ${nodeUrl(node.port)}`
    : `  pid ${node.pid}, log ${NODE_LOG_FILE}`));
  console.log(dim(`  control channel: ${control.bindHost}:${CONTROL_PORT} — ${control.reason}`));

  // Huddle Node persists the token it generated on first boot; from here on the
  // CLI reads it rather than inventing one.
  const token = operatorToken ?? readOperatorToken();
  if (token && cfg.operatorToken !== token) updateConfig({ operatorToken: token });

  // ── huddle-gateway, in a container ─────────────────────────────────────────
  //
  // What it gets is the whole list: where Node is, the token to talk to Node
  // with, and the CA directory read-only. No Docker socket, no database volume,
  // no config, no published portal — none of which it can use any more, and each
  // of which was reachable from a devcontainer.
  console.log(dim('Starting huddle-gateway (container)'));
  const gatewayToken = readGatewayToken(nodeDataDir());

  const dockerArgs: string[] = ['run', '-d', '--name', CONTAINER, '--network', runtime.defaultNetwork];
  for (const opt of runtime.securityOpts) dockerArgs.push('--security-opt', opt);
  dockerArgs.push(...control.runArgs);
  dockerArgs.push('-e', 'HUDDLE_ROLE=gateway');
  dockerArgs.push('-e', `HUDDLE_NODE_CONTROL_URL=${control.url}`);
  dockerArgs.push('-e', `HUDDLE_GATEWAY_TOKEN=${gatewayToken}`);
  // Docker Sandboxes (sbx, experimental): publish the gateway's dedicated sbx
  // proxy port to host loopback so the host sbx daemon can forward sandbox egress
  // to Huddle at http://localhost:<port>. Kept on 127.0.0.1 (local only).
  const sbxProxyPort = process.env.HUDDLE_SBX_PROXY_PORT?.trim() || '32768';
  dockerArgs.push('-p', `127.0.0.1:${sbxProxyPort}:${sbxProxyPort}`);
  dockerArgs.push('-e', `HUDDLE_SBX_PROXY_PORT=${sbxProxyPort}`);
  // The MITM CA, read-only. Its own directory precisely so this mount can exist:
  // the rest of ~/.huddle is the database and the operator token.
  dockerArgs.push('-v', `${nodeCaDir()}:/ca:ro`);
  dockerArgs.push(IMAGE);
  runArgs(rt, dockerArgs);

  // Attaching devcontainer-net after the container has started pollutes
  // resolv.conf on Podman with that network's internal aardvark-DNS; the
  // gateway cleans that up itself (see dns-egress.ts / boot-gateway.ts).
  runArgsSilent(rt, ['network', 'connect', INTERNAL_NET, CONTAINER]);

  await rewireGateway(HOST_PORT, token);

  if (!control.reachable) {
    console.log();
    console.log(yellow('[!] Could not work out how the gateway container reaches this host.'));
    console.log(yellow('    The control channel is bound to loopback, which the container'));
    console.log(yellow('    probably cannot reach — and a gateway without policy denies'));
    console.log(yellow('    every request rather than allowing them.'));
    console.log(dim('    Fix it by naming the address yourself and re-running init:'));
    console.log(cyan('      HUDDLE_CONTROL_HOST=<address the container reaches this host on> huddle init'));
  }

  console.log();

  console.log(green(`[OK] Huddle is running at ${nodeUrl(HOST_PORT)}`));
  console.log();

  // Docker Sandboxes (sbx): sbx is a host binary, driven by Huddle Node on the
  // host — there is nothing to start here. What still has to happen at init time
  // is the host trust store, and only when sbx is actually installed. Best-effort;
  // never fails the init.
  try {
    const { resolveSbxBin } = await import('./sbx-host');
    const bin = resolveSbxBin();
    const sbxPresent = (() => { try { execFileSync(bin, ['version'], { stdio: 'ignore', timeout: 15000 }); return true; } catch { return false; } })();
    if (sbxPresent) {
      // Huddle's CA has to be trusted on the HOST too, not just inside each
      // sandbox: sbx terminates TLS itself for some hosts (measured on
      // platform.claude.com) and then validates Huddle's leaf against the host
      // trust store. Without this the sandbox gets "Empty reply from server"
      // and `claude` fails with ECONNRESET. See cli/src/sbx-host-ca.ts.
      const { installHostCa, printHostCaResult } = await import('./sbx-host-ca');
      printHostCaResult(installHostCa());
    } else {
      console.log(dim('  (sbx not found on PATH — install Docker Sandboxes to use sbx boxes)'));
    }
  } catch (err) {
    console.log(dim(`  (could not prepare sbx on the host: ${(err as Error).message})`));
  }
  console.log();
  // Full auto-login link: open it and the portal logs you in automatically with
  // the operator token (the frontend reads ?token=..., logs in and then removes it
  // from the address bar). This way you don't have to paste anything.
  const loginUrl = `${nodeUrl(HOST_PORT)}/?token=${encodeURIComponent(token ?? '')}`;
  console.log(bold('Open the portal (auto-login link):'));
  console.log(green(`    ${loginUrl}`));
  console.log(dim('  Opens the portal and logs you in automatically.'));
  console.log(dim(`  Manual token (if you prefer to paste it): ${token}`));
  console.log(dim('  The token is also saved to ~/.huddle/config.json for the CLI.'));
}
