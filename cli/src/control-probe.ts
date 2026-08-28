// Does the gateway container ACTUALLY reach Huddle Node?
//
// control-address.ts derives an answer from what the engine says it is. That
// derivation has one assumption in it — "engine in a VM ⇒ the host is reachable
// on its loopback via host.docker.internal" — and it is false on Rancher
// Desktop for Windows: the engine runs in a WSL distro, `host.docker.internal`
// resolves to that distro's docker0 gateway (172.17.0.1), and Huddle Node is a
// Windows process bound to the Windows loopback. The name resolves, nothing
// listens, and the gateway fails closed: every devcontainer is denied all egress
// and nothing is filed as `requested`, because a gateway with no policy is not
// allowed to invent one.
//
// A derivation cannot tell that apart from a working setup. A connection can.
// So init stops guessing: it starts Node, then opens the real connection from a
// throwaway container, and only trusts an address that answered.
//
// Split from control-address.ts because everything here SPAWNS — the pure
// decision stays testable without an engine, and the parsers below are exported
// for the same reason.

import { execFileSync } from 'child_process';
import os from 'os';

/** How long any single engine call may take before we call it a failure. */
const PROBE_TIMEOUT_MS = 25_000;

/**
 * Run the probe inside the gateway image itself.
 *
 * That image, not a stock one: it is already present (init just pulled or built
 * it), so this costs no download, and it is the exact runtime the real gateway
 * uses — same Node, same DNS resolution, same TLS stack.
 */
function runInImage(
  rt: string,
  image: string,
  runArgs: string[],
  entrypoint: string,
  cmdArgs: string[] = [],
): string | null {
  try {
    return execFileSync(
      rt,
      ['run', '--rm', '--entrypoint', entrypoint, ...runArgs, image, ...cmdArgs],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PROBE_TIMEOUT_MS },
    );
  } catch {
    return null;
  }
}

// The script the probe container runs. One line, because it travels as an argv
// entry through a shell on Windows. A 4s timeout of its own: an address that is
// silently dropped (a host firewall) must come back as a result, not as a hang.
const PROBE_SCRIPT =
  "fetch(process.env.PROBE_URL + '/control/health', { signal: AbortSignal.timeout(4000) })" +
  ".then(r => console.log('PROBE_HTTP ' + r.status))" +
  ".catch(e => console.log('PROBE_ERR ' + ((e.cause && e.cause.code) || e.name || e.message)))";

export interface ProbeResult {
  /** Did Huddle Node answer at all? Any HTTP status counts — see below. */
  reachable: boolean;
  /** What came back, for the operator: an HTTP status or an errno. */
  detail: string;
}

/**
 * Read the probe container's single line of output.
 *
 * ANY HTTP status means reachable, and 401 is the expected one: /control/health
 * is behind the gateway token and the probe deliberately sends none. What is
 * being tested is whether the packets arrive, not whether we are authorised —
 * the token is checked separately, and conflating the two is how "unreachable"
 * ends up hiding a token mismatch.
 */
export function parseProbeOutput(out: string | null): ProbeResult {
  if (out === null) return { reachable: false, detail: 'the probe container could not be started' };
  const line = out.split('\n').map((l) => l.trim()).filter(Boolean).pop() ?? '';
  const http = /^PROBE_HTTP (\d+)$/.exec(line);
  if (http) return { reachable: true, detail: `HTTP ${http[1]}` };
  const err = /^PROBE_ERR (.+)$/.exec(line);
  if (err) return { reachable: false, detail: err[1] };
  return { reachable: false, detail: line || 'no output' };
}

/**
 * Open the control channel from where the gateway will open it: same image,
 * same network, same --add-host arguments. Anything less tests a different path
 * than the one that has to work.
 */
export function probeControlUrl(
  rt: string,
  image: string,
  url: string,
  network: string,
  runArgs: string[],
): ProbeResult {
  const out = runInImage(
    rt,
    image,
    ['--network', network, ...runArgs, '-e', `PROBE_URL=${url}`],
    'node',
    ['-e', PROBE_SCRIPT],
  );
  return parseProbeOutput(out);
}

/**
 * Pull the gateway out of `ip route show default`.
 *
 * Two shapes, since busybox and iproute2 order the fields differently:
 *   default via 172.20.144.1 dev eth0 proto kernel
 *   default dev eth0 scope link src 10.0.0.5 via 10.0.0.1
 * so match on `via <ip>` wherever it sits rather than on a field position.
 */
export function parseDefaultGateway(routeOutput: string | null): string | null {
  if (!routeOutput) return null;
  for (const line of routeOutput.split('\n')) {
    if (!line.trim().startsWith('default')) continue;
    const via = /\bvia\s+(\d{1,3}(?:\.\d{1,3}){3})\b/.exec(line);
    if (via && via[1].split('.').every((o) => Number(o) <= 255)) return via[1];
  }
  return null;
}

/**
 * The address of the machine the ENGINE runs on, seen from inside the engine.
 *
 * `--network host` puts the probe in the engine host's own network namespace —
 * the WSL distro on Rancher Desktop, the Linux VM elsewhere — so its default
 * route names the next hop out of that namespace. On WSL that next hop is the
 * Windows host, on the vEthernet adapter the two share, which is exactly the
 * address a container can reach and `host.docker.internal` failed to name.
 *
 * Only worth asking when the derived address did not answer: on Docker Desktop
 * this returns the VM's own internal gateway, which is not what anyone wants.
 */
export function engineHostAddress(rt: string, image: string): string | null {
  return parseDefaultGateway(runInImage(rt, image, ['--network', 'host'], 'ip', ['-4', 'route', 'show', 'default']));
}

/**
 * The other names and addresses a container might reach this machine on, tried
 * only when the derived one did not answer.
 *
 * `host.docker.internal` is not a promise. Rancher Desktop points it at the
 * WSL distro's own docker0 gateway, which is the distro, not this machine —
 * measured, and it is what sent us here. So try the aliases other engines
 * publish, and then the one address that is not a guess at all:
 *
 * Rancher Desktop and `podman machine` both route the VM through
 * gvisor-tap-vsock, which serves 192.168.127.0/24 with the gateway on .1 and
 * THIS MACHINE on .254 — a userspace forwarder running here, so it reaches the
 * host loopback exactly like Docker Desktop's alias does. Derived from whatever
 * gateway the engine reported rather than hardcoded, because the subnet is
 * configurable.
 *
 * Every one of these is a candidate, not an answer: each is probed, and only an
 * address that replies is used.
 */
export function hostCandidateUrls(port: number | string, vmGateway: string | null): string[] {
  const hosts = ['host.rancher-desktop.internal', 'host.containers.internal'];
  const octets = vmGateway ? /^(\d{1,3}\.\d{1,3}\.\d{1,3})\.\d{1,3}$/.exec(vmGateway) : null;
  if (octets) hosts.push(`${octets[1]}.254`);
  return hosts.map((h) => `http://${h}:${port}`);
}

/** Every IPv4 address this machine actually has, loopback excluded. */
export function localIpv4Addresses(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) out.push(a.address);
    }
  }
  return out;
}

/**
 * An address Huddle Node can BIND that the engine can also reach.
 *
 * Both halves matter, and the second one is the trap: the engine's default
 * gateway is not this machine. On Rancher Desktop it is 192.168.127.1, served by
 * a forwarder — binding it fails with EADDRNOTAVAIL and takes Huddle Node down
 * with it, which is exactly how a control-channel fix turned into no Huddle at
 * all. So only ever offer an address this machine really owns, on the same
 * subnet the engine routes through.
 */
export function pickBindAddress(local: string[], vmGateway: string | null): string | null {
  if (!vmGateway) return null;
  const prefix = vmGateway.replace(/\.\d+$/, '.');
  return local.find((a) => a.startsWith(prefix)) ?? null;
}
