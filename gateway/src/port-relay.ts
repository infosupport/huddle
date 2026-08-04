import net from 'net';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { sanitizeResolvConf } from './dns-egress';

// ── Port-relay: published ports of owned containers into the devcontainer ────
// A devcontainer talks to the HOST's docker daemon (docker-outside-of-
// docker). When an owned container publishes a port, it binds on the host's
// loopback — unreachable from the devcontainer, which has no default route
// and its own loopback (issue: Aspire/DCP, Testcontainers, plain
// `docker run -p` — a TCP connect to 127.0.0.1:<hostPort> fails or hangs).
//
// The solution mirrors the docker.sock mechanism: for each published TCP port
// the gateway drops a unix-socket into the already-shared per-container mount
// (/tmp/dc-sockets/<owner>/ports/<hostPort>.sock ≙ /var/run/huddle/ports/… in
// the devcontainer). A small in-devcontainer forwarder (Node, installed by the
// gateway via docker exec) listens on 127.0.0.1/::1:<hostPort> and pipes to
// that unix-socket; the gateway pipes the unix-socket through to
// containerIP:containerPort on the owner's dc-net (which huddle itself is
// already attached to). This way no path via the host loopback is ever needed.

const DOCKER_SOCKET = '/var/run/docker.sock';
const SOCKET_DIR = '/tmp/dc-sockets';

// How long we wait for the in-devcontainer forwarder before the start response
// proceeds anyway. DCP/Testcontainers inspect and connect immediately after the
// start response, so the loopback listener must be there before that response.
const FORWARDER_READY_TIMEOUT_MS = 2000;

// ── Docker helpers ────────────────────────────────────────────────────────────
// Deliberately self-contained (no import from docker.ts): docker.ts imports
// this module, and with socket-proxy.ts in the mix an import cycle is easily
// created.

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

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

export interface RelaySpec {
  hostPort: number;
  containerPort: number;
  proto: string;
}

// Derive the ports to relay from a container inspect. The source is
// NetworkSettings.Ports as it looks AFTER the start, so including dynamically
// assigned ports (HostPort:0 → actual port). Duplicate bindings of the same
// host port (0.0.0.0 + ::) collapse into a single spec.
export function extractRelaySpecs(inspect: any): RelaySpec[] {
  const ports = inspect?.NetworkSettings?.Ports;
  if (!ports || typeof ports !== 'object') return [];
  const seen = new Map<string, RelaySpec>();
  for (const [key, bindings] of Object.entries(ports)) {
    if (!Array.isArray(bindings)) continue; // unpublished port (null)
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

// Network + IP on which the gateway must reach the workload container.
// Preference: the owner's dc-net (huddle is already in it by default). But a
// workload can also live exclusively on its own network — Aspire's DCP creates
// its session network via the socket-proxy and moves containers onto it — and
// Docker's inter-bridge isolation silently DROPs SYNs between bridges. The
// caller must therefore explicitly attach the gateway to `network` before the
// dial (ensure + refcount below); hence the network is returned here as well.
export function resolveTarget(inspect: any, owner: string): RelayTarget | null {
  const nets = inspect?.NetworkSettings?.Networks ?? {};
  const dcNet = `dc-net-${owner}`;
  if (nets[dcNet]?.IPAddress) return { ip: nets[dcNet].IPAddress, network: dcNet };
  for (const [name, n] of Object.entries<any>(nets)) {
    if (n?.IPAddress) return { ip: n.IPAddress, network: name };
  }
  return null;
}

// ── Gateway network management (join + refcount) ─────────────────────────────
// The gateway attaches itself on demand to a workload container's network.
// Refcounted across all relays: only when the last relay on a network
// disappears does the gateway detach again — a leftover membership blocks
// `docker network rm` when Aspire/DCP cleans up its session networks.
// Networks the gateway was already attached to before the first acquire
// (joinedByUs=false) and permanent networks (dc-net-*) are never
// disconnected.

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

// Is `ip` inside IPv4 CIDR `subnet`? IPv6 subnets (rare for Docker bridges)
// conservatively don't match — in that case only the proxy's default-deny
// remains as a layer. Exported for unit tests.
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
  // Serialized per network so that a concurrent acquire/release can never
  // interleave a connect and a disconnect.
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
    // Only subnets of networks that WE joined for the relay: traffic from
    // there is by definition workload traffic and must never reach the :3000
    // API (see the connection guard in api.ts). Existing memberships
    // (dc-net-*, the default net) stay out of scope.
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

// The gateway's own container reference for connect/disconnect: the container
// id from /etc/hostname (Docker sets the id as hostname), with 'huddle' (the
// fixed container name from the CLI init) as fallback. Verified once via
// inspect.
let selfRefPromise: Promise<string> | null = null;
function resolveSelfRef(): Promise<string> {
  if (!selfRefPromise) {
    selfRefPromise = (async () => {
      const candidates: string[] = [];
      try { candidates.push(fs.readFileSync('/etc/hostname', 'utf8').trim()); } catch (err: any) {
        console.warn(`[port-relay] cannot read /etc/hostname (${err?.message ?? err}); falling back to container name 'huddle'`);
      }
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
      // Podman regenerates resolv.conf on every connect of the gateway;
      // restore it so egress DNS keeps working (same reflex as docker.ts).
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

// For the :3000 API guard (api.ts): does this source IP come from a network
// that the gateway joined solely for the port-relay?
export function isRelayNetworkIp(ip: string): boolean {
  return gatewayNetworks.isJoinedNetworkIp(ip);
}

// Backend dial with a hard connect timeout. Docker's inter-bridge isolation
// silently DROPs SYNs (no RST): without a timeout a client hangs forever on
// an accept with no bytes. Exported for unit tests.
export function dialWithTimeout(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.on('connect', () => {
      clearTimeout(timer);
      // Safety net until the caller attaches its own error handlers.
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
  // Network the relays currently dial over; carries one refcount with the
  // network management. Can shift per connection (restart on another network).
  network: string | null;
}

const relaysById = new Map<string, ContainerRelays>();
// name / short id / full id → full id, so that teardown works with whatever
// the docker client happened to put in the path.
const aliasIndex = new Map<string, string>();

// `owner` flows into path.join() under SOCKET_DIR. The name comes from
// huddle's own orchestration or an operator API parameter; just like in
// socket-proxy.ts (assertSafeContainerName — duplicated here because
// socket-proxy imports this very module and a cycle is otherwise easily
// created) we explicitly enforce the Docker name grammar: no slashes and no
// leading dot, so it is impossible to write or read outside the sockets
// directory using `..`/`/`.
const OWNER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

export function assertSafeOwner(owner: string): void {
  if (typeof owner !== 'string' || !OWNER_NAME_RE.test(owner))
    throw new Error(`unsafe owner name: ${JSON.stringify(owner)}`);
}

function portsDirFor(owner: string): string {
  assertSafeOwner(owner);
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
    // close() stops accepting; in-flight connections may drain (the
    // container is going down anyway, so they reset on their own).
    try { r.server.close(); } catch {}
    unlinkRelayFiles(r.sockPath);
  }
  console.log(`[port-relay] ${entry.owner}: relays down for ${id.slice(0, 12)} (${entry.relays.map(r => r.spec.hostPort).join(', ') || 'none'})`);
  // Release the network ref only after closing: if this was the last relay on
  // that network, the gateway detaches and `docker network rm` works again.
  if (entry.network) await gatewayNetworks.release(entry.network, id);
}

// Forward one incoming connection on the unix-socket to the workload
// container. The target (network + IP) is fetched fresh from an inspect per
// connection: that way the relay survives a container restart with a new IP or
// a different network, and it cleans itself up when the container disappeared
// outside the proxy (404). Every failure path closes the client hard (fail
// fast) — the silent infinite hang of Docker's inter-bridge DROP must not be
// reproducible.
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
  // Re-check ownership on the fresh inspect: even after a restart/re-create a
  // relay must never end up pointing at someone else's container
  // (#82 semantics — the id may have changed owner in the meantime).
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
  // Make sure the gateway is attached to the target network before the dial;
  // otherwise SYNs between bridges are dropped silently. Idempotent and
  // refcounted; on a network switch (restart) the ref moves from the old to
  // the new net. No entry left = teardown won the race — in that case don't
  // take a ref that nobody will release anymore.
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

// Wait until the in-devcontainer forwarder confirms the loopback listener
// (`<port>.ready`), or reports a clear error (`<port>.err`, e.g. port already
// in use in the devcontainer). A timeout is not an error: the relay still
// works once the forwarder catches up, only the first connections may race.
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

// (Re)build the relays for one owned container based on a fresh inspect.
// Called after a successful start/restart via the socket-proxy, and at
// gateway startup for already-running owned containers. The ownership check
// here is defence-in-depth: the socket-proxy has already verified, but relays
// for someone else's containers must never come into existence standalone
// either (#82 semantics).
export async function syncContainerRelays(owner: string, containerRef: string): Promise<void> {
  assertSafeOwner(owner);
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

  // Attach the gateway to the target network up front, so the first dial
  // doesn't have to wait for the join. If this fails (network just removed?),
  // the relay stays in place: every connection retries it and otherwise fails
  // loudly via the dial guard in relayConnection.
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
// Runs as root in the devcontainer (Node is in the base image). Watches
// /var/run/huddle/ports and mirrors every <port>.sock to a TCP listener on
// 127.0.0.1 (required) and ::1 (best effort — DCP addresses [::1]). Reports
// success/failure via <port>.ready / <port>.err so the gateway can hold the
// start response until the listener really exists.

const FORWARDER_JS = `// huddle-port-forwarder: mirrors published ports of owned containers
// onto this devcontainer's loopback. Managed by the huddle gateway.
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
  // 127.0.0.1 is required; ::1 best effort (IPv6 may be disabled).
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
    if (active.has(port)) ensureReady(port); // gateway may want to see .ready rewritten after a resync
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
// Safety net for missed inotify events or a ports dir that appears only later.
setInterval(() => { ensureWatch(); sync(); }, 2000);
log('forwarder started');
`;

// Sh script that installs and (re)starts the forwarder in the devcontainer.
// Idempotent: with an unchanged script and a live pid file nothing happens;
// a new forwarder version replaces the file and restarts the process.
// Additionally sets host.docker.internal → 127.0.0.1 in /etc/hosts, so that
// the hostname convention of DCP/Testcontainers ends up on the relays.
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

// Install/start the forwarder in a (running) devcontainer. Called on
// devcontainer creation, on a start via the portal, and at gateway startup.
export async function ensurePortForwarder(owner: string, containerRef?: string): Promise<void> {
  assertSafeOwner(owner);
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

// Recovery after a gateway restart: set up the forwarder (again) in every
// running devcontainer and rebuild relays for their already-running owned
// containers (the unix-sockets from before the restart are dead).
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
