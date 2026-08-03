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

// Ownership-lookup voor netwerken en volumes: geeft het huddle.parent-label en
// de echte naam terug (het pad kan ook een ID bevatten).
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
// De Docker-client (CLI/compose, API 1.55) verstuurt `filters` nog steeds in het
// legacy map-formaat: `{"label":{"foo=bar":true},"status":{"running":true}}`. De
// daemon accepteert dat, maar ook het array-formaat (`{"label":["foo=bar"]}`).
// Wat de daemon NIET accepteert is een gemengde vorm — en die kregen we als we
// alleen `label` naar een array omzetten en de andere sleutels (bv. `status`) als
// map lieten staan: dat levert "Error response from daemon: invalid filter" op en
// breekt o.a. `docker compose up`. Normaliseer daarom ELKE sleutel naar het
// array-formaat voordat we de labelfilter toevoegen.
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
// De vroegere alles-of-niets grant-check is vervangen door fijnmazige
// per-actie-autorisatie: classifyRequest bepaalt de actie, authorizeAction
// (docker-actions.ts) combineert de toggle-stand met de grant-timer.

// ── HostConfig-policy: allowlist i.p.v. denylist ────────────────────────────
// Root-cause van findings #1 (VolumesFrom) en #2 (DeviceCgroupRules): de oude
// validatie was een DENYLIST over een spec die Huddle niet bezit — elk veld dat
// Docker toevoegt (of dat we vergaten) glipte er ongezien doorheen. De nieuwe
// aanpak:
//   1. Value-specifieke HARD-DENIES voor de bevestigde escape-vectoren en de
//      klassiekers — altijd afgedwongen, ongeacht de mode. Dit sluit #1/#2/etc.
//   2. Een generieke ALLOWLIST-sweep over de overige sleutels: een sleutel die
//      we niet kennen én die een niet-lege waarde draagt is verdacht. Dit vangt
//      elk TOEKOMSTIG veld zonder dat we het hoeven te kennen.
//
// De Docker-CLI/compose stuurt vrijwel de hele HostConfig-struct mee, meestal
// met nul-/lege waarden. Daarom flag't de sweep alleen NIET-lege waarden op
// onbekende sleutels. Omdat de exacte set "genuinely-needed" velden alleen
// empirisch (tegen echte dev-flows) vast te stellen is, draait de sweep default
// in LOG-ONLY modus (waarschuwt, weigert niet). Zet HUDDLE_HOSTCONFIG_ENFORCE=1
// om te handhaven zodra de allowlist tegen echt verkeer gevalideerd is. De
// hard-denies staan hier los van en zijn altijd actief.

// Sleutels die een gespawnde sandbox-container legitiem met een betekenisvolle
// waarde mag zetten (resource-limieten, lifecycle, logging, poorten, named
// volumes). Bewust géén host-/device-/privilege-velden.
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

// Sleutels met een eigen value-specifieke hard-deny hieronder. Ze zijn "bekend"
// voor de sweep (hun gevaarlijke waarde is al eerder geweigerd; een onschuldige
// waarde — bv. Privileged:false, IpcMode:'private' — mag door).
const HARD_CHECKED_HOSTCONFIG_KEYS = new Set<string>([
  'Privileged', 'PidMode', 'IpcMode', 'UsernsMode', 'CgroupnsMode', 'UTSMode',
  'CgroupParent', 'CapAdd', 'Devices', 'Sysctls', 'SecurityOpt',
  'VolumesFrom', 'DeviceCgroupRules', 'DeviceRequests',
  'BlkioDeviceReadBps', 'BlkioDeviceWriteBps', 'BlkioDeviceReadIOps', 'BlkioDeviceWriteIOps',
  // Overrides waarmee een container de secure defaults van de daemon zou
  // verzwakken (PoC `mask`: /proc/kcore + /proc/sysrq-trigger unmasken). Elke
  // aanwezige waarde — óók een lege array — wordt hard geweigerd.
  'MaskedPaths', 'ReadonlyPaths',
]);

// ── Parser-differential-hardening (PoC findings #1a/#1b/#1c + exec #7) ────────
// De Docker-daemon (Go encoding/json) matcht struct-velden HOOFDLETTER-ONGEVOELIG
// en merget dubbele sleutels; deze proxy las sleutels hoofdlettergevoelig. Zo
// omzeilde `{"hostconfig":{…}}` (top-level lowercase), `{"HostConfig":{"privileged":
// true}}` (lowercase inner) of een lowercase `type` in Mounts élke check, terwijl
// de daemon ze wél honoreerde. Verweer in drie lagen:
//   1. findAmbiguousKey — weiger ELKE case-insensitieve dubbele sleutel, overal in
//      de body. Fail-closed, en het maakt de lowercase-view hieronder eenduidig.
//   2. deepLowerKeys — valideer op een diep-gelowercasede kopie zodat de checks
//      precies zien wat de daemon zal honoreren, ongeacht de casing.
//   3. renameKeyCI — canonicaliseer de sleutels waar de proxy zélf in injecteert
//      (HostConfig/Labels/Env/NetworkingConfig/NetworkMode) zodat een lowercase
//      variant niet als tweede, door de daemon gemergde, sleutel blijft staan.

// Diepte-limiet tegen stack-overflow-DoS (CWE-674). V8's JSON.parse is iteratief
// en accepteert extreem diep geneste bodies, maar de recursieve helpers hieronder
// lopen dan de call-stack over → RangeError → unhandled rejection die de gedeelde
// gateway laat crashen (een enkele kwaadaardige create/exec/volume-body volstaat).
// Geen enkele legitieme Docker-body nest ook maar in de buurt van deze grens, dus
// weiger dieper: findAmbiguousKey draait als éérste in elke validator/proxy-pad en
// faalt gesloten (retourneert een pseudo-ambigue sleutel → deny), zodat deepLowerKeys
// nooit op te diepe input draait.
const MAX_KEY_DEPTH = 200;

// Loopt de hele waarde recursief af en geeft de eerste sleutel terug die op één
// object-niveau case-insensitief botst met een andere (bv. `HostConfig` naast
// `hostconfig`), of null als alles eenduidig is.
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

// Diepe kopie met alle object-sleutels lowercase. Veronderstelt dat er géén
// case-insensitieve dubbele sleutels zijn (findAmbiguousKey dekt dat af), zodat
// het lowercasen verliesvrij is. Arrays/primitives blijven qua waarde intact.
// De diepte-guard is defensief: elke call-site draait findAmbiguousKey (met
// dezelfde limiet) eerst, dus over-diepe input is hier al geweigerd.
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

// Hernoem een eventuele case-variant van `canonical` naar exact `canonical`
// (bv. `hostconfig` → `HostConfig`). No-op als de sleutel al canoniek is of
// ontbreekt. Veilig omdat findAmbiguousKey al gegarandeerd heeft dat er hooguit
// één case-variant bestaat.
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

// Lowercase-varianten van de canonieke sleutelsets; de sweep draait op de
// gelowercasede view (deepLowerKeys) en vergelijkt dus lowercase-tegen-lowercase.
const ALLOWED_HOSTCONFIG_KEYS_LC = new Set([...ALLOWED_HOSTCONFIG_KEYS].map(k => k.toLowerCase()));
const HARD_CHECKED_HOSTCONFIG_KEYS_LC = new Set([...HARD_CHECKED_HOSTCONFIG_KEYS].map(k => k.toLowerCase()));

// Draagt een HostConfig-waarde een betekenisvolle (niet-default) instelling?
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
// NB: `mount` komt uit de gelowercasede view (deepLowerKeys), dus alle
// veldnamen zijn hier lowercase — dat sluit de `{"type":"bind"}`-casing-bypass.
function validateMount(mount: any, perms: MountPermissions): string | null {
  if (!mount) return null;
  if (mount.type === 'bind') return perms.bind ? null : 'bind-type mounts not permitted';
  if (mount.type !== 'volume') return null;
  // Een `local`-volume met inline driver-config kan een willekeurig hostpad
  // bind-backen (type=none, o=bind, device=/…) — net zo gevaarlijk als een host
  // bind. Weiger elke volume-mount die zelf een driver meebrengt, ongeacht de
  // mount-toggles.
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

  // Parser-differential-verweer: weiger case-insensitieve dubbele sleutels en
  // valideer daarna op een diep-gelowercasede view, zodat de checks precies zien
  // wat de daemon zal honoreren — ongeacht hoe de client de sleutels kapitaliseert.
  const amb = findAmbiguousKey(rawHostConfig);
  if (amb) return `ambiguous duplicate HostConfig key not permitted: ${amb}`;
  const hc = deepLowerKeys(rawHostConfig);

  // ── Hard-denies (altijd afgedwongen, casing-agnostisch) ───────────────────
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

  // Finding #1: VolumesFrom laat de nieuwe container de mounts (incl. huddle's
  // echte docker.sock + CA-key + DB) van een andere container erven → host-takeover.
  if (Array.isArray(hc.volumesfrom) && hc.volumesfrom.length > 0)
    return 'VolumesFrom not permitted';

  // Finding #2 + device-familie: cgroup/whitelist- en device-request-velden
  // geven toegang tot host block-/char-devices (raw-disk via default CAP_MKNOD).
  if (Array.isArray(hc.devicecgrouprules) && hc.devicecgrouprules.length > 0)
    return 'DeviceCgroupRules not permitted';
  if (Array.isArray(hc.devicerequests) && hc.devicerequests.length > 0)
    return 'DeviceRequests not permitted';
  for (const k of ['blkiodevicereadbps', 'blkiodevicewritebps', 'blkiodevicereadiops', 'blkiodevicewriteiops'] as const) {
    if (Array.isArray(hc[k]) && hc[k].length > 0) return `${k} not permitted`;
  }

  // PoC `mask`: een lege (of afgeslankte) MaskedPaths/ReadonlyPaths verzwakt de
  // secure defaults van de daemon en unmaskt o.a. /proc/kcore en
  // /proc/sysrq-trigger. Weiger daarom élke expliciet meegestuurde LIJST (leeg of
  // afgeslankt) — een devcontainer heeft nooit een legitieme reden deze te zetten.
  // Let op: de docker-CLI stuurt bij een gewone create standaard `MaskedPaths:
  // null` / `ReadonlyPaths: null` mee; `null` betekent "daemon vult de secure
  // defaults in" en is dus juist veilig. Alleen een array is een override, dus
  // gaten we op Array.isArray i.p.v. "aanwezig" — anders sneuvelt élke create.
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

  // ── Generieke allowlist-sweep (log-only default, enforce via env) ──────────
  // Elke sleutel die we niet herkennen én die een betekenisvolle waarde draagt
  // is verdacht — dit vangt toekomstige/onbekende velden zonder ze te kennen.
  // Itereer over de ORIGINELE sleutels zodat de melding hun casing behoudt; de
  // membership-check draait case-insensitief (findAmbiguousKey borgde 1-op-1).
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

// Valideer een exec-create body (POST /containers/<id>/exec). Finding #7: de
// proxy inspecteerde deze body nooit, dus `{"Privileged":true}` gaf een exec met
// alle capabilities + device-cgroup-allow-all → rauwe host-disk. Zelfde
// casing-agnostische aanpak als validateHostConfig.
export function validateExecConfig(rawBody: any): string | null {
  if (!rawBody || typeof rawBody !== 'object') return null;
  const amb = findAmbiguousKey(rawBody);
  if (amb) return `ambiguous duplicate exec key not permitted: ${amb}`;
  const b = deepLowerKeys(rawBody);
  if (b.privileged === true) return 'Privileged exec not permitted';
  return null;
}

// Reject volume-create bodies that map a named volume onto a host path via the
// `local` driver (type=none / o=bind / device=…). Zo'n volume kan daarna onder
// een niet-`/` bron-naam in een container gebonden worden en omzeilt daarmee de
// host-path-check in validateHostConfig. Returns een denial reason, of null.
export function validateVolumeCreate(rawBody: any): string | null {
  if (!rawBody || typeof rawBody !== 'object') return null;
  // Zelfde parser-differential-verweer als validateHostConfig: een lowercase
  // `driveropts` zou anders de bind-backed-volume-check ontwijken.
  const amb = findAmbiguousKey(rawBody);
  if (amb) return `ambiguous duplicate volume key not permitted: ${amb}`;
  const body = deepLowerKeys(rawBody);
  const driver = typeof body.driver === 'string' ? body.driver.toLowerCase() : 'local';
  const opts = body.driveropts;
  if (driver !== 'local' || !opts || typeof opts !== 'object') return null;
  const norm: Record<string, string> = {};
  for (const [k, v] of Object.entries(opts)) norm[k.toLowerCase()] = String(v).toLowerCase();
  // `device` dekt zowel bind- (o=bind) als externe-storage-mounts (nfs/cifs);
  // een devcontainer heeft geen van beide nodig en beide kunnen data buiten de
  // sandbox koppelen.
  if (norm.device || (norm.o ?? '').includes('bind') || norm.type === 'none')
    return 'local bind-backed volumes not permitted';
  return null;
}

// Verzamel de named-volume bronnen uit een HostConfig (Binds + Mounts). Host-
// path binds en bind-type mounts zijn al door validateHostConfig geweigerd;
// anonieme volumes (geen Source) worden overgeslagen. Wordt gebruikt voor de
// ownership-check bij container-create (finding #8).
function namedVolumeSources(hostConfig: any): string[] {
  const out: string[] = [];
  // Lower de view zodat lowercase `binds`/`mounts`/`type`/`source` óók meetellen
  // (parser-differential — anders zou een lowercase-mount de ownership-check ontwijken).
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

// containerName vloeit in path.join() voor de socket-directory. De naam komt uit
// huddle's eigen orchestratie (Docker-containernaam), maar we dwingen de
// Docker-naamgrammatica hier expliciet af: geen slashes en geen leidende punt,
// dus onmogelijk om met `..`/`/` buiten socketDir te schrijven of te lezen.
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

  // De socket leeft in een per-container subdirectory die als DIRECTORY in de
  // devcontainer gemount wordt. Een bind-mount van het socket-bestand zelf pint
  // de inode: na een huddle-herstart (unlink + nieuwe listen) kijkt zo'n mount
  // voorgoed naar de dode oude socket. Een directory-mount overleeft dat.
  const containerDir = path.join(socketDir, containerName);
  const socketPath = path.join(containerDir, 'docker.sock');
  // Oude platte pad (`<naam>.sock`): blijft als symlink bestaan voor
  // devcontainers van vóór de directory-mount; die werken dan weer na een
  // eigen herstart (docker volgt de symlink bij het opzetten van de bind).
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

      function openUpstream(firstData: Buffer): void {
        phase = 'tunnel';
        upstream = net.createConnection(DOCKER_SOCKET);
        upstream.on('error', (err) => {
          if ((err as NodeJS.ErrnoException).code !== 'ECONNRESET')
            console.error(`[socket-proxy] upstream error for ${containerName}:`, err.message);
          client.destroy();
        });
        upstream.on('end', () => client.end());
        upstream.pipe(client);

        // Force Connection: close so docker CLI cannot reuse this TCP socket
        // for a second request — every request must reopen and re-enter our
        // header parser (otherwise we'd tunnel subsequent requests raw and
        // bypass /containers/json filtering).
        const sep = firstData.indexOf('\r\n\r\n');
        if (sep === -1) { upstream.write(firstData); return; }
        const headerStr = firstData.slice(0, sep).toString();
        const tail = firstData.slice(sep + 4);
        const lines = headerStr.split('\r\n');
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
        // Parser-differential (PoC #1a/#1b/#1c): weiger case-insensitieve dubbele
        // sleutels ergens in de body, en canonicaliseer de sleutels waar de proxy
        // zelf in injecteert. Zo landt een lowercase `hostconfig`/`labels`/`env`
        // niet als tweede, door de daemon gemergde, sleutel naast onze injectie —
        // en ziet validateHostConfig gegarandeerd dezelfde HostConfig als de daemon.
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
        // Finding #8: named-volume ownership. Een devcontainer mag alleen zijn
        // eigen (huddle.parent) of ongelabelde/operator-volumes mounten — nooit
        // een volume dat aan een ANDERE devcontainer toebehoort (cross-container
        // diefstal van source-/credential-volumes). Zelfde semantiek als de
        // delete/prune-paden. Ongelabelde (pre-bestaande) volumes blijven toe-
        // gestaan; een nog niet bestaand named volume (404) telt als ongelabeld.
        for (const src of namedVolumeSources(body.HostConfig)) {
          const { parent } = await lookupParentLabel('volume', src);
          if (parent && parent !== containerName) {
            deny403(client, `cannot mount volume owned by another devcontainer: ${src}`);
            return;
          }
        }
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        // Force spawned containers onto the parent devcontainer's network only.
        // Canonicaliseer NetworkMode binnen HostConfig zodat een lowercase
        // `networkmode` van de client niet als tweede sleutel naast onze forcering
        // blijft staan (die de daemon zou kunnen mergen tot het originele net).
        const netName = `dc-net-${containerName}`;
        const hcOut = { ...(body.HostConfig ?? {}) };
        renameKeyCI(hcOut, 'NetworkMode');
        hcOut.NetworkMode = netName;
        body.HostConfig = hcOut;
        // Compose zet in de create-body óók een NetworkingConfig.EndpointsConfig
        // die naar zijn eigen netwerk (bv. `socialekaart_default`) wijst. Als we
        // alleen NetworkMode omzetten wint die EndpointsConfig en landt de
        // container tóch op het compose-net — onbereikbaar voor de devcontainer en
        // zonder egress via de huddle-proxy. Klap daarom álle endpoints samen tot
        // één entry op dc-net-<naam>, met behoud van de Aliases (service-namen)
        // zodat DNS tussen compose-services blijft werken.
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
          // Loopback nooit via de proxy; `[::1]` bracketed voor .NET/Aspire
          // (zie de toelichting bij dezelfde regels in docker.ts).
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
        // Canonicaliseer de sleutels waar we in injecteren zodat een lowercase
        // `labels`/`options` niet als tweede, gemergde, sleutel blijft staan (een
        // gespooft `labels.huddle.parent` zou anders ownership kunnen vervalsen).
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
        // Canonicaliseer `labels` zodat de ownership-injectie niet naast een
        // gespoofte lowercase-variant belandt.
        renameKeyCI(body, 'Labels');
        // Label-injectie maakt volumes herleidbaar naar hun devcontainer, zodat
        // remove/prune ownership kunnen afdwingen.
        body.Labels = { ...(body.Labels ?? {}), 'huddle.parent': containerName };
        const newBodyBuf = Buffer.from(JSON.stringify(body));
        const newHeader = savedHeaderPart.replace(
          /content-length:\s*\d+/i,
          `Content-Length: ${newBodyBuf.length}`
        ) + '\r\n\r\n';
        openUpstream(Buffer.concat([Buffer.from(newHeader), newBodyBuf, rest]));
      }

      // Finding #7: exec-create body werd nooit geïnspecteerd, dus een
      // `{"Privileged":true}` exec kreeg alle capabilities → rauwe host-disk.
      // Buffer de body en weiger een privileged exec; verder ongewijzigd doorsturen.
      function processExecCreate(): void {
        const bodyBytes = bodyBuf.slice(0, bodyContentLength);
        const rest = bodyBuf.slice(bodyContentLength);
        let body: any;
        try {
          body = JSON.parse(bodyBytes.toString());
        } catch {
          // Fail-closed: een niet-parseerbare exec-body mag de Privileged-check
          // niet overslaan.
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
          // Image-namen kunnen slashes bevatten (registry/repo:tag).
          const imgId = p.match(/^\/images\/(.+)$/)?.[1];
          const targetId = ctId ?? imgId;
          const type = ctId ? 'container' : 'image';

          // Network delete — alleen eigen (huddle.parent-gelabelde) netwerken.
          // Ongelabelde netwerken van vóór deze wijziging blijven verwijderbaar,
          // behalve de door huddle beheerde dc-net-* netwerken.
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

          // Volume delete — needed for docker compose down -v. Alleen eigen of
          // ongelabelde (pre-bestaande) volumes; volumes van een andere
          // devcontainer zijn onaantastbaar.
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

          // Volume listing — filter tot eigen volumes zodat peer-volumenamen
          // niet enumereerbaar zijn (finding #8), consistent met de container-
          // en netwerk-listings hierboven.
          if (p === '/volumes') {
            forwardWithRewrittenUrl(headerPart, withLabelFilter(rawUrl, `huddle.parent=${containerName}`), remainder);
            return;
          }
          // Volume inspect — nodig voor docker compose named volumes.
          if (/^\/volumes\/[^/]+$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Events stream — needed for docker compose up log following
          if (p === '/events') {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
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

          // Image tag — lokale metadata-operatie, toegestaan op elk image.
          if (/^\/images\/.+\/tag$/.test(p)) {
            openUpstream(Buffer.concat([Buffer.from(headerPart + '\r\n\r\n'), remainder]));
            return;
          }

          // Image push — alleen eigen (huddle.parent-gelabelde, dus zelf
          // gebouwde) images. Push loopt via de docker-daemon van de host en
          // passeert de huddle-egress-firewall dus niet; de actie staat
          // bovendien standaard uit in het portal.
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

          // Exec-create — buffer + valideer de body (finding #7: Privileged exec).
          // Alleen op eigen spawned containers, nooit op een devcontainer zelf.
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
              // Ownership ok → schakel over naar body-buffering; processExecCreate
              // keurt de exec-config zodra de volledige body binnen is.
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

          // Volume create — needed for docker compose named volumes. Body wordt
          // gebufferd en gevalideerd: local bind-backed volumes (host-path
          // escape) worden geweigerd.
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

          // Volume prune — beperkt tot eigen volumes door een verplicht
          // labelfilter te injecteren; volumes van andere containers (of van
          // vóór de label-injectie) blijven buiten schot.
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
          // Archive upload (docker cp naar een container) — o.a. Aspire's DCP
          // kopieert dev-certs in elke gestarte container (CopyFile, issue #12).
          // Alleen toegestaan op eigen spawned containers, nooit devcontainers.
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
