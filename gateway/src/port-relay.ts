import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { sanitizeResolvConf } from './dns-egress';

// ── Port-relay: gepubliceerde poorten van owned containers de devcontainer in ─
// Een devcontainer praat met de docker-daemon van de HOST (docker-outside-of-
// docker). Publiceert een owned container een poort, dan bindt die op de
// loopback van de host — onbereikbaar vanuit de devcontainer, die geen default
// route heeft en een eigen loopback (issue: Aspire/DCP, Testcontainers, plain
// `docker run -p` — TCP connect naar 127.0.0.1:<hostPort> faalt of hangt).
//
// De oplossing spiegelt het docker.sock-mechanisme: per gepubliceerde TCP-poort
// legt de gateway een unix-socket neer in de al gedeelde per-container mount
// (/tmp/dc-sockets/<owner>/ports/<hostPort>.sock ≙ /var/run/huddle/ports/… in
// de devcontainer). Een kleine in-devcontainer forwarder (Node, door de gateway
// via docker exec geïnstalleerd) luistert op 127.0.0.1/::1:<hostPort> en pipe't
// naar die unix-socket; de gateway pipe't de unix-socket door naar
// containerIP:containerPort op het dc-net van de eigenaar (waar huddle zelf al
// aan gekoppeld is). Zo is er nooit een pad via de host-loopback nodig.

const DOCKER_SOCKET = '/var/run/docker.sock';
const SOCKET_DIR = '/tmp/dc-sockets';

// Hoe lang we op de in-devcontainer forwarder wachten voordat de start-respons
// alsnog doorgaat. DCP/Testcontainers inspecteren en connecten direct ná de
// start-respons, dus de loopback-listener moet er vóór die respons zijn.
const FORWARDER_READY_TIMEOUT_MS = 2000;

// ── Docker helpers ────────────────────────────────────────────────────────────
// Bewust zelfstandig (geen import uit docker.ts): docker.ts importeert deze
// module, en een importcyclus met socket-proxy.ts erbij is dan snel gemaakt.

function dockerRequestJson(method: string, urlPath: string, body?: unknown): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        socketPath: DOCKER_SOCKET,
        method,
        path: urlPath,
        headers: bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {},
      },
      (res) => {
        let raw = '';
        res.on('data', (d: Buffer) => { raw += d.toString(); });
        res.on('end', () => {
          let data: any = null;
          try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
          resolve({ status: res.statusCode ?? 0, data });
        });
      }
    );
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

// ── Pure helpers (unit-getest) ────────────────────────────────────────────────

export interface RelaySpec {
  hostPort: number;
  containerPort: number;
  proto: string;
}

// Leid uit een container-inspect de te relayen poorten af. Bron is
// NetworkSettings.Ports zoals dat er NÁ de start uitziet, dus inclusief
// dynamisch toegewezen poorten (HostPort:0 → daadwerkelijke poort). Dubbele
// bindings van dezelfde hostpoort (0.0.0.0 + ::) vallen samen tot één spec.
export function extractRelaySpecs(inspect: any): RelaySpec[] {
  const ports = inspect?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return [];
  const seen = new Map<string, RelaySpec>();
  for (const [key, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings)) continue; // niet-gepubliceerde poort (null)
    const [portStr, proto = 'tcp'] = key.split('/');
    const containerPort = parseInt(portStr, 10);
    if (!Number.isInteger(containerPort) || containerPort <= 0) continue;
    for (const b of bindings) {
      const hostPort = parseInt(String((b as any)?.HostPort ?? ''), 10);
      if (!Number.isInteger(hostPort) || hostPort <= 0) continue;
      const k = `${hostPort}/${proto}`;
      if (!seen.has(k)) seen.set(k, { hostPort, containerPort, proto });
    }
  }
  return [...seen.values()];
}

export interface RelayTarget {
  ip: string;
  network: string;
}

// Netwerk + IP waarop de gateway de workload-container moet bereiken. Voorkeur:
// het dc-net van de eigenaar (daar zit huddle standaard al in). Maar een
// workload kan óók uitsluitend op een eigen netwerk leven — Aspire's DCP maakt
// z'n session-netwerk via de socket-proxy aan en verhangt containers erheen —
// en Docker's inter-bridge-isolatie DROP't SYN's stilletjes tussen bridges. De
// caller moet de gateway dus expliciet aan `network` koppelen vóór de dial
// (ensure + refcount hieronder); vandaar dat het netwerk hier mee terugkomt.
export function resolveTarget(inspect: any, owner: string): RelayTarget | null {
  const nets = inspect?.NetworkSettings?.Networks ?? {};
  const dcNet = `dc-net-${owner}`;
  if (nets[dcNet]?.IPAddress) return { ip: nets[dcNet].IPAddress, network: dcNet };
  for (const [name, n] of Object.entries<any>(nets)) {
    if (n?.IPAddress) return { ip: n.IPAddress, network: name };
  }
  return null;
}

// ── Gateway-netwerkbeheer (join + refcount) ──────────────────────────────────
// De gateway koppelt zichzelf on demand aan het netwerk van een workload-
// container. Refcounted over alle relays heen: pas als de laatste relay op een
// netwerk verdwijnt, koppelt de gateway zich weer los — een achtergebleven
// membership blokkeert `docker network rm` wanneer Aspire/DCP z'n session-
// netwerken opruimt. Netwerken waar de gateway al aan hing vóór de eerste
// acquire (joinedByUs=false) en permanente netwerken (dc-net-*) worden nooit
// losgekoppeld.

export type NetworkConnectResult = 'connected' | 'already-connected' | 'missing' | 'error';

export interface GatewayNetworkOps {
  connect(network: string): Promise<NetworkConnectResult>;
  disconnect(network: string): Promise<void>;
  subnets(network: string): Promise<string[]>;
}

export interface NetworkRefTracker {
  acquire(network: string, ref: string): Promise<boolean>;
  release(network: string, ref: string): Promise<void>;
  isJoined(network: string): boolean;
  isJoinedNetworkIp(ip: string): boolean;
}

// Zit `ip` in IPv4-CIDR `subnet`? IPv6-subnetten (zeldzaam voor Docker-bridges)
// matchen conservatief niet — dan blijft alleen de default-deny van de proxy
// als laag over. Exported voor unit-tests.
export function ipInSubnet(rawIp: string, subnet: string): boolean {
  const ip = rawIp.replace(/^::ffff:/, '');
  const m = subnet.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)\/(\d+)$/);
  const i = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (!m || !i) return false;
  const bits = parseInt(m[5], 10);
  if (bits < 0 || bits > 32) return false;
  const toNum = (p: string[]) => ((+p[0] << 24) | (+p[1] << 16) | (+p[2] << 8) | +p[3]) >>> 0;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toNum(m.slice(1, 5)) & mask) === (toNum(i.slice(1, 5)) & mask);
}

export function createNetworkRefTracker(
  ops: GatewayNetworkOps,
  isPermanent: (network: string) => boolean = (n) => n.startsWith('dc-net-'),
): NetworkRefTracker {
  interface JoinedNet { joinedByUs: boolean; refs: Set<string>; subnets: string[]; }
  const nets = new Map<string, JoinedNet>();
  // Per netwerk geserialiseerd zodat een gelijktijdige acquire/release nooit
  // een connect en disconnect door elkaar laat lopen.
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(network: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(network) ?? Promise.resolve();
    const p = prev.then(fn, fn);
    locks.set(network, p.then(() => {}, () => {}));
    return p;
  }

  return {
    acquire(network, ref) {
      return withLock(network, async () => {
        const existing = nets.get(network);
        if (existing) { existing.refs.add(ref); return true; }
        const res = await ops.connect(network);
        if (res === 'missing' || res === 'error') return false;
        const subnets = await ops.subnets(network).catch(() => []);
        nets.set(network, { joinedByUs: res === 'connected', refs: new Set([ref]), subnets });
        return true;
      });
    },
    release(network, ref) {
      return withLock(network, async () => {
        const entry = nets.get(network);
        if (!entry) return;
        entry.refs.delete(ref);
        if (entry.refs.size > 0) return;
        nets.delete(network);
        if (entry.joinedByUs && !isPermanent(network)) {
          await ops.disconnect(network).catch(() => {});
        }
      });
    },
    isJoined(network) {
      return nets.has(network);
    },
    // Alleen subnetten van netwerken die WIJ voor de relay joinden: verkeer
    // daarvandaan is per definitie workload-verkeer en mag de :3000-API nooit
    // bereiken (zie de connection-guard in api.ts). Bestaande memberships
    // (dc-net-*, het default-net) blijven buiten schot.
    isJoinedNetworkIp(ip) {
      for (const entry of nets.values()) {
        if (!entry.joinedByUs) continue;
        for (const s of entry.subnets) {
          if (ipInSubnet(ip, s)) return true;
        }
      }
      return false;
    },
  };
}

// Eigen container-referentie van de gateway voor connect/disconnect: de
// container-id uit /etc/hostname (Docker zet de id als hostname), met 'huddle'
// (de vaste containernaam uit de CLI-init) als fallback. Eénmalig geverifieerd
// via inspect.
let selfRefPromise: Promise<string> | null = null;
function resolveSelfRef(): Promise<string> {
  if (!selfRefPromise) {
    selfRefPromise = (async () => {
      const candidates: string[] = [];
      try { candidates.push(fs.readFileSync('/etc/hostname', 'utf8').trim()); } catch {}
      candidates.push('huddle');
      for (const c of candidates) {
        if (!c) continue;
        try {
          const { status } = await dockerRequestJson('GET', `/containers/${encodeURIComponent(c)}/json`);
          if (status === 200) return c;
        } catch {}
      }
      return 'huddle';
    })();
  }
  return selfRefPromise;
}

const realNetworkOps: GatewayNetworkOps = {
  async connect(network) {
    const self = await resolveSelfRef();
    const { status, data } = await dockerRequestJson(
      'POST', `/networks/${encodeURIComponent(network)}/connect`, { Container: self },
    );
    if (status < 300) {
      // Podman regenereert resolv.conf bij elke connect van de gateway; herstel
      // hem zodat egress-DNS blijft werken (zelfde reflex als docker.ts).
      await sanitizeResolvConf().catch(() => {});
      return 'connected';
    }
    const msg = String(data?.message ?? '');
    // Docker: "…already exists in network…", Podman: "…already connected…".
    if (msg.includes('already exists in network') || msg.includes('already connected')) return 'already-connected';
    if (status === 404) return 'missing';
    console.warn(`[port-relay] connect to network ${network} failed (${status}): ${msg}`);
    return 'error';
  },
  async disconnect(network) {
    const self = await resolveSelfRef();
    await dockerRequestJson('POST', `/networks/${encodeURIComponent(network)}/disconnect`, { Container: self });
    await sanitizeResolvConf().catch(() => {});
  },
  async subnets(network) {
    const { status, data } = await dockerRequestJson('GET', `/networks/${encodeURIComponent(network)}`);
    if (status !== 200) return [];
    const cfg = data?.IPAM?.Config;
    if (!Array.isArray(cfg)) return [];
    return cfg.map((c: any) => String(c?.Subnet ?? '')).filter(Boolean);
  },
};

const gatewayNetworks = createNetworkRefTracker(realNetworkOps);

// Voor de :3000-API-guard (api.ts): komt dit bron-IP uit een netwerk dat de
// gateway alleen voor de port-relay heeft gejoined?
export function isRelayNetworkIp(ip: string): boolean {
  return gatewayNetworks.isJoinedNetworkIp(ip);
}

// Backend-dial met harde connect-timeout. Docker's inter-bridge-isolatie DROP't
// SYN's stilletjes (geen RST): zonder timeout hangt een client voor altijd op
// een accept zonder bytes. Exported voor unit-tests.
export function dialWithTimeout(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      // Vangnet tot de caller z'n eigen error-handlers hangt.
      sock.on('error', () => {});
      resolve(sock);
    });
    sock.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

const DIAL_TIMEOUT_MS = 5_000;

// ── Relay-registry ────────────────────────────────────────────────────────────

interface ActiveRelay {
  spec: RelaySpec;
  server: net.Server;
  sockPath: string;
}

interface ContainerRelays {
  owner: string;
  containerId: string;
  containerName: string;
  aliases: string[];
  relays: ActiveRelay[];
  // Netwerk waarover de relays momenteel dialen; draagt één refcount bij het
  // netwerkbeheer. Kan per verbinding verspringen (herstart op ander netwerk).
  network: string | null;
}

const relaysById = new Map<string, ContainerRelays>();
// name / korte id / volle id → volle id, zodat teardown werkt met wat de
// docker-client ook maar in het pad zette.
const aliasIndex = new Map<string, string>();

function portsDirFor(owner: string): string {
  return path.join(SOCKET_DIR, owner, 'ports');
}

function unlinkRelayFiles(sockPath: string): void {
  for (const p of [sockPath, sockPath.replace(/\.sock$/, '.ready'), sockPath.replace(/\.sock$/, '.err')]) {
    try { fs.unlinkSync(p); } catch {}
  }
}

export async function teardownContainerRelays(ref: string): Promise<void> {
  const id = aliasIndex.get(ref) ?? ref;
  const entry = relaysById.get(id);
  if (!entry) return;
  relaysById.delete(id);
  for (const a of entry.aliases) {
    if (aliasIndex.get(a) === id) aliasIndex.delete(a);
  }
  for (const r of entry.relays) {
    // close() stopt met accepteren; lopende verbindingen mogen leeglopen (de
    // container gaat toch neer, dan resetten ze vanzelf).
    try { r.server.close(); } catch {}
    unlinkRelayFiles(r.sockPath);
  }
  console.log(`[port-relay] ${entry.owner}: relays down for ${id.slice(0, 12)} (${entry.relays.map(r => r.spec.hostPort).join(', ') || 'none'})`);
  // Netwerk-ref pas ná het sluiten vrijgeven: was dit de laatste relay op dat
  // netwerk, dan koppelt de gateway zich los en kan `docker network rm` weer.
  if (entry.network) await gatewayNetworks.release(entry.network, id);
}

// Eén inkomende verbinding op de unix-socket doorzetten naar de workload-
// container. Target (netwerk + IP) wordt per verbinding vers uit een inspect
// gehaald: zo overleeft de relay een container-herstart met nieuw IP of ander
// netwerk, en ruimt hij zichzelf op wanneer de container buiten de proxy om
// verdween (404). Elke faalroute sluit de client hard (fail fast) — de stille
// oneindige hang van Docker's inter-bridge-DROP mag niet reproduceerbaar zijn.
async function relayConnection(client: net.Socket, owner: string, containerId: string, spec: RelaySpec): Promise<void> {
  client.on('error', () => {});
  const fail = (reason: string): void => {
    console.error(`[port-relay] ${owner}: backend dial failed for container ${containerId.slice(0, 12)} port ${spec.hostPort}→${spec.containerPort}: ${reason}`);
    client.destroy();
  };
  let inspect: { status: number; data: any };
  try {
    inspect = await dockerRequestJson('GET', `/containers/${containerId}/json`);
  } catch (err: any) {
    fail(`inspect failed: ${err.message}`);
    return;
  }
  if (inspect.status === 404) {
    client.destroy();
    void teardownContainerRelays(containerId);
    return;
  }
  if (inspect.status !== 200 || !inspect.data?.State?.Running) {
    fail('container is not running');
    return;
  }
  // Ownership her-checken op het verse inspect: een relay mag ook ná een
  // herstart/re-create nooit naar een container van een ander gaan wijzen
  // (#82-semantiek — het id kan inmiddels van eigenaar gewisseld zijn).
  if (inspect.data.Config?.Labels?.['huddle.parent'] !== owner) {
    fail('container is no longer owned by this devcontainer');
    void teardownContainerRelays(containerId);
    return;
  }
  const target = resolveTarget(inspect.data, owner);
  if (!target) {
    fail('container has no reachable network/IP');
    return;
  }
  // Zorg dat de gateway aan het doelnetwerk hangt vóór de dial; tussen bridges
  // worden SYN's anders geluidloos gedropt. Idempotent en refcounted; bij een
  // netwerkwissel (herstart) verhuist de ref van het oude naar het nieuwe net.
  // Geen entry meer = teardown won de race — dan geen ref meer nemen die
  // niemand nog vrijgeeft.
  const entry = relaysById.get(containerId);
  if (!entry) {
    client.destroy();
    return;
  }
  if (!(await gatewayNetworks.acquire(target.network, containerId))) {
    fail(`cannot join network ${target.network}`);
    return;
  }
  if (entry.network !== target.network) {
    const old = entry.network;
    entry.network = target.network;
    if (old) void gatewayNetworks.release(old, containerId);
  }
  let backend: net.Socket;
  try {
    backend = await dialWithTimeout(target.ip, spec.containerPort, DIAL_TIMEOUT_MS);
  } catch (err: any) {
    fail(`network ${target.network}, target ${target.ip}:${spec.containerPort}: ${err.message}`);
    return;
  }
  backend.on('error', () => client.destroy());
  client.on('error', () => backend.destroy());
  client.pipe(backend);
  backend.pipe(client);
  client.on('close', () => backend.destroy());
  backend.on('close', () => client.destroy());
}

function listenRelay(owner: string, containerId: string, spec: RelaySpec, sockPath: string): Promise<net.Server | null> {
  return new Promise((resolve) => {
    const server = net.createServer((client) => { void relayConnection(client, owner, containerId, spec); });
    server.on('error', (err) => {
      console.warn(`[port-relay] ${owner}: listen on ${sockPath} failed:`, err.message);
      resolve(null);
    });
    server.listen(sockPath, () => {
      try { fs.chmodSync(sockPath, 0o777); } catch {}
      resolve(server);
    });
  });
}

// Wacht tot de in-devcontainer forwarder de loopback-listener bevestigt
// (`<port>.ready`), of een duidelijke fout meldt (`<port>.err`, bv. poort al in
// gebruik in de devcontainer). Timeout is geen fout: de relay werkt dan alsnog
// zodra de forwarder bijtrekt, alleen kunnen eerste connecties racen.
async function waitForForwarderReady(dir: string, spec: RelaySpec, owner: string): Promise<void> {
  const readyPath = path.join(dir, `${spec.hostPort}.ready`);
  const errPath = path.join(dir, `${spec.hostPort}.err`);
  const deadline = Date.now() + FORWARDER_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(readyPath)) return;
    if (fs.existsSync(errPath)) {
      let msg = '';
      try { msg = fs.readFileSync(errPath, 'utf8').trim(); } catch {}
      console.warn(`[port-relay] ${owner}: devcontainer listener for port ${spec.hostPort} failed: ${msg || 'unknown error'} (port already in use in the devcontainer?)`);
      return;
    }
    await sleep(50);
  }
  console.warn(`[port-relay] ${owner}: devcontainer forwarder did not confirm port ${spec.hostPort} within ${FORWARDER_READY_TIMEOUT_MS}ms; first connections may be refused`);
}

// (Her)bouw de relays voor één owned container op basis van een verse inspect.
// Aangeroepen ná een geslaagde start/restart via de socket-proxy, en bij
// gateway-start voor al draaiende owned containers. De ownership-check hier is
// verdediging-in-de-diepte: de socket-proxy heeft al geverifieerd, maar relays
// van andermans containers mogen ook standalone nooit ontstaan (#82-semantiek).
export async function syncContainerRelays(owner: string, containerRef: string): Promise<void> {
  const { status, data } = await dockerRequestJson('GET', `/containers/${encodeURIComponent(containerRef)}/json`);
  if (status !== 200 || !data) return;
  if (data.Config?.Labels?.['huddle.parent'] !== owner) return;
  const id: string = data.Id;

  await teardownContainerRelays(id);

  const specs = extractRelaySpecs(data);
  for (const s of specs) {
    if (s.proto !== 'tcp') {
      console.warn(`[port-relay] ${owner}: ${s.proto} binding ${s.hostPort} not relayed (only tcp is supported)`);
    }
  }
  const tcp = specs.filter(s => s.proto === 'tcp');
  if (tcp.length === 0) return;

  const dir = portsDirFor(owner);
  fs.mkdirSync(dir, { recursive: true });
  const name = String(data.Name ?? '').replace(/^\//, '');
  const entry: ContainerRelays = {
    owner,
    containerId: id,
    containerName: name,
    aliases: [id, id.slice(0, 12), name].filter(Boolean),
    relays: [],
    network: null,
  };

  // Gateway alvast aan het doelnetwerk koppelen, zodat de eerste dial niet op
  // de join hoeft te wachten. Faalt dit (netwerk net verwijderd?), dan blijft
  // de relay bestaan: elke verbinding probeert het opnieuw en faalt anders
  // luid via de dial-guard in relayConnection.
  const target = resolveTarget(data, owner);
  if (target) {
    if (await gatewayNetworks.acquire(target.network, id)) {
      entry.network = target.network;
    } else {
      console.error(`[port-relay] ${owner}: cannot join network ${target.network} for ${name || id.slice(0, 12)} (target ${target.ip})`);
    }
  }

  for (const spec of tcp) {
    const sockPath = path.join(dir, `${spec.hostPort}.sock`);
    unlinkRelayFiles(sockPath);
    const server = await listenRelay(owner, id, spec, sockPath);
    if (server) entry.relays.push({ spec, server, sockPath });
  }
  if (entry.relays.length === 0) {
    if (entry.network) await gatewayNetworks.release(entry.network, id);
    return;
  }

  relaysById.set(id, entry);
  for (const a of entry.aliases) aliasIndex.set(a, id);

  await Promise.all(entry.relays.map(r => waitForForwarderReady(dir, r.spec, owner)));
  console.log(`[port-relay] ${owner}: relaying ${entry.relays.map(r => `${r.spec.hostPort}→${r.spec.containerPort}`).join(', ')} for ${name || id.slice(0, 12)}`);
}

// ── In-devcontainer forwarder ─────────────────────────────────────────────────
// Draait als root in de devcontainer (Node zit in het base-image). Houdt
// /var/run/huddle/ports in de gaten en spiegelt elke <port>.sock naar een
// TCP-listener op 127.0.0.1 (verplicht) en ::1 (best effort — DCP adresseert
// [::1]). Meldt succes/falen via <port>.ready / <port>.err zodat de gateway de
// start-respons kan ophouden tot de listener er echt is.

const FORWARDER_JS = `// huddle-port-forwarder: spiegelt gepubliceerde poorten van owned containers
// op de loopback van deze devcontainer. Beheerd door de huddle-gateway.
'use strict';
const fs = require('fs');
const net = require('net');
const path = require('path');
const DIR = '/var/run/huddle/ports';
function log(msg) {
  try { fs.appendFileSync('/tmp/huddle-port-forwarder.log', new Date().toISOString() + ' ' + msg + '\\n'); } catch (e) {}
}
const active = new Map(); // port -> [servers]
function ensureReady(port) {
  const p = path.join(DIR, port + '.ready');
  try { if (!fs.existsSync(p)) fs.writeFileSync(p, ''); } catch (e) {}
}
function open(port) {
  const sockPath = path.join(DIR, port + '.sock');
  const servers = [];
  active.set(port, servers);
  let pending = 0;
  let v4ok = false;
  let v4err = null;
  const finish = () => {
    if (pending !== 0) return;
    if (v4ok) {
      try { fs.unlinkSync(path.join(DIR, port + '.err')); } catch (e) {}
      ensureReady(port);
      log('listening on ' + port);
    } else {
      try { fs.writeFileSync(path.join(DIR, port + '.err'), String(v4err || 'listen failed')); } catch (e) {}
      log('FAILED to listen on 127.0.0.1:' + port + ': ' + v4err);
      for (const s of servers) { try { s.close(); } catch (e) {} }
      active.delete(port);
    }
  };
  const listen = (host, required) => {
    pending++;
    const srv = net.createServer((client) => {
      const up = net.createConnection(sockPath);
      client.on('error', () => up.destroy());
      up.on('error', () => client.destroy());
      client.pipe(up);
      up.pipe(client);
      client.on('close', () => up.destroy());
      up.on('close', () => client.destroy());
    });
    srv.on('error', (err) => {
      if (required) v4err = err.message;
      pending--;
      finish();
    });
    srv.listen(port, host, () => {
      if (required) v4ok = true;
      pending--;
      finish();
    });
    servers.push(srv);
  };
  // 127.0.0.1 is verplicht; ::1 best effort (IPv6 kan uit staan).
  listen('127.0.0.1', true);
  listen('::1', false);
}
function sync() {
  let names = [];
  try { names = fs.readdirSync(DIR); } catch (e) { names = []; }
  const want = new Set();
  for (const n of names) {
    const m = /^(\\d+)\\.sock$/.exec(n);
    if (m) want.add(parseInt(m[1], 10));
  }
  for (const [port, servers] of active) {
    if (want.has(port)) continue;
    for (const s of servers) { try { s.close(); } catch (e) {} }
    active.delete(port);
    try { fs.unlinkSync(path.join(DIR, port + '.ready')); } catch (e) {}
    log('closed ' + port);
  }
  for (const port of want) {
    if (active.has(port)) ensureReady(port); // gateway kan .ready herschreven willen zien na resync
    else open(port);
  }
}
let watching = false;
function ensureWatch() {
  if (watching) return;
  try {
    fs.watch(DIR, () => setTimeout(sync, 20));
    watching = true;
  } catch (e) {}
}
ensureWatch();
sync();
// Vangnet voor gemiste inotify-events of een pas later verschenen ports-dir.
setInterval(() => { ensureWatch(); sync(); }, 2000);
log('forwarder started');
`;

// Sh-script dat de forwarder in de devcontainer installeert en (her)start.
// Idempotent: bij ongewijzigd script en levend pid-bestand gebeurt er niets;
// een nieuwe forwarder-versie vervangt het bestand en herstart het proces.
// Zet daarnaast host.docker.internal → 127.0.0.1 in /etc/hosts, zodat de
// hostnaam-conventie van DCP/Testcontainers op de relays uitkomt.
export function buildForwarderSetupScript(): string {
  const b64 = Buffer.from(FORWARDER_JS, 'utf8').toString('base64');
  return `#!/bin/sh
TARGET=/usr/local/lib/huddle-port-forwarder.js
PIDFILE=/tmp/huddle-port-forwarder.pid
mkdir -p /usr/local/lib /var/run/huddle/ports 2>/dev/null || true
TMP=$(mktemp /tmp/huddle-pf.XXXXXX)
echo '${b64}' | base64 -d > "$TMP"
if ! cmp -s "$TMP" "$TARGET" 2>/dev/null; then
  mv "$TMP" "$TARGET"
  [ -f "$PIDFILE" ] && kill "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null || true
else
  rm -f "$TMP"
fi
grep -q 'host\\.docker\\.internal' /etc/hosts 2>/dev/null || echo '127.0.0.1 host.docker.internal' >> /etc/hosts
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE" 2>/dev/null)" 2>/dev/null; then exit 0; fi
nohup node "$TARGET" >> /tmp/huddle-port-forwarder.log 2>&1 &
echo $! > "$PIDFILE"
`;
}

// Installeer/start de forwarder in een (draaiende) devcontainer. Aangeroepen
// bij devcontainer-aanmaak, bij een start via het portal en bij gateway-start.
export async function ensurePortForwarder(owner: string, containerRef?: string): Promise<void> {
  const ref = containerRef ?? owner;
  try {
    fs.mkdirSync(portsDirFor(owner), { recursive: true });
    const exec = await dockerRequestJson('POST', `/containers/${encodeURIComponent(ref)}/exec`, {
      User: 'root',
      Cmd: ['sh', '-c', buildForwarderSetupScript()],
      AttachStdout: false,
      AttachStderr: false,
    });
    if (exec.status >= 400 || !exec.data?.Id) throw new Error(`exec create → ${exec.status}`);
    const started = await dockerRequestJson('POST', `/exec/${exec.data.Id}/start`, { Detach: true });
    if (started.status >= 400) throw new Error(`exec start → ${started.status}`);
  } catch (err: any) {
    console.warn(`[port-relay] ${owner}: could not start in-devcontainer forwarder:`, err.message);
  }
}

// Herstel na een gateway-herstart: forwarder in elke draaiende devcontainer
// (opnieuw) opzetten en relays terugbouwen voor hun al draaiende owned
// containers (de unix-sockets van vóór de herstart zijn dood).
export async function initPortRelays(): Promise<void> {
  try {
    const filters = encodeURIComponent(JSON.stringify({ label: ['com.intellij.devcontainer.id'] }));
    const { status, data } = await dockerRequestJson('GET', `/containers/json?filters=${filters}`);
    if (status !== 200 || !Array.isArray(data)) return;
    for (const dc of data) {
      const name = String(dc.Names?.[0] ?? '').replace(/^\//, '');
      if (!name) continue;
      await ensurePortForwarder(name, dc.Id);
      const childFilters = encodeURIComponent(JSON.stringify({ label: [`huddle.parent=${name}`] }));
      const children = await dockerRequestJson('GET', `/containers/json?filters=${childFilters}`);
      if (children.status !== 200 || !Array.isArray(children.data)) continue;
      for (const c of children.data) {
        try {
          await syncContainerRelays(name, c.Id);
        } catch (err: any) {
          console.warn(`[port-relay] ${name}: resync failed for ${String(c.Id).slice(0, 12)}:`, err.message);
        }
      }
    }
  } catch (err: any) {
    console.error('[port-relay] init failed:', err.message);
  }
}
