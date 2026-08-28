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
import { bridgeGateway, resolveControlAddress, HOST_ALIAS, type ControlAddress } from './control-address';
import {
  engineHostAddress,
  hostCandidateUrls,
  localIpv4Addresses,
  pickBindAddress,
  probeControlUrl,
} from './control-probe';
import {
  DEFAULT_NODE_PORT,
  MissingNodeEntryError,
  NODE_LOG_FILE,
  NODE_PID_FILE,
  nodeCaDir,
  nodeDataDir,
  nodeProbeUrls,
  nodeUrl,
  pingNode,
  readGatewayToken,
  readOperatorToken,
  startNodeDetached,
  stopNode,
} from './node';

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
 * Confirm the gateway can actually reach Huddle Node — and move the control
 * channel if it cannot.
 *
 * resolveControlAddress() derives an address from what the engine reports about
 * itself, and that derivation is right until it is not: on Rancher Desktop for
 * Windows the engine is a WSL distro, so `host.docker.internal` resolves to that
 * distro's own docker0 gateway while Huddle Node is a Windows process on the
 * Windows loopback. Both halves are healthy and they cannot see each other.
 *
 * There is no way to tell that from a derivation, and getting it wrong is
 * expensive: the gateway fails closed, so every devcontainer is denied all
 * egress and nothing appears in the portal to approve — a firewall that looks
 * installed and blocks everything. So open the connection for real, from the
 * gateway's own image on the gateway's own network, and believe the result.
 *
 * `rebind` restarts Huddle Node on a different interface and reports whether it
 * managed to. Passed in rather than done here because init owns the options
 * Node was started with.
 */
async function verifyControlChannel(
  rt: string,
  image: string,
  network: string,
  control: ControlAddress,
  rebind: (bindHost: string) => Promise<boolean>,
): Promise<ControlAddress> {
  const first = probeControlUrl(rt, image, control.url, network, control.runArgs);
  if (first.reachable) {
    console.log(dim(`  reachable from a container at ${control.url} (${first.detail})`));
    return { ...control, reachable: true };
  }

  const unreachable = (fixed: ControlAddress, detail: string): ControlAddress => {
    console.log(yellow(`[!] The gateway cannot reach Huddle Node at ${fixed.url} (${detail}).`));
    console.log(yellow('    It fails closed, so every devcontainer will be denied all egress and'));
    console.log(yellow('    nothing will show up in the portal to approve.'));
    return { ...fixed, reachable: false };
  };

  // An address someone named by hand is not ours to overrule — they know their
  // own topology, and silently moving the channel would hide the real problem.
  if (process.env.HUDDLE_NODE_CONTROL_URL?.trim() || process.env.HUDDLE_CONTROL_HOST?.trim()) {
    const out = unreachable(control, first.detail);
    console.log(dim('    That address was set explicitly, so it is left as it is.'));
    return out;
  }

  console.log(dim(`  ${control.url} did not answer (${first.detail}) — looking for an address that does`));
  const vmGateway = engineHostAddress(rt, image);

  // Cheapest first: another way for the container to reach the loopback Node is
  // already bound to. Nothing restarts, and nothing about how Huddle is exposed
  // changes — so this is the outcome to want, not merely the quickest one.
  for (const url of hostCandidateUrls(CONTROL_PORT, vmGateway)) {
    const probe = probeControlUrl(rt, image, url, network, []);
    if (!probe.reachable) continue;
    console.log(dim(`  reachable from a container at ${url} (${probe.detail})`));
    return {
      bindHost: control.bindHost,
      url,
      runArgs: [],
      reason: `${HOST_ALIAS} does not reach this machine from ${rt}; ${new URL(url).hostname} does`,
      reachable: true,
    };
  }

  // Nothing reaches loopback, so Huddle Node has to move to an interface the
  // engine can route to. Only an address this machine actually owns: the
  // engine's own gateway is not one, and binding it kills Node outright.
  const bindIp = pickBindAddress(localIpv4Addresses(), vmGateway);
  if (!bindIp) {
    const out = unreachable(control, first.detail);
    console.log(dim(`    Tried every address ${rt} suggested${vmGateway ? ` (its gateway is ${vmGateway})` : ''}.`));
    console.log(dim('    Name one yourself and re-run init:'));
    console.log(cyan('      HUDDLE_CONTROL_HOST=<address the container reaches this machine on> huddle init'));
    return out;
  }

  const moved: ControlAddress = {
    bindHost: bindIp,
    url: `http://${bindIp}:${CONTROL_PORT}`,
    runArgs: [],
    reason: `${HOST_ALIAS} does not reach this machine; ${rt} routes to it at ${bindIp}`,
    reachable: false,
  };
  console.log(dim(`  moving the control channel to ${bindIp} and restarting Huddle Node`));
  if (!(await rebind(bindIp))) {
    // Put it back where it was. A control channel that does not work is a broken
    // firewall; no Huddle Node at all is a broken machine — no portal, no API,
    // and init about to hand the gateway a token it cannot read.
    console.log(yellow(`[!] Huddle Node would not start on ${bindIp} — restoring ${control.bindHost}.`));
    if (!(await rebind(control.bindHost))) {
      console.log(red('    It would not start there either. Check the log:'));
      console.log(cyan(`      ${NODE_LOG_FILE}`));
    }
    const out = unreachable(control, first.detail);
    console.log(dim('    Name an address yourself and re-run init:'));
    console.log(cyan('      HUDDLE_CONTROL_HOST=<address the container reaches this machine on> huddle init'));
    return out;
  }

  const second = probeControlUrl(rt, image, moved.url, network, []);
  if (second.reachable) {
    console.log(dim(`  reachable from a container at ${moved.url} (${second.detail})`));
    return { ...moved, reachable: true };
  }

  const out = unreachable(moved, second.detail);
  console.log(dim(`    ${rt} routes to this machine at ${bindIp} and Huddle Node is bound there,`));
  console.log(dim('    so something here is dropping the connection. On Windows that is Defender'));
  console.log(dim(`    Firewall: allow inbound TCP ${CONTROL_PORT} for node.exe on that adapter.`));
  console.log(dim('    Nothing needs re-running afterwards — the gateway keeps retrying.'));
  return out;
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
 * Report where each devcontainer's filtered Docker socket will be served.
 *
 * On the ENGINE host, and by the GATEWAY — which is the only process guaranteed
 * to be there. Huddle Node is on the operator's machine, and that is the engine
 * host only when the engine is native: on Docker Desktop, Rancher and `podman
 * machine` the engine lives in a VM, so a socket Node created would sit on
 * macOS/Windows while the devcontainer mounts one out of the VM. Node keeps the
 * filter — the security boundary — and the gateway tunnels each connection to
 * it over the control channel (gateway/src/control/socket-relay-protocol.ts).
 *
 * Nothing to create here, therefore: the directory is the gateway's bind mount,
 * and the engine makes it on the engine side when it does not exist.
 */
function reportSocketDir(): void {
  console.log(dim(`Socket directory: ${HOST_SOCKET_DIR} (on the engine host, served by the gateway)`));
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

  reportSocketDir();

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
  let control = resolveControlAddress({
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

  // Both halves are up; now prove they can see each other, before the gateway is
  // handed an address it may never reach.
  control = await verifyControlChannel(rt, IMAGE, runtime.defaultNetwork, control, async (bindHost) => {
    // A running Node keeps the interface it was started on, and startNodeDetached
    // deliberately reuses one that answers — so it has to actually stop first.
    await stopNode();
    for (let i = 0; i < 40 && (await pingNode(HOST_PORT)); i++) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (await pingNode(HOST_PORT)) return false;
    try {
      node = await startNodeDetached({ port: HOST_PORT, controlHost: bindHost, operatorToken, extraEnv });
      return true;
    } catch {
      // Reported by the caller, which knows whether this was the move or the
      // rollback. Throwing here would abort init with Huddle Node already down.
      return false;
    }
  });

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
  // Where the per-devcontainer Docker sockets live. Both sides of this bind are
  // the ENGINE host's path, which is the point: the gateway creates the socket
  // here and the devcontainer mounts the same path, so the two meet whether or
  // not the engine runs in a VM. Read-write, and it has to be: creating those
  // sockets is the job. It grants nothing — the filter behind them is Huddle
  // Node's, and reaching it costs the gateway token.
  dockerArgs.push('-v', `${HOST_SOCKET_DIR}:${HOST_SOCKET_DIR}`);
  dockerArgs.push(IMAGE);
  runArgs(rt, dockerArgs);

  // Attaching devcontainer-net after the container has started pollutes
  // resolv.conf on Podman with that network's internal aardvark-DNS; the
  // gateway cleans that up itself (see dns-egress.ts / boot-gateway.ts).
  runArgsSilent(rt, ['network', 'connect', INTERNAL_NET, CONTAINER]);

  await rewireGateway(HOST_PORT, token);

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
