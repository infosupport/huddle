// ── Huddle CA → HOST trust store (sbx mode) ───────────────────────────────────
// WHY THIS EXISTS (measured, not assumed):
//
// In sbx mode there are TWO TLS terminators, not one. For most hosts the sbx
// proxy just tunnels CONNECT to Huddle, so the client *inside* the sandbox sees
// Huddle's leaf and `sbx.ts:trustCa()` (CA installed in the sandbox) is enough:
//
//   sandbox curl https://github.com   → issuer: CN=Huddle DMZ Proxy Root CA
//
// But for at least the Claude/Anthropic hosts sbx terminates TLS ITSELF:
//
//   sandbox curl https://platform.claude.com → issuer: CN=Docker Sandboxes Proxy CA
//
// There the upstream leg to Huddle is dialed by the sbx daemon — a HOST process
// that validates against the HOST trust store, which does not know Huddle's CA.
// The handshake with the client succeeds (sbx signs its own leaf immediately),
// the upstream validation then fails, and the connection is closed without a
// response: `curl: (52) Empty reply from server`, and `claude` reports
// "Failed to connect to platform.claude.com: ECONNRESET".
//
// So the CA has to be trusted in TWO places: inside the sandbox (trustCa) and on
// the host (here). Idempotent — safe to call on every `huddle init`.

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { CONFIG_DIR } from './config';
import { resolveSbxBin } from './sbx-bridge';
import { dim, green, yellow } from './utils';

const CONTAINER = 'huddle';
/** Where the gateway keeps its MITM CA (CA_DIR in gateway/src/tls-ca.ts). */
const CA_IN_CONTAINER = '/data/ca.crt';
/** Stable host path, so re-running init points at the same file. */
export const HOST_CA_PATH = path.join(CONFIG_DIR, 'huddle-ca.crt');
const LINUX_CA_PATH = '/usr/local/share/ca-certificates/huddle-ca.crt';

/** No console window per child process on Windows (same reason as sbx-bridge). */
const NO_WINDOW = { windowsHide: true } as const;

export type TrustStore = 'windows-user' | 'windows-machine' | 'macos-login' | 'linux-system';

export interface TrustHostResult {
  ok: boolean;
  /** true when the CA was already present — nothing was changed. */
  alreadyTrusted: boolean;
  store?: TrustStore;
  certPath?: string;
  /** SHA-1 thumbprint, uppercase hex — what the platform stores key on. */
  fingerprint?: string;
  daemonRestarted: boolean;
  error?: string;
  /** Copy-pasteable command for the user when we could not do it ourselves. */
  manualHint?: string;
}

function run(file: string, args: string[], timeout = 30_000): { code: number; out: string } {
  try {
    const out = execFileSync(file, args, { encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'pipe'], ...NO_WINDOW });
    return { code: 0, out: out ?? '' };
  } catch (err) {
    const e = err as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer; message?: string };
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}` || e.message || '';
    return { code: typeof e.status === 'number' ? e.status : 1, out: String(out) };
  }
}

/** Blocking sleep — this runs in the CLI's synchronous init path, not in a loop. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the CA out of the running gateway. `initCa()` writes it on boot, so
 * straight after `docker run` the file can be a beat late — retry briefly.
 */
function readCaFromGateway(rt: string, tries = 12): string | null {
  for (let i = 0; i < tries; i++) {
    const r = run(rt, ['exec', CONTAINER, 'cat', CA_IN_CONTAINER], 15_000);
    if (r.code === 0 && r.out.includes('-----BEGIN CERTIFICATE-----')) return r.out;
    // Retry ONLY the race we know is transient: the gateway is up but initCa()
    // has not written the file yet. Anything else (no container, engine
    // unreachable, socket denied) will not fix itself — fail fast instead.
    const stillBooting = r.out === '' || /no such file|is restarting/i.test(r.out);
    if (!stillBooting || i === tries - 1) return null;
    sleepSync(500);
  }
  return null;
}

/** SHA-1 over the DER body of the first PEM block — the thumbprint certutil uses. */
export function certFingerprint(pem: string): string {
  const b64 = pem
    .split('-----BEGIN CERTIFICATE-----')[1]
    ?.split('-----END CERTIFICATE-----')[0]
    ?.replace(/\s+/g, '');
  if (!b64) throw new Error('not a PEM certificate');
  return crypto.createHash('sha1').update(Buffer.from(b64, 'base64')).digest('hex').toUpperCase();
}

// ── per-platform install ─────────────────────────────────────────────────────

/**
 * Is the cert in this Windows root store? Asks the STORE, never the exit code:
 * certutil's status codes are unreliable here (`-addstore` can print its success
 * banner "Signature matches Public Key" and still exit non-zero, and
 * `-verifystore` fails a chain check on a root it does happily hold). The
 * thumbprint appearing in the listing is the only honest answer.
 */
function inWindowsStore(scope: 'user' | 'machine', fp: string): boolean {
  const scoped = scope === 'user' ? ['-user'] : [];
  const has = (out: string) => out.replace(/[\s:]/g, '').toUpperCase().includes(fp);
  // Targeted lookup first; fall back to a full dump for certutil builds that
  // don't take a thumbprint as the cert-id argument.
  if (has(run('certutil', [...scoped, '-store', 'Root', fp]).out)) return true;
  return has(run('certutil', [...scoped, '-store', 'Root'], 60_000).out);
}

/** Pick the line that actually says what went wrong, not just the last one. */
function certutilError(out: string): string {
  const lines = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const blame = [...lines].reverse().find((l) => /CertUtil:|FAILED|denied|0x[0-9A-Fa-f]{8}/.test(l));
  return blame ?? lines.pop() ?? 'certutil failed';
}

function installWindows(certPath: string, fp: string): TrustHostResult {
  const manualHint = `certutil -addstore -f Root "${certPath}"   (elevated prompt)`;
  const found = (store: TrustStore, alreadyTrusted: boolean): TrustHostResult =>
    ({ ok: true, alreadyTrusted, store, certPath, fingerprint: fp, daemonRestarted: false });

  // Go (which sbx is built with) reads the CURRENT_USER "ROOT" store, which the
  // machine store is merged into — so the user store works WITHOUT elevation.
  if (inWindowsStore('user', fp)) return found('windows-user', true);
  if (inWindowsStore('machine', fp)) return found('windows-machine', true);

  const user = run('certutil', ['-user', '-addstore', '-f', 'Root', certPath]);
  if (inWindowsStore('user', fp)) return found('windows-user', false);

  // Fall back to the machine store (needs an elevated prompt; usually fails here).
  run('certutil', ['-addstore', '-f', 'Root', certPath]);
  if (inWindowsStore('machine', fp)) return found('windows-machine', false);

  return {
    ok: false, alreadyTrusted: false, certPath, fingerprint: fp, daemonRestarted: false,
    error: certutilError(user.out),
    manualHint,
  };
}

function installMacos(certPath: string, fp: string): TrustHostResult {
  const keychain = path.join(os.homedir(), 'Library/Keychains/login.keychain-db');
  const manualHint = `security add-trusted-cert -r trustRoot -k "${keychain}" "${certPath}"`;
  const found = run('security', ['find-certificate', '-a', '-Z', keychain]);
  if (found.code === 0 && found.out.toUpperCase().includes(fp)) {
    return { ok: true, alreadyTrusted: true, store: 'macos-login', certPath, fingerprint: fp, daemonRestarted: false };
  }
  // No -d: the login keychain needs no sudo (it may raise a GUI confirmation).
  const add = run('security', ['add-trusted-cert', '-r', 'trustRoot', '-k', keychain, certPath], 60_000);
  if (add.code === 0) {
    return { ok: true, alreadyTrusted: false, store: 'macos-login', certPath, fingerprint: fp, daemonRestarted: false };
  }
  return { ok: false, alreadyTrusted: false, certPath, fingerprint: fp, daemonRestarted: false, error: add.out.trim(), manualHint };
}

function installLinux(certPath: string, pem: string, fp: string): TrustHostResult {
  const manualHint = `sudo cp "${certPath}" ${LINUX_CA_PATH} && sudo update-ca-certificates`;
  try {
    if (fs.readFileSync(LINUX_CA_PATH, 'utf8').trim() === pem.trim()) {
      return { ok: true, alreadyTrusted: true, store: 'linux-system', certPath, fingerprint: fp, daemonRestarted: false };
    }
  } catch { /* not installed yet */ }
  const copy = run('sh', ['-c', `cp ${JSON.stringify(certPath)} ${LINUX_CA_PATH} 2>/dev/null || (command -v sudo >/dev/null 2>&1 && sudo -n cp ${JSON.stringify(certPath)} ${LINUX_CA_PATH})`]);
  if (copy.code !== 0) {
    return { ok: false, alreadyTrusted: false, certPath, fingerprint: fp, daemonRestarted: false, error: 'need root to write ' + LINUX_CA_PATH, manualHint };
  }
  run('sh', ['-c', 'command -v update-ca-certificates >/dev/null 2>&1 && (update-ca-certificates >/dev/null 2>&1 || sudo -n update-ca-certificates >/dev/null 2>&1) || true'], 60_000);
  return { ok: true, alreadyTrusted: false, store: 'linux-system', certPath, fingerprint: fp, daemonRestarted: false };
}

/**
 * Export Huddle's CA from the gateway and trust it on the HOST, then restart the
 * sbx daemon so it reloads its root set. Never throws — sandbox mode is optional
 * and this must never fail `huddle init`.
 */
export function installHostCa(opts: { runtime?: string; restartDaemon?: 'auto' | 'always' | 'never' } = {}): TrustHostResult {
  const rt = opts.runtime ?? process.env.HUDDLE_RUNTIME?.trim() ?? 'docker';
  const pem = readCaFromGateway(rt);
  if (!pem) {
    return {
      ok: false, alreadyTrusted: false, daemonRestarted: false,
      error: `could not read ${CA_IN_CONTAINER} from the '${CONTAINER}' container`,
      manualHint: `${rt} cp ${CONTAINER}:${CA_IN_CONTAINER} "${HOST_CA_PATH}"`,
    };
  }

  let fp: string;
  try { fp = certFingerprint(pem); } catch (err) {
    return { ok: false, alreadyTrusted: false, daemonRestarted: false, error: (err as Error).message };
  }

  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(HOST_CA_PATH, pem, { mode: 0o644 });
  } catch (err) {
    return { ok: false, alreadyTrusted: false, fingerprint: fp, daemonRestarted: false, error: (err as Error).message };
  }

  let result: TrustHostResult;
  if (process.platform === 'win32') result = installWindows(HOST_CA_PATH, fp);
  else if (process.platform === 'darwin') result = installMacos(HOST_CA_PATH, fp);
  else result = installLinux(HOST_CA_PATH, pem, fp);

  // A freshly added root is only picked up by a running daemon after a restart.
  // 'always' is for the explicit `huddle sbx trust-host`: you only type that when
  // something is broken, and a store that was filled by an earlier run (before
  // any restart) must not be silently skipped as "already trusted".
  const mode = opts.restartDaemon ?? 'auto';
  if (result.ok && mode !== 'never' && (mode === 'always' || !result.alreadyTrusted)) {
    result.daemonRestarted = run(resolveSbxBin(), ['daemon', 'restart'], 120_000).code === 0;
  }
  return result;
}

/** Human-readable one-liner + guidance. Shared by `huddle init` and `huddle sbx trust-host`. */
export function printHostCaResult(r: TrustHostResult, indent = '  '): void {
  if (r.ok && r.alreadyTrusted) {
    console.log(dim(`${indent}Huddle CA already trusted on the host (${r.store}) — sbx can reach Huddle over TLS.`));
    if (r.daemonRestarted) console.log(dim(`${indent}  sbx daemon restarted so it re-reads the root store.`));
    return;
  }
  if (r.ok) {
    console.log(green(`${indent}[OK] Huddle CA trusted on the host (${r.store})`));
    console.log(dim(`${indent}  ${r.certPath}  ·  SHA-1 ${r.fingerprint}`));
    console.log(dim(`${indent}  ${r.daemonRestarted ? 'sbx daemon restarted' : 'restart the sbx daemon to pick it up: sbx daemon restart'}`));
    return;
  }
  console.log(yellow(`${indent}Could not trust Huddle's CA on the host: ${r.error}`));
  console.log(dim(`${indent}  Without it, sbx cannot validate Huddle for the hosts it MITMs itself`));
  console.log(dim(`${indent}  (e.g. platform.claude.com) — those requests die as "Empty reply from server".`));
  if (r.manualHint) console.log(dim(`${indent}  Do it manually:  ${r.manualHint}`));
  if (r.certPath) console.log(dim(`${indent}  Then:            sbx daemon restart`));
}
