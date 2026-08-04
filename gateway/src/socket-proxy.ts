import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { isHostPortApproved } from './db';
import { authorizeAction, classifyRequest, getMountPermissions, MountPermissions } from './docker-actions';

// Default mount policy when no per-container perms are supplied (e.g. unit
// tests): all mount kinds denied. Mirrors the secure-by-default catalog in
// docker-actions.ts; the runtime always passes explicit per-container perms.
const DEFAULT_MOUNT_PERMS: MountPermissions = { bind: false, named: false, anonymous: false };

function mountDenied(kind: string): string {
  return `${kind} mounts are disabled for this devcontainer. Enable them in the Huddle portal.`;
}

const DOCKER_SOCKET = '/var/run/docker.sock';
const proxyServers = new Map<string, net.Server>();

// ── Devcontainer registry ─────────────────────────────────────────────────────

const devcontainerIds = new Set<string>();

export function registerDevcontainer(name: string, id: string): void {
  devcontainerIds.add(name);
  if (id) { devcontainerIds.add(id); devcontainerIds.add(id.slice(0, 12)); }
}

// ── Docker helpers ────────────────────────────────────────────────────────────

function dockerGet(urlPath: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath: DOCKER_SOCKET, path: urlPath, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (d: Buffer) => { body += d.toString(); });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('parse')); } });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function hasOwnLabel(type: 'container' | 'image', targetId: string, containerName: string): Promise<boolean> {
  try {
    const urlPath = type === 'container'
      ? `/containers/${encodeURIComponent(targetId)}/json`
      : `/images/${encodeURIComponent(targetId)}/json`;
    const data = await dockerGet(urlPath);
    const labels: Record<string, string> = data.Config?.Labels ?? {};
    return labels['huddle.parent'] === containerName;
  } catch { return false; }
}

// Ownership lookup for networks and volumes: returns the huddle.parent label and
// the real name (the path may also contain an ID).
async function lookupParentLabel(kind: 'network' | 'volume', id: string): Promise<{ parent: string | null; name: string }> {
  try {
    const data = await dockerGet(
      kind === 'network' ? `/networks/${encodeURIComponent(id)}` : `/volumes/${encodeURIComponent(id)}`
    );
    return { parent: data.Labels?.['huddle.parent'] ?? null, name: data.Name ?? '' };
  } catch { return { parent: null, name: '' }; }
}

function lookupContainerId(containerName: string): Promise<{ id: string; shortId: string }> {
  return dockerGet(`/containers/${encodeURIComponent(containerName)}/json`)
    .then(data => { const id: string = data.Id ?? ''; return { id, shortId: id.slice(0, 12) }; })
    .catch(() => ({ id: '', shortId: '' }));
}

// Add/merge a label filter into a Docker API query string.
//
// The Docker client (CLI/compose, API 1.55) still sends `filters` in the
// legacy map format: `{"label":{"foo=bar":true},"status":{"running":true}}`. The
// daemon accepts that, but also the array format (`{"label":["foo=bar"]}`).
// What the daemon does NOT accept is a mixed form — and that is what we got if we
// only converted `label` to an array and left the other keys (e.g. `status`) as
// a map: that produces "Error response from daemon: invalid filter" and
// breaks `docker compose up` among others. Therefore normalize EVERY key to the
// array format before adding the label filter.
function toArrayFilter(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') return Object.keys(value as object);
  return [];
}

export function withLabelFilter(rawUrl: string, label: string): string {
  const qi = rawUrl.indexOf('?');
  const base = qi === -1 ? rawUrl : rawUrl.slice(0, qi);
  const params = new URLSearchParams(qi === -1 ? '' : rawUrl.slice(qi + 1));
  let raw: Record<string, unknown> = {};
  try { raw = JSON.parse(params.get('filters') ?? '{}'); } catch {}
  const filters: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw)) filters[k] = toArrayFilter(v);
  filters.label = [...(filters.label ?? []), label];
  params.set('filters', JSON.stringify(filters));
  return `${base}?${params.toString()}`;
}

function rewriteFirstLine(headerPart: string, newUrl: string): string {
  const lines = headerPart.split('\r\n');
  const parts = (lines[0] ?? '').split(' ');
  lines[0] = `${parts[0]} ${newUrl} ${parts[2]}`;
  return lines.join('\r\n');
}

// ── Policy ────────────────────────────────────────────────────────────────────
// The former all-or-nothing grant check has been replaced by fine-grained
// per-action authorization: classifyRequest determines the action, authorizeAction
// (docker-actions.ts) combines the toggle state with the grant timer.

// ── HostConfig policy: allowlist instead of denylist ────────────────────────
// Root cause of findings #1 (VolumesFrom) and #2 (DeviceCgroupRules): the old
// validation was a DENYLIST over a spec that Huddle does not own — every field that
// Docker adds (or that we forgot) slipped through unseen. The new
// approach:
//   1. Value-specific HARD-DENIES for the confirmed escape vectors and the
//      classics — always enforced, regardless of the mode. This closes #1/#2/etc.
//   2. A generic ALLOWLIST sweep over the remaining keys: a key that
//      we do not know and that carries a non-empty value is suspicious. This catches
//      every FUTURE field without us having to know it.
//
// The Docker CLI/compose sends nearly the entire HostConfig struct along, usually
// with zero/empty values. That is why the sweep only flags NON-empty values on
// unknown keys. Because the exact set of "genuinely-needed" fields can only be
// established empirically (against real dev flows), the sweep runs by default
// in LOG-ONLY mode (warns, does not deny). Set HUDDLE_HOSTCONFIG_ENFORCE=1
// to enforce once the allowlist has been validated against real traffic. The
// hard-denies are independent of this and are always active.

// Keys that a spawned sandbox container may legitimately set with a meaningful
// value (resource limits, lifecycle, logging, ports, named
// volumes). Deliberately no host/device/privilege fields.
const ALLOWED_HOSTCONFIG_KEYS = new Set<string>([
  'NetworkMode',
  'Memory', 'MemoryReservation', 'MemorySwap', 'MemorySwappiness', 'KernelMemory',
  'NanoCpus', 'CpuShares', 'CpuQuota', 'CpuPeriod', 'CpuRealtimePeriod',
  'CpuRealtimeRuntime', 'CpusetCpus', 'CpusetMems', 'CpuCount', 'CpuPercent',
  'BlkioWeight', 'PidsLimit', 'OomKillDisable', 'OomScoreAdj', 'ShmSize',
  'RestartPolicy', 'AutoRemove', 'LogConfig', 'Init',
  'Binds', 'Mounts', 'VolumeDriver',
  'PortBindings', 'PublishAllPorts',
  'Ulimits', 'Dns', 'DnsOptions', 'DnsSearch', 'ExtraHosts', 'GroupAdd',
  'CapDrop', 'ReadonlyRootfs', 'Isolation', 'ConsoleSize', 'Annotations',
]);

// Keys with their own value-specific hard-deny below. They are "known"
// to the sweep (their dangerous value is already denied earlier; an innocuous
// value — e.g. Privileged:false, IpcMode:'private' — may pass).
const HARD_CHECKED_HOSTCONFIG_KEYS = new Set<string>([
  'Privileged', 'PidMode', 'IpcMode', 'UsernsMode', 'CgroupnsMode', 'UTSMode',
  'CgroupParent', 'CapAdd', 'Devices', 'Sysctls', 'SecurityOpt',
  'VolumesFrom', 'DeviceCgroupRules', 'DeviceRequests',
  'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps',
  // Overrides with which a container could weaken the daemon's secure defaults
  // (PoC `mask`: unmask /proc/kcore + /proc/sysrq-trigger). Any
  // present value — including an empty array — is hard-denied.
  'MaskedPaths', 'ReadonlyPaths',
]);

// ── Parser-differential hardening (PoC findings #1a/#1b/#1c + exec #7) ────────
// The Docker daemon (Go encoding/json) matches struct fields CASE-INSENSITIVELY
// and merges duplicate keys; this proxy read keys case-sensitively. That way
// `{"hostconfig":{…}}` (top-level lowercase), `{"HostConfig":{"privileged":
// true}}` (lowercase inner) or a lowercase `type` in Mounts bypassed every check, while
// the daemon did honor them. Defense in three layers:
//   1. findAmbiguousKey — deny EVERY case-insensitive duplicate key, anywhere in
//      the body. Fail-closed, and it makes the lowercase view below unambiguous.
//   2. deepLowerKeys — validate on a deeply-lowercased copy so the checks
//      see exactly what the daemon will honor, regardless of the casing.
//   3. renameKeyCI — canonicalize the keys that the proxy itself injects into
//      (HostConfig/Labels/Env/NetworkingConfig/NetworkMode) so that a lowercase
//      variant does not remain as a second key that the daemon would merge.

// Depth limit against stack-overflow DoS (CWE-674). V8's JSON.parse is iterative
// and accepts extremely deeply nested bodies, but the recursive helpers below
// then overflow the call stack → RangeError → unhandled rejection that crashes the
// shared gateway (a single malicious create/exec/volume body suffices).
// No legitimate Docker body nests anywhere near this bound, so
// deny deeper: findAmbiguousKey runs first in every validator/proxy path and
// fails closed (returns a pseudo-ambiguous key → deny), so deepLowerKeys
// never runs on too-deep input.
const MAX_KEY_DEPTH = 200;

// Walks the entire value recursively and returns the first key that, at one
// object level, collides case-insensitively with another (e.g. `HostConfig` next to
// `hostconfig`), or null if everything is unambiguous.
export function findAmbiguousKey(value: unknown, depth = 0): string | null {
  if (depth > MAX_KEY_DEPTH) return '__depth_exceeded__';
  if (Array.isArray(value)) {
    for (const el of value) { const r = findAmbiguousKey(el, depth + 1); if (r) return r; }
    return null;
  }
  if (value && typeof value === 'object') {
    const seen = new Set<string>();
    for (const k of Object.keys(value)) {
      const lk = k.toLowerCase();
      if (seen.has(lk)) return lk;
      seen.add(lk);
    }
    for (const v of Object.values(value)) { const r = findAmbiguousKey(v, depth + 1); if (r) return r; }
    return null;
  }
  return null;
}

// Deep copy with all object keys lowercased. Assumes there are no
// case-insensitive duplicate keys (findAmbiguousKey covers that), so that
// the lowercasing is lossless. Arrays/primitives keep their value intact.
// The depth guard is defensive: every call site runs findAmbiguousKey (with
// the same limit) first, so over-deep input is already denied here.
export function deepLowerKeys(value: any, depth = 0): any {
  if (depth > MAX_KEY_DEPTH) return value;
  if (Array.isArray(value)) return value.map(el => deepLowerKeys(el, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(value)) out[k.toLowerCase()] = deepLowerKeys(v, depth + 1);
    return out;
  }
  return value;
}

// Rename any case variant of `canonical` to exactly `canonical`
// (e.g. `hostconfig` → `HostConfig`). No-op if the key is already canonical or
// missing. Safe because findAmbiguousKey has already guaranteed that at most
// one case variant exists.
export function renameKeyCI(obj: Record<string, any>, canonical: string): void {
  if (!obj || typeof obj !== 'object') return;
  const target = canonical.toLowerCase();
  for (const k of Object.keys(obj)) {
    if (k !== canonical && k.toLowerCase() === target) {
      obj[canonical] = obj[k];
      delete obj[k];
      return;
    }
  }
}

// Lowercase variants of the canonical key sets; the sweep runs on the
// lowercased view (deepLowerKeys) and thus compares lowercase against lowercase.
const ALLOWED_HOSTCONFIG_KEYS_LC = new Set([...ALLOWED_HOSTCONFIG_KEYS].map(k => k.toLowerCase()));
const HARD_CHECKED_HOSTCONFIG_KEYS_LC = new Set([...HARD_CHECKED_HOSTCONFIG_KEYS].map(k => k.toLowerCase()));

// Does a HostConfig value carry a meaningful (non-default) setting?
function isMeaningfulValue(v: unknown): boolean {
  if (v === undefined || v === null || v === false || v === 0 || v === '') return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === 'object') return Object.keys(v as object).length > 0;
  return true;
}

// Classify one `Binds` entry (`source:target[:opts]`) by its source and gate it
// against `perms`. A `/`-prefixed source is a host bind, a named source is a
// named volume, and an entry with no source (`/container/path`, no colon) is
// anonymous. Returns a denial reason, or null when allowed.
function validateBind(bind: unknown, perms: MountPermissions): string | null {
  if (typeof bind !== 'string') return null;
  const parts = bind.split(':');
  const src = parts[0] ?? '';
  if (parts.length < 2 || src === '') return perms.anonymous ? null : mountDenied('anonymous volume');
  if (src.startsWith('/')) return perms.bind ? null : `host-path bind not permitted: ${bind}`;
  return perms.named ? null : mountDenied('named volume');
}

// Gate one structured `Mounts[]` entry against `perms`. tmpfs and any other type
// are in-memory / harmless and pass through. Returns a denial reason, or null.
// NB: `mount` comes from the lowercased view (deepLowerKeys), so all
// field names are lowercase here — that closes the `{"type":"bind"}` casing bypass.
function validateMount(mount: any, perms: MountPermissions): string | null {
  if (!mount) return null;
  if (mount.type === 'bind') return perms.bind ? null : 'bind-type mounts not permitted';
  if (mount.type !== 'volume') return null;
  // A `local` volume with inline driver config can bind-back an arbitrary host path
  // (type=none, o=bind, device=/…) — just as dangerous as a host
  // bind. Deny every volume mount that brings its own driver, regardless of the
  // mount toggles.
  if (mount.volumeoptions?.driverconfig) return 'volume DriverConfig not permitted';
  const source = typeof mount.source === 'string' ? mount.source : '';
  if (source === '') return perms.anonymous ? null : mountDenied('anonymous volume');
  return perms.named ? null : mountDenied('named volume');
}

// Reject HostConfig shapes that would let a spawned container escape the
// devcontainer sandbox (read host fs, see host PIDs/devices, talk to host
// dockerd). Returns a denial reason, or null if the config is acceptable.
export function validateHostConfig(rawHostConfig: any, perms: MountPermissions = DEFAULT_MOUNT_PERMS): string | null {
  if (!rawHostConfig || typeof rawHostConfig !== 'object') return null;

  // Parser-differential defense: deny case-insensitive duplicate keys and
  // then validate on a deeply-lowercased view, so the checks see exactly
  // what the daemon will honor — regardless of how the client capitalizes the keys.
  const amb = findAmbiguousKey(rawHostConfig);
  if (amb) return `ambiguous duplicate HostConfig key not permitted: ${amb}`;
  const hc = deepLowerKeys(rawHostConfig);

  // ── Hard-denies (always enforced, casing-agnostic) ───────────────────
  if (hc.privileged === true) return 'Privileged containers not permitted';
  if (hc.pidmode && hc.pidmode !== '') return 'PidMode not permitted';
  if (hc.ipcmode === 'host') return 'IpcMode=host not permitted';
  if (hc.usernsmode === 'host') return 'UsernsMode=host not permitted';
  if (hc.cgroupnsmode === 'host') return 'CgroupnsMode=host not permitted';
  if (hc.utsmode === 'host') return 'UTSMode=host not permitted';
  if (hc.cgroupparent) return 'CgroupParent override not permitted';

  if (Array.isArray(hc.capadd) && hc.capadd.length > 0)
    return 'CapAdd not permitted';
  if (Array.isArray(hc.devices) && hc.devices.length > 0)
    return 'Devices not permitted';

  // Finding #1: VolumesFrom lets the new container inherit the mounts (incl. huddle's
  // real docker.sock + CA key + DB) of another container → host takeover.
  if (Array.isArray(hc.volumesfrom) && hc.volumesfrom.length > 0)
    return 'VolumesFrom not permitted';

  // Finding #2 + device family: cgroup/whitelist and device-request fields
  // give access to host block/char devices (raw-disk via default CAP_MKNOD).
  if (Array.isArray(hc.devicecgrouprules) && hc.devicecgrouprules.length > 0)
    return 'DeviceCgroupRules not permitted';
  if (Array.isArray(hc.devicerequests) && hc.devicerequests.length > 0)
    return 'DeviceRequests not permitted';
  for (const k of ['blkiodevicereadbps', 'blkiodevicewritebps', 'blkiodevicereadiops', 'blkiodevicewriteiops'] as const) {
    if (Array.isArray(hc[k]) && hc[k].length > 0) return `${k} not permitted`;
  }

  // PoC `mask`: an empty (or trimmed-down) MaskedPaths/ReadonlyPaths weakens the
  // daemon's secure defaults and unmasks /proc/kcore and
  // /proc/sysrq-trigger among others. Therefore deny every explicitly supplied LIST (empty or
  // trimmed) — a devcontainer never has a legitimate reason to set these.
  // Note: on a normal create the docker CLI sends `MaskedPaths:
  // null` / `ReadonlyPaths: null` by default; `null` means "daemon fills in the secure
  // defaults" and is therefore actually safe. Only an array is an override, so
  // we gate on Array.isArray instead of "present" — otherwise every create would fail.
  if (Array.isArray(hc.maskedpaths)) return 'MaskedPaths override not permitted';
  if (Array.isArray(hc.readonlypaths)) return 'ReadonlyPaths override not permitted';

  const sys = hc.sysctls;
  if (sys && typeof sys === 'object' && Object.keys(sys).length > 0)
    return 'Sysctls not permitted';

  if (Array.isArray(hc.securityopt)) {
    for (const opt of hc.securityopt) {
      if (typeof opt !== 'string') continue;
      const norm = opt.toLowerCase().replace(/\s+/g, '');
      if (norm === 'apparmor=unconfined' ||
          norm === 'seccomp=unconfined' ||
          norm === 'label=disable' ||
          norm === 'systempaths=unconfined' ||
          norm === 'no-new-privileges=false')
        return `SecurityOpt ${opt} not permitted`;
    }
  }

  // Volume mounts, split by risk and gated per devcontainer (`perms`): a bind is
  // a host-path escape vector, named is an isolated huddle volume, anonymous is
  // a fresh source-less volume. Shape classification lives in the helpers below.
  if (Array.isArray(hc.binds)) {
    for (const bind of hc.binds) {
      const denial = validateBind(bind, perms);
      if (denial) return denial;
    }
  }

  if (Array.isArray(hc.mounts)) {
    for (const mount of hc.mounts) {
      const denial = validateMount(mount, perms);
      if (denial) return denial;
    }
  }

  // ── Generic allowlist sweep (log-only default, enforce via env) ──────────
  // Every key we do not recognize and that carries a meaningful value
  // is suspicious — this catches future/unknown fields without knowing them.
  // Iterate over the ORIGINAL keys so that the message preserves their casing; the
  // membership check runs case-insensitively (findAmbiguousKey guaranteed 1-to-1).
  const unknown: string[] = [];
  for (const key of Object.keys(rawHostConfig)) {
    const lk = key.toLowerCase();
    if (ALLOWED_HOSTCONFIG_KEYS_LC.has(lk) || HARD_CHECKED_HOSTCONFIG_KEYS_LC.has(lk)) continue;
    if (isMeaningfulValue(rawHostConfig[key])) unknown.push(key);
  }
  if (unknown.length > 0) {
    if (process.env.HUDDLE_HOSTCONFIG_ENFORCE === '1') {
      return `HostConfig field(s) not permitted: ${unknown.join(', ')}`;
    }
    console.warn(
      `[socket-proxy] HostConfig allowlist (log-only): would reject non-empty field(s): ${unknown.join(', ')}. ` +
      `Set HUDDLE_HOSTCONFIG_ENFORCE=1 to enforce once validated against real workflows.`
    );
  }

  if (hc.portbindings && typeof hc.portbindings === 'object') {
    for (const [containerPortProto, bindings] of Object.entries(hc.portbindings)) {
      if (!Array.isArray(bindings)) continue;
      const proto = containerPortProto.includes('/') ? containerPortProto.split('/')[1] : 'tcp';
      for (const binding of bindings) {
        const hostPort = parseInt(String((binding as any).hostport ?? '0'), 10);
        if (hostPort > 0) {
          // Return a special marker that includes the port info for the caller to check per-container
          return `__PORT_CHECK__:${hostPort}:${proto}`;
        }
      }
    }
  }

  return null;
}

// Validate an exec-create body (POST /containers/<id>/exec). Finding #7: the
// proxy never inspected this body, so `{"Privileged":true}` gave an exec with
// all capabilities + device-cgroup-allow-all → raw host disk. Same
// casing-agnostic approach as validateHostConfig.
export function validateExecConfig(rawBody: any): string | null {
  if (!rawBody || typeof rawBody !== 'object') return null;
  const amb = findAmbiguousKey(rawBody);
  if (amb) return `ambiguous duplicate exec key not permitted: ${amb}`;
  const b = deepLowerKeys(rawBody);
  if (b.privileged === true) return 'Privileged exec not permitted';
  return null;
}

// Reject volume-create bodies that map a named volume onto a host path via the
// `local` driver (type=none / o=bind / device=…). Such a volume can then be bound
// into a container under a non-`/` source name and thereby bypass the
// host-path check in validateHostConfig. Returns a denial reason, or null.
export function validateVolumeCreate(rawBody: any): string | null {
  if (!rawBody || typeof rawBody !== 'object') return null;
  // Same parser-differential defense as validateHostConfig: a lowercase
  // `driveropts` would otherwise evade the bind-backed-volume check.
  const amb = findAmbiguousKey(rawBody);
  if (amb) return `ambiguous duplicate volume key not permitted: ${amb}`;
  const body = deepLowerKeys(rawBody);
  const driver = typeof body.driver === 'string' ? body.driver.toLowerCase() : 'local';
  const opts = body.driveropts;
  if (driver !== 'local' || !opts || typeof opts !== 'object') return null;
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) norm[k.toLowerCase()] = String(v).toLowerCase();
  // `device` covers both bind (o=bind) and external-storage mounts (nfs/cifs);
  // a devcontainer needs neither and both can attach data outside the
  // sandbox.
  if (norm.device || (norm.o ?? '').includes('bind') || norm.type === 'none')
    return 'local bind-backed volumes not permitted';
  return null;
}

// Collect the named-volume sources from a HostConfig (Binds + Mounts). Host-
// path binds and bind-type mounts are already denied by validateHostConfig;
// anonymous volumes (no Source) are skipped. Used for the
// ownership check on container-create (finding #8).
function namedVolumeSources(hostConfig: any): string[] {
  const out: string[] = [];
  // Lower the view so that lowercase `binds`/`mounts`/`type`/`source` also count
  // (parser-differential — otherwise a lowercase mount would evade the ownership check).
  const hc = hostConfig && typeof hostConfig === 'object' ? deepLowerKeys(hostConfig) : {};
  if (Array.isArray(hc.binds)) {
    for (const bind of hc.binds) {
      if (typeof bind !== 'string') continue;
      const src = bind.split(':')[0] ?? '';
      if (src && !src.startsWith('/') && !src.startsWith('.')) out.push(src);
    }
  }
  if (Array.isArray(hc.mounts)) {
    for (const m of hc.mounts) {
      if (m && m.type === 'volume' && typeof m.source === 'string' && m.source) out.push(m.source);
    }
  }
  return out;
}

function deny403(client: net.Socket, msg: string): void {
  const body = JSON.stringify({ message: msg });
  client.write(`HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
  client.end();
}

// ── Per-container socket proxy ────────────────────────────────────────────────

// containerName flows into path.join() for the socket directory. The name comes from
// huddle's own orchestration (Docker container name), but we explicitly enforce the
// Docker naming grammar here: no slashes and no leading dot,
// so it is impossible to write or read outside socketDir with `..`/`/`.
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

function assertSafeContainerName(name: string): void {
  if (typeof name !== 'string' || !CONTAINER_NAME_RE.test(name))
    throw new Error(`unsafe container name: ${JSON.stringify(name)}`);
}

export async function createContainerProxy(containerName: string, socketDir: string): Promise<net.Server> {
  assertSafeContainerName(containerName);
  const existing = proxyServers.get(containerName);
  if (existing) { existing.close(); proxyServers.delete(containerName); }

  const { id, shortId } = await lookupContainerId(containerName);
  registerDevcontainer(containerName, id);

  // The socket lives in a per-container subdirectory that is mounted as a DIRECTORY
  // into the devcontainer. A bind-mount of the socket file itself pins
  // the inode: after a huddle restart (unlink + new listen) such a mount
  // points forever at the dead old socket. A directory mount survives that.
  const containerDir = path.join(socketDir, containerName);
  const socketPath = path.join(containerDir, 'docker.sock');
  // Old flat path (`<name>.sock`): remains as a symlink for
  // devcontainers from before the directory mount; those then work again after their
  // own restart (docker follows the symlink when setting up the bind).
  const legacySocketPath = path.join(socketDir, `${containerName}.sock`);
  try {
    fs.mkdirSync(containerDir, { recursive: true });
  } catch (err) {
    console.error(`[socket-proxy] failed to create directory ${containerDir}:`, err);
  }
  try { fs.unlinkSync(socketPath); } catch {}

  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      let upstream: net.Socket | null = null;
      let phase: 'headers' | 'body' | 'tunnel' = 'headers';
      let headerBuf = Buffer.alloc(0);

      // Body-accumulation state (for POST /containers/create and /networks/create)
      let bodyBuf = Buffer.alloc(0);
      let bodyContentLength = 0;
      let savedHeaderPart = '';
      let bodyHandler: (() => void) | null = null;

      client.on('error', () => upstream?.destroy());
      client.on('end', () => upstream?.end());

      function openUpstream(firstData: Buffer, opts?: { allowUpgrade?: boolean }): void {
        phase = 'tunnel';
        upstream = net.createConnection(DOCKER_SOCKET);
        upstream.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET')
            console.error(`[socket-proxy] upstream error for ${containerName}:`, err.message);
          client.destroy();
        });
        upstream.on('end', () => client.end());
        upstream.pipe(client);

        const sep = firstData.indexOf('\r\n\r\n');
        if (sep === -1) { upstream.write(firstData); return; }
        const headerStr = firstData.slice(0, sep).toString();
        const tail = firstData.slice(sep + 4);
        const lines = headerStr.split('\r\n');

        // Connection hijack (docker attach / attach ws): the client negotiates
        // an HTTP Upgrade, the daemon replies 101 and the socket becomes a
        // dedicated raw bidirectional stdio stream that is never reused for
        // another HTTP request. Forward the Upgrade/Connection headers verbatim
        // — forcing `Connection: close` (below) would break the hijack. Gated
        // on the caller opting in (only the attach handlers do) AND the request
        // genuinely being an upgrade, so a non-upgrade request still gets the
        // single-use `Connection: close` rewrite and cannot pipeline a second
        // request that would be tunnelled raw past the classifier.
        if (opts?.allowUpgrade &&
            lines.some(l => /^connection:\s*upgrade/i.test(l)) &&
            lines.some(l => /^upgrade:\s*/i.test(l))) {
          upstream.write(firstData);
          return;
        }

        // Force Connection: close so docker CLI cannot reuse this TCP socket
        // for a second request — every request must reopen and re-enter our
        // header parser (otherwise we'd tunnel subsequent requests raw and
        // bypass /containers/json filtering).
        const fixed = [
          lines[0],
          'Connection: close',
          ...lines.slice(1).filter(l => !/^connection:\s*/i.test(l)),
        ].join('\r\n');
        upstream.write(Buffer.concat([Buffer.from(fixed + '\r\n\r\n'), tail]));
      }

      function forwardWithRewrittenUrl(headerPart: string, newUrl: string, remainder: Buffer): void {
        const newHeader = rewriteFirstLine(headerPart, newUrl) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), remainder]));
      }

      async function processInjectedBody(): Promise<void> {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          // Unparseable body must not bypass HostConfig validation.
          deny403(client, 'invalid container create body');
          return;
        }
        // Parser-differential (PoC #1a/#1b/#1c): deny case-insensitive duplicate
        // keys anywhere in the body, and canonicalize the keys that the proxy
        // itself injects into. That way a lowercase `hostconfig`/`labels`/`env`
        // does not land as a second key — merged by the daemon — next to our injection,
        // and validateHostConfig is guaranteed to see the same HostConfig as the daemon.
        const amb = findAmbiguousKey(body);
        if (amb) { deny403(client, `ambiguous duplicate key not permitted: ${amb}`); return; }
        renameKeyCI(body, 'HostConfig');
        renameKeyCI(body, 'Labels');
        renameKeyCI(body, 'Env');
        renameKeyCI(body, 'NetworkingConfig');
        if (body.NetworkingConfig && typeof body.NetworkingConfig === 'object') {
          renameKeyCI(body.NetworkingConfig, 'EndpointsConfig');
        }
        const denial = validateHostConfig(body.HostConfig, getMountPermissions(containerName));
        if (denial) {
          if (denial.startsWith('__PORT_CHECK__:')) {
            const [, portStr, proto] = denial.split(':');
            const hostPort = parseInt(portStr, 10);
            if (!isHostPortApproved(containerName, hostPort, proto)) {
              deny403(client, `Host port ${hostPort}/${proto} is not approved for this devcontainer. Approve it in the Huddle portal first.`);
              return;
            }
          } else {
            deny403(client, denial);
            return;
          }
        }
        // Finding #8: named-volume ownership. A devcontainer may only mount its
        // own (huddle.parent) or unlabeled/operator volumes — never
        // a volume that belongs to ANOTHER devcontainer (cross-container
        // theft of source/credential volumes). Same semantics as the
        // delete/prune paths. Unlabeled (pre-existing) volumes remain
        // allowed; a not-yet-existing named volume (404) counts as unlabeled.
        for (const src of namedVolumeSources(body.HostConfig)) {
          const { parent } = await lookupParentLabel('volume', src);
          if (parent && parent !== containerName) {
            deny403(client, `cannot mount volume owned by another devcontainer: ${src}`);
            return;
          }
        }
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        // Force spawned containers onto the parent devcontainer's network only.
        // Canonicalize NetworkMode within HostConfig so that a lowercase
        // `networkmode` from the client does not remain as a second key next to our forcing
        // (which the daemon could merge back into the original network).
        const netName = `dc-net-${containerName}`;
        const hcOut = { ...(body.HostConfig ?? {}) };
        renameKeyCI(hcOut, 'NetworkMode');
        hcOut.NetworkMode = netName;
        body.HostConfig = hcOut;
        // Compose also puts a NetworkingConfig.EndpointsConfig in the create body
        // that points to its own network (e.g. `socialekaart_default`). If we
        // only convert NetworkMode, that EndpointsConfig wins and the
        // container still lands on the compose network — unreachable for the devcontainer and
        // without egress via the huddle proxy. Therefore collapse all endpoints into
        // one entry on dc-net-<name>, preserving the Aliases (service names)
        // so that DNS between compose services keeps working.
        const endpoints = body.NetworkingConfig?.EndpointsConfig;
        if (endpoints && typeof endpoints === 'object') {
          const aliases = new Set<string>();
          for (const ep of Object.values(endpoints)) {
            const a = (ep as any)?.Aliases;
            if (Array.isArray(a)) for (const x of a) if (typeof x === 'string') aliases.add(x);
          }
          body.NetworkingConfig = {
            EndpointsConfig: { [netName]: aliases.size ? { Aliases: [...aliases] } : {} },
          };
        }
        // Inject Huddle proxy env vars so child containers can reach the internet
        // through the proxy without requiring manual configuration.
        const proxyEnv = [
          'http_proxy=http://huddle:80',
          'https_proxy=http://huddle:80',
          'HTTP_PROXY=http://huddle:80',
          'HTTPS_PROXY=http://huddle:80',
          // Loopback never via the proxy; `[::1]` bracketed for .NET/Aspire
          // (see the explanation for the same lines in docker.ts).
          'no_proxy=localhost,127.0.0.1,::1,[::1]',
          'NO_PROXY=localhost,127.0.0.1,::1,[::1]',
          'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt',
          'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
          'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt',
        ];
        const existingEnv: string[] = body.Env ?? [];
        const existingKeys = new Set(existingEnv.map((e: string) => e.split('=')[0]));
        body.Env = [...existingEnv, ...proxyEnv.filter(e => !existingKeys.has(e.split('=')[0]))];
        const newBodyBuf = Buffer.from(JSON.stringify(body));
        const newHeader = savedHeaderPart.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${newBodyBuf.length}`
        ) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
      }

      function processNetworkCreate(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          deny403(client, 'invalid network create body');
          return;
        }
        // Canonicalize the keys we inject into so that a lowercase
        // `labels`/`options` does not remain as a second, merged key (a
        // spoofed `labels.huddle.parent` could otherwise forge ownership).
        const netAmb = findAmbiguousKey(body);
        if (netAmb) { deny403(client, `ambiguous duplicate key not permitted: ${netAmb}`); return; }
        renameKeyCI(body, 'Options');
        renameKeyCI(body, 'Labels');
        body.Options = { ...(body.Options ?? {}), 'com.docker.network.driver.mtu': '1400' };
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        const newBodyBuf = Buffer.from(JSON.stringify(body));
        const newHeader = savedHeaderPart.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${newBodyBuf.length}`
        ) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
      }

      function processVolumeCreate(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          deny403(client, 'invalid volume create body');
          return;
        }
        const denial = validateVolumeCreate(body);
        if (denial) { deny403(client, denial); return; }
        // Canonicalize `labels` so that the ownership injection does not land next to a
        // spoofed lowercase variant.
        renameKeyCI(body, 'Labels');
        // Label injection makes volumes traceable to their devcontainer, so that
        // remove/prune can enforce ownership.
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        const newBodyBuf = Buffer.from(JSON.stringify(body));
        const newHeader = savedHeaderPart.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${newBodyBuf.length}`
        ) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
      }

      // Finding #7: exec-create body was never inspected, so a
      // `{"Privileged":true}` exec got all capabilities → raw host disk.
      // Buffer the body and deny a privileged exec; forward otherwise unchanged.
      function processExecCreate(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          // Fail-closed: an unparseable exec body must not skip the Privileged
          // check.
          deny403(client, 'invalid exec create body');
          return;
        }
        const denial = validateExecConfig(body);
        if (denial) { deny403(client, denial); return; }
        openUpstream(Buffer.concat([Buffer.from(savedHeaderPart + '\r\n\r\n'), bodyBytes, rest]));
      }

      client.on('data', (chunk: Buffer) => {
        if (phase === 'tunnel') { upstream?.write(chunk); return; }

        if (phase === 'body') {
          bodyBuf = Buffer.concat([bodyBuf, chunk]);
          if (bodyBuf.length >= bodyContentLength) bodyHandler?.();
          return;
        }

        // ── Header accumulation ──────────────────────────────────────────────
        headerBuf = Buffer.concat([headerBuf, chunk]);
        const end = headerBuf.indexOf('\r\n\r\n');
        if (end === -1) return;

        const headerPart = headerBuf.slice(0, end).toString();
        const remainder = headerBuf.slice(end + 4);
        headerBuf = Buffer.alloc(0);

        const firstLine = headerPart.split('\r\n')[0] ?? '';
        const parts = firstLine.split(' ');
        const method = (parts[0] ?? '').toUpperCase();
        const rawUrl = parts[1] ?? '';
        const p = rawUrl.replace(/^\/v[\d.]+/, '').split('?')[0];

        const action = classifyRequest(method, p);
        if (!action) {
          console.warn(`[socket-proxy] path not allowed: ${method} ${rawUrl} (container: ${containerName})`);
          deny403(client, 'path not allowed');
          return;
        }
        const policyDenial = authorizeAction(containerName, action);
        if (policyDenial) {
          deny403(client, policyDenial);
          return;
        }

        // ── DELETE ───────────────────────────────────────────────────────────
        if (method === 'DELETE') {
          const ctId = p.match(/^\/containers\/([^/]+)$/)?.[1];
          // Image names can contain slashes (registry/repo:tag).
          const imgId = p.match(/^\/images\/(.+)$/)?.[1];
          const targetId = ctId ?? imgId;
          const type = ctId ? 'container' : 'image';

          // Network delete — only own (huddle.parent-labeled) networks.
          // Unlabeled networks from before this change remain deletable,
          // except the huddle-managed dc-net-* networks.
          const netId = p.match(/^\/networks\/([^/]+)$/)?.[1];
          if (netId) {
            client.pause();
            lookupParentLabel('network', netId).then(({ parent, name }) => {
              if (parent === containerName) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else if (parent) {
                deny403(client, 'cannot delete network owned by another devcontainer');
              } else if (name.startsWith('dc-net-') || netId.startsWith('dc-net-')) {
                deny403(client, 'cannot delete huddle-managed network');
              } else {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              }
              client.resume();
            });
            return;
          }

          // Volume delete — needed for docker compose down -v. Only own or
          // unlabeled (pre-existing) volumes; volumes of another
          // devcontainer are untouchable.
          const volId = p.match(/^\/volumes\/([^/]+)$/)?.[1];
          if (volId) {
            client.pause();
            lookupParentLabel('volume', volId).then(({ parent }) => {
              if (parent && parent !== containerName) {
                deny403(client, 'cannot delete volume owned by another devcontainer');
              } else {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              }
              client.resume();
            });
            return;
          }

          if (!targetId) { deny403(client, 'delete not permitted'); return; }

          client.pause();
          hasOwnLabel(type, targetId, containerName).then(ok => {
            if (ok) {
              openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            } else {
              deny403(client, `cannot delete ${type} not created by this container`);
            }
            client.resume();
          });
          return;
        }

        // ── GET / HEAD ───────────────────────────────────────────────────────
        if (method === 'GET' || method === 'HEAD') {
          if (p === '/version' || p === '/info' || p === '/_ping' ||
              /^\/exec\/[^/]+\/json$/.test(p) ||
              /^\/images\/.+\/json$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }
          if (p === '/images/json') {
            // Show all images — agent needs to know available base images
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }
          if (p === '/containers/json') {
            // Filter to own containers only
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }
          // Network listing — filter to own networks; inspect — allow for networking
          if (p === '/networks' || p === '/networks/json') {
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }
          if (/^\/networks\/[^/]+$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Volume listing — filter to own volumes so that peer volume names
          // are not enumerable (finding #8), consistent with the container
          // and network listings above.
          if (p === '/volumes') {
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }
          // Volume inspect — needed for docker compose named volumes.
          if (/^\/volumes\/[^/]+$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Events stream — needed for docker compose up log following
          if (p === '/events') {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // WebSocket attach — same hijack semantics as the POST attach above.
          // Only on own spawned containers, never a devcontainer itself.
          const attachWsCt = p.match(/^\/containers\/([^/]+)\/attach\/ws$/)?.[1];
          if (attachWsCt) {
            if (devcontainerIds.has(attachWsCt)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', attachWsCt, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]), { allowUpgrade: true });
              } else {
                deny403(client, 'container was not created by this devcontainer');
              }
              client.resume();
            });
            return;
          }

          // Inspect / logs / top / archive (docker cp stat+download) — only on
          // containers labeled by this devcontainer
          const inspectCt = p.match(/^\/containers\/([^/]+)\/(json|logs|top|archive|stats)$/)?.[1];
          if (inspectCt) {
            if (devcontainerIds.has(inspectCt)) {
              deny403(client, 'inspect of devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', inspectCt, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'container not owned by this devcontainer');
              }
              client.resume();
            });
            return;
          }
          console.warn(`[socket-proxy] path not allowed: ${method} ${rawUrl} (container: ${containerName})`);
          deny403(client, 'path not allowed');
          return;
        }

        // ── POST ─────────────────────────────────────────────────────────────
        if (method === 'POST') {
          // Exec session control (exec IDs are opaque)
          if (/^\/exec\/[^/]+\/(start|resize)$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Spawn container — inject huddle.parent label
          if (p === '/containers/create') {
            const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
            bodyContentLength = clMatch ? parseInt(clMatch[1]) : 0;
            savedHeaderPart = headerPart;
            bodyHandler = processInjectedBody;
            phase = 'body';
            bodyBuf = remainder;
            if (bodyBuf.length >= bodyContentLength) bodyHandler();
            return;
          }

          // Docker build — add huddle.parent label via query param
          if (p === '/build') {
            const labelParam = encodeURIComponent(JSON.stringify({ 'huddle.parent': containerName }));
            const newUrl = rawUrl.includes('?') ? `${rawUrl}&labels=${labelParam}` : `${rawUrl}?labels=${labelParam}`;
            forwardWithRewrittenUrl(headerPart, newUrl, remainder);
            return;
          }

          // Pull image — allow (no labeling possible, agent may need base images)
          if (p === '/images/create') {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Image tag — local metadata operation, allowed on any image.
          if (/^\/images\/.+\/tag$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Image push — only own (huddle.parent-labeled, thus self-
          // built) images. Push goes through the host's docker daemon and
          // therefore does not pass the huddle egress firewall; the action is
          // moreover disabled by default in the portal.
          const pushImg = p.match(/^\/images\/(.+)\/push$/)?.[1];
          if (pushImg) {
            client.pause();
            hasOwnLabel('image', pushImg, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'cannot push image not built by this devcontainer');
              }
              client.resume();
            });
            return;
          }

          // Exec-create — buffer + validate the body (finding #7: Privileged exec).
          // Only on own spawned containers, never on a devcontainer itself.
          const execCt = p.match(/^\/containers\/([^/]+)\/exec$/)?.[1];
          if (execCt) {
            if (devcontainerIds.has(execCt)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
            const bodyLen = clMatch ? parseInt(clMatch[1]) : 0;
            client.pause();
            hasOwnLabel('container', execCt, containerName).then(ok => {
              if (!ok) {
                deny403(client, 'container was not created by this devcontainer');
                client.resume();
                return;
              }
              // Ownership ok → switch to body buffering; processExecCreate
              // validates the exec config once the full body is in.
              bodyContentLength = bodyLen;
              savedHeaderPart = headerPart;
              bodyHandler = processExecCreate;
              phase = 'body';
              bodyBuf = remainder;
              if (bodyBuf.length >= bodyContentLength) bodyHandler();
              client.resume();
            });
            return;
          }

          // Attach — foreground `docker run` and `docker attach` hijack the
          // connection into a raw bidirectional stdio stream. Only on own
          // spawned containers, never a devcontainer itself. Tunnel raw (via
          // allowUpgrade) so the daemon's 101/TCP upgrade survives.
          const attachCt = p.match(/^\/containers\/([^/]+)\/attach$/)?.[1];
          if (attachCt) {
            if (devcontainerIds.has(attachCt)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', attachCt, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]), { allowUpgrade: true });
              } else {
                deny403(client, 'container was not created by this devcontainer');
              }
              client.resume();
            });
            return;
          }

          // Container management: only for own spawned containers, never devcontainers
          const ctId = p.match(/^\/containers\/([^/]+)\/(start|stop|restart|kill|wait|update)$/)?.[1];
          if (ctId) {
            if (devcontainerIds.has(ctId)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', ctId, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'container was not created by this devcontainer');
              }
              client.resume();
            });
            return;
          }

          // Volume create — needed for docker compose named volumes. Body is
          // buffered and validated: local bind-backed volumes (host-path
          // escape) are denied.
          if (p === '/volumes/create') {
            const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
            bodyContentLength = clMatch ? parseInt(clMatch[1]) : 0;
            savedHeaderPart = headerPart;
            bodyHandler = processVolumeCreate;
            phase = 'body';
            bodyBuf = remainder;
            if (bodyBuf.length >= bodyContentLength) bodyHandler();
            return;
          }

          // Volume prune — restricted to own volumes by injecting a mandatory
          // label filter; volumes of other containers (or from
          // before the label injection) stay out of range.
          if (p === '/volumes/prune') {
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }

          // Network management — create, connect, disconnect
          if (p === '/networks/create') {
            const clMatch = headerPart.match(/content-length:\s*(\d+)/i);
            bodyContentLength = clMatch ? parseInt(clMatch[1]) : 0;
            savedHeaderPart = headerPart;
            bodyHandler = processNetworkCreate;
            phase = 'body';
            bodyBuf = remainder;
            if (bodyBuf.length >= bodyContentLength) bodyHandler();
            return;
          }
          if (/^\/networks\/[^/]+\/(connect|disconnect)$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          deny403(client, 'operation not permitted');
          return;
        }

        // ── PUT ──────────────────────────────────────────────────────────────
        if (method === 'PUT') {
          // Archive upload (docker cp to a container) — Aspire's DCP among others
          // copies dev-certs into every started container (CopyFile, issue #12).
          // Only allowed on own spawned containers, never devcontainers.
          const archiveCt = p.match(/^\/containers\/([^/]+)\/archive$/)?.[1];
          if (archiveCt) {
            if (devcontainerIds.has(archiveCt)) {
              deny403(client, 'operation on devcontainer not permitted');
              return;
            }
            client.pause();
            hasOwnLabel('container', archiveCt, containerName).then(ok => {
              if (ok) {
                openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
              } else {
                deny403(client, 'container was not created by this devcontainer');
              }
              client.resume();
            });
            return;
          }
          deny403(client, 'operation not permitted');
          return;
        }

        deny403(client, 'method not allowed');
      });
    });

    server.on('error', reject);
    server.listen(socketPath, () => {
      try { fs.chmodSync(socketPath, 0o777); } catch {}
      try { fs.unlinkSync(legacySocketPath); } catch {}
      try { fs.symlinkSync(socketPath, legacySocketPath); } catch {}
      console.log(`[socket-proxy] ${containerName} (${shortId || 'id-unknown'}) → ${socketPath}`);
      proxyServers.set(containerName, server);
      resolve(server);
    });
  });
}
