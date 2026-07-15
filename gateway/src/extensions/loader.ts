import AdmZip from 'adm-zip';
import path from 'path';
import fs from 'fs';
import net from 'net';
import crypto from 'crypto';
import type { FastifyInstance } from 'fastify';
import type { Database } from 'better-sqlite3';
import { stateEvents } from '../events';

export const EXT_DIR = process.env.EXT_DIR ?? '/data/extensions';

export interface ExtensionManifest {
  id: string;
  name: string;
  version?: string;
  icon?: string;
  settings?: Array<{ key: string; label: string; secret?: boolean }>;
}

interface LoadedExtension {
  manifest: ExtensionManifest;
  enabled: boolean;
}

type RouteHandler = (req: any, reply: any) => Promise<unknown>;

/** Centrale dispatch-map: "METHOD:/api/ext/id/pad" → handler.
 *  Wordt gevuld door extensies; de catch-all in api.ts dispatcht ernaar.
 *  Zo hoeven extensies nooit rechtstreeks routes op Fastify te registreren
 *  en kunnen ze op elk moment (her)geladen worden. */
export const extDispatch = new Map<string, RouteHandler>();

export interface VirtualApp {
  get(path: string, handler: RouteHandler): void;
  post(path: string, handler: RouteHandler): void;
  put(path: string, handler: RouteHandler): void;
  delete(path: string, handler: RouteHandler): void;
  inject: FastifyInstance['inject'];
}

export interface ExtensionContext {
  /** Virtuele app: registreer routes zonder Fastify rechtstreeks aan te raken. */
  app: VirtualApp;
  events: typeof stateEvents;
  db: Database;
  log: (msg: string) => void;
  getSetting: (key: string) => string | null;
  setSetting: (key: string, value: string) => void;
  runInContainer: (containerName: string, command: string) => Promise<void>;
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
}

const loaded = new Map<string, LoadedExtension>();
let _app: FastifyInstance | undefined;
let _db: Database | undefined;

export function initLoader(app: FastifyInstance, db: Database): void {
  _app = app;
  _db = db;
}

function makeVirtualApp(extId: string, realApp: FastifyInstance): VirtualApp {
  const reg = (method: string) => (path: string, handler: RouteHandler) => {
    extDispatch.set(`${method}:${path}`, handler);
  };
  return {
    get: reg('GET'),
    post: reg('POST'),
    put: reg('PUT'),
    delete: reg('DELETE'),
    inject: realApp.inject.bind(realApp),
  };
}

function buildContext(id: string): ExtensionContext {
  const db = _db;
  const app = _app;
  if (!app || !db) throw new Error('loader not initialised — roep initLoader() eerst aan');
  // Verwijder eventuele oude routes van een vorige versie van deze extensie
  for (const key of extDispatch.keys()) {
    if (key.includes(`/api/ext/${id}/`)) extDispatch.delete(key);
  }
  return {
    app: makeVirtualApp(id, app),
    events: stateEvents,
    db,
    log: (msg: string) => console.log(`[ext:${id}] ${msg}`),
    getSetting: (key: string): string | null => {
      const row = db.prepare('SELECT value FROM ext_kv WHERE ext_id = ? AND key = ?').get(id, key) as
        | { value: string }
        | undefined;
      return row?.value ?? null;
    },
    setSetting: (key: string, value: string): void => {
      db.prepare(
        'INSERT INTO ext_kv (ext_id, key, value) VALUES (?, ?, ?) ' +
          'ON CONFLICT(ext_id, key) DO UPDATE SET value = excluded.value',
      ).run(id, key, value);
    },
    runInContainer: (containerName: string, command: string): Promise<void> =>
      dockerExecSimple(containerName, command),
    fetch: (url: string, init?: RequestInit): Promise<Response> =>
      fetch(url, { ...init, headers: { ...(init?.headers ?? {}), 'x-huddle-ext': id } }),
  };
}

function dockerRequest(method: string, urlPath: string, body?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const headers = [
      `${method} ${urlPath} HTTP/1.1`,
      'Host: localhost',
      'Content-Type: application/json',
      `Content-Length: ${payload ? Buffer.byteLength(payload) : 0}`,
      'Connection: close',
    ].join('\r\n') + '\r\n\r\n' + (payload ?? '');

    const sock = net.connect('/var/run/docker.sock');
    let raw = '';
    sock.on('data', (d) => { raw += d.toString(); });
    sock.on('end', () => {
      const [head, ...rest] = raw.split('\r\n\r\n');
      const status = parseInt((head.split('\r\n')[0] ?? '').split(' ')[1] ?? '0', 10);
      const bodyStr = rest.join('\r\n\r\n').replace(/^[0-9a-f]+\r\n/gm, '').replace(/\r\n/g, '');
      try {
        const parsed = bodyStr ? JSON.parse(bodyStr) : {};
        if (status >= 400) reject(new Error(`Docker ${method} ${urlPath} → ${status}: ${bodyStr}`));
        else resolve(parsed);
      } catch { resolve({}); }
    });
    sock.on('error', reject);
    sock.write(headers);
  });
}

async function dockerExecSimple(containerName: string, command: string): Promise<void> {
  const exec = await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/exec`, {
    AttachStdout: false, AttachStderr: false, Tty: false,
    Cmd: ['sh', '-c', command],
  }) as { Id: string };
  await dockerRequest('POST', `/exec/${exec.Id}/start`, { Detach: true });
}

function parseManifest(raw: string): ExtensionManifest {
  const manifest = JSON.parse(raw) as ExtensionManifest;
  if (!manifest.id || !manifest.name) throw new Error('manifest.json vereist id en name');
  if (!/^[a-z0-9-]+$/.test(manifest.id)) {
    throw new Error('manifest.id mag alleen a-z, 0-9 en - bevatten');
  }
  return manifest;
}

// ── Extensie-integriteit (finding #11) ──────────────────────────────────────
// Een geüploade extensie draait IN-PROCESS in de gateway (await import → raw
// docker.sock) = host-root-equivalent. Sinds de operator-auth zit de upload
// achter authenticatie, maar dat beschermt niet tegen een operator die een
// gemanipuleerde/kwaadaardige bundel uploadt. Daarom: bereken de SHA-256 van de
// bundel en toets die tegen een pinned allowlist. Consistent met het Phase 0-
// patroon (HUDDLE_HOSTCONFIG_ENFORCE): standaard LOG-ONLY (logt de hash zodat de
// operator hem kan pinnen); zet HUDDLE_EXTENSION_SHA256_ALLOWLIST (komma-
// gescheiden hashes) om alleen die bundels toe te laten en de rest te weigeren.
export function bundleSha256(zipBuffer: Buffer): string {
  return crypto.createHash('sha256').update(zipBuffer).digest('hex');
}

// Retourneert een weigeringsreden, of null wanneer de bundel is toegestaan.
export function checkExtensionIntegrity(zipBuffer: Buffer): string | null {
  const hash = bundleSha256(zipBuffer);
  const raw = process.env.HUDDLE_EXTENSION_SHA256_ALLOWLIST?.trim();
  if (!raw) {
    console.warn(
      `[ext] integriteit (log-only): bundel sha256=${hash}. ` +
      `Zet HUDDLE_EXTENSION_SHA256_ALLOWLIST=${hash}[,…] om uploads tot vertrouwde bundels te beperken.`,
    );
    return null;
  }
  const allow = new Set(raw.split(',').map(h => h.trim().toLowerCase()).filter(Boolean));
  if (!allow.has(hash.toLowerCase())) {
    return `extension bundle sha256 ${hash} is not on HUDDLE_EXTENSION_SHA256_ALLOWLIST`;
  }
  return null;
}

export async function installExtension(
  zipBuffer: Buffer,
): Promise<{ id: string; name: string; restartRequired: boolean }> {
  // Integriteit vóór we ook maar iets uitpakken of laden (fail-closed).
  const integrityError = checkExtensionIntegrity(zipBuffer);
  if (integrityError) throw new Error(integrityError);

  const zip = new AdmZip(zipBuffer);

  const manifestEntry = zip.getEntry('manifest.json');
  if (!manifestEntry) throw new Error('manifest.json ontbreekt in zip');
  const manifest = parseManifest(manifestEntry.getData().toString('utf8'));

  if (!zip.getEntry('index.js')) throw new Error('index.js ontbreekt in zip');

  // Fastify staat geen route-verwijdering of -herdeclaratie toe op een draaiende
  // instantie. Een al-geladen extensie kunnen we daarom niet live herladen: we
  // schrijven de nieuwe bestanden wel naar schijf, maar de nieuwe code wordt pas
  // bij een server-restart actief (loadAllExtensions bij opstart).
  const alreadyLoaded = loaded.has(manifest.id);

  const destDir = path.join(EXT_DIR, manifest.id);
  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  fs.mkdirSync(destDir, { recursive: true });
  zip.extractAllTo(destDir, true);

  if (alreadyLoaded) {
    return { id: manifest.id, name: manifest.name, restartRequired: true };
  }

  await loadExtension(manifest.id);
  return { id: manifest.id, name: manifest.name, restartRequired: false };
}

// Verwijder de extensie-module (en alles eronder) uit de CommonJS require-cache,
// zodat een her-upload de nieuwe code laadt i.p.v. de gecachede oude versie.
function unloadModule(id: string): void {
  const dir = path.join(EXT_DIR, id);
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir + path.sep)) delete require.cache[key];
  }
}

export async function loadExtension(id: string): Promise<void> {
  const dir = path.join(EXT_DIR, id);
  const manifestPath = path.join(dir, 'manifest.json');
  const indexPath = path.join(dir, 'index.js');
  if (!fs.existsSync(manifestPath) || !fs.existsSync(indexPath)) {
    throw new Error(`Extensie '${id}' niet gevonden in ${EXT_DIR}`);
  }

  const manifest = parseManifest(fs.readFileSync(manifestPath, 'utf8'));

  unloadModule(id);
  const mod = await import(indexPath);
  const registerFn = mod.register ?? mod.default?.register;
  if (typeof registerFn !== 'function') {
    throw new Error('index.js exporteert geen register functie');
  }

  await registerFn(buildContext(id));
  loaded.set(id, { manifest, enabled: true });
  console.log(`[ext] geladen: ${id} v${manifest.version ?? '?'}`);
}

export async function loadAllExtensions(): Promise<void> {
  if (!fs.existsSync(EXT_DIR)) return;
  for (const entry of fs.readdirSync(EXT_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await loadExtension(entry.name);
    } catch (err: any) {
      console.error(`[ext:${entry.name}] laden mislukt:`, err.message);
    }
  }
}

export function removeExtension(id: string): void {
  const dir = path.join(EXT_DIR, id);
  unloadModule(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  loaded.delete(id);
}

export function listLoadedExtensions() {
  return Array.from(loaded.entries()).map(([id, { manifest, enabled }]) => ({
    id,
    name: manifest.name,
    version: manifest.version ?? null,
    icon: manifest.icon ?? 'puzzle',
    enabled,
    settings: (manifest.settings ?? []).map((s) => ({
      key: s.key,
      label: s.label,
      secret: s.secret ?? false,
    })),
  }));
}
