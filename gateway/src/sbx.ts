// ── Docker Sandboxes (sbx) — Huddle Node facade ───────────────────────────────
// sbx is a HOST binary. Huddle Node runs on the host and execs it directly; see
// gateway/src/sandbox/ops.ts for the passthrough and for what happens when this
// process is NOT on the host.
//
// This used to go through a file mailbox: the gateway container had a shim named
// `sbx` on its PATH that wrote argv into a bind-mounted folder for a watcher on
// Windows to pick up. The domain logic here never knew about it — it just exec'd
// a binary — which is exactly why removing the bridge (step 5 of
// docs/ADR-huddle-node-split.md) touched the comments and not the flow.

import * as ops from './sandbox/ops';
import { reconcile, type ReconcileReport } from './sandbox/reconcile';
import type { SandboxInfo } from './sandbox/protocol';
import { getCaCertPem } from './tls-ca';
import { runtimeEnv } from './runtime-env';

export { reconcile };
export type { ReconcileReport };

// Dedicated port Huddle opens for sbx egress (kept separate from the devcontainer
// proxy on :80). The host sbx daemon is pointed here as its upstream proxy.
export const SBX_PROXY_PORT = runtimeEnv.sbxProxyPort;
const SBX_PROXY_HOST = process.env.HUDDLE_SBX_PROXY_HOST ?? 'localhost';
const SBX_AGENT = process.env.HUDDLE_SBX_AGENT ?? 'claude';
const DEFAULT_WORKSPACE = process.env.HUDDLE_SBX_WORKSPACE ?? '.';
/** The URL Huddle hands to sbx as its upstream proxy (reached on the host). */
export function sbxUpstreamUrl(): string {
  return `http://${SBX_PROXY_HOST}:${SBX_PROXY_PORT}`;
}

export interface SbxStep {
  label: string;
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SbxStartResult {
  ok: boolean;
  upstreamUrl: string;
  proxyPort: number;
  steps: SbxStep[];
}

const CAP = 8 * 1024;
function cap(s: string): string {
  return s.length > CAP ? s.slice(0, CAP) + '\n…[truncated]' : s;
}

/**
 * `sbx version` — tells the portal exactly which wall we're at:
 *   - not on the host   → available:false, error says so (sbxUnavailableReason)
 *   - sbx not installed → available:false, error is sbx's own
 *   - usable            → available:true, version populated
 * `bin` is the binary that would be run, or null when this process cannot run it.
 */
export async function sbxAvailable(): Promise<{ available: boolean; version: string; error?: string; bin: string | null }> {
  const blocked = ops.sbxUnavailableReason();
  if (blocked) return { available: false, version: '', error: blocked, bin: null };
  try {
    const version = await ops.version();
    return { available: true, version: version.trim() || 'unknown', bin: ops.SBX_BIN };
  } catch (err) {
    return { available: false, version: '', error: (err as Error).message, bin: ops.SBX_BIN };
  }
}

/**
 * Start an sbx sandbox with Huddle as its upstream proxy: (1) point the upstream
 * proxy at Huddle, (2) create the sandbox. Returns per-step output so the portal
 * shows exactly which command broke.
 */
export async function startSandbox(opts: { name: string; agent?: string; workspace?: string }): Promise<SbxStartResult> {
  const upstreamUrl = sbxUpstreamUrl();
  const agentName = opts.agent || SBX_AGENT;
  const workspace = opts.workspace || DEFAULT_WORKSPACE;
  const steps: SbxStep[] = [];

  try {
    await ops.setProxy({ which: 'sandbox', url: upstreamUrl });
    steps.push({ label: 'set sandbox upstream proxy → Huddle', command: `sbx settings set proxy.sandbox ${upstreamUrl}`, code: 0, stdout: '', stderr: '' });
  } catch (err) {
    steps.push({ label: 'set sandbox upstream proxy → Huddle', command: `sbx settings set proxy.sandbox ${upstreamUrl}`, code: 1, stdout: '', stderr: cap((err as Error).message) });
    return { ok: false, upstreamUrl, proxyPort: SBX_PROXY_PORT, steps };
  }

  let out = '';
  let errOut = '';
  const command = `sbx create --name ${opts.name} ${agentName} ${workspace}`;
  try {
    const code = await ops.create({ name: opts.name, agent: agentName, path: workspace }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
      else errOut = cap(errOut + d);
    });
    steps.push({ label: 'create sandbox', command, code, stdout: out, stderr: errOut });
    if (code !== 0) return { ok: false, upstreamUrl, proxyPort: SBX_PROXY_PORT, steps };
    // Trust Huddle's MITM CA inside the sandbox so HTTPS works (IDE downloads etc.).
    steps.push(await trustCa(opts.name));
    return { ok: steps.every((s) => s.code === 0), upstreamUrl, proxyPort: SBX_PROXY_PORT, steps };
  } catch (err) {
    steps.push({ label: 'create sandbox', command, code: 1, stdout: out, stderr: cap(errOut || (err as Error).message) });
    return { ok: false, upstreamUrl, proxyPort: SBX_PROXY_PORT, steps };
  }
}

/**
 * Install Huddle's CA into a sandbox so TLS through Huddle's MITM proxy is
 * trusted — otherwise every HTTPS from inside the sandbox fails with
 * "unable to get local issuer certificate" (e.g. JetBrains Gateway downloading
 * its backend with curl). Same approach Huddle uses for devcontainers: drop the
 * CA into /usr/local/share/ca-certificates and run update-ca-certificates.
 *
 * IMPORTANT: the script is a SINGLE LINE (no embedded newlines) because the file
 * mailbox passes argv one-per-line — a multi-line arg would be split. The base64
 * CA is newline-free; `\n` in the script is escaped, not a real newline.
 */
function caInstallCommand(): string[] {
  const b64 = Buffer.from(getCaCertPem(), 'utf8').toString('base64');
  const SYS = '/usr/local/share/ca-certificates/huddle-ca.crt';
  // ONE LINE only (the mailbox splits args on newlines): `\n` below are escaped
  // and become real newlines only when printf runs INSIDE the sandbox.
  //   1) decode the CA to /tmp
  //   2) if passwordless sudo → install into the SYSTEM trust store (best; fixes
  //      curl/git/node for every user)
  //   3) elif we can write the system dir ourselves → same, no sudo
  //   4) else USER fallback: build a personal CA bundle and export CURL_CA_BUNDLE
  //      / NODE_EXTRA_CA_CERTS / GIT_SSL_CAINFO / REQUESTS_CA_BUNDLE in the login
  //      profiles that `bash -lc` sources (JetBrains/VS Code run commands that way).
  const script =
    `printf '%s' '${b64}' | base64 -d > /tmp/huddle-ca.crt` +
    `; if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then ` +
    `sudo mkdir -p /usr/local/share/ca-certificates && sudo cp /tmp/huddle-ca.crt ${SYS} && sudo chmod 644 ${SYS} && (sudo update-ca-certificates >/dev/null 2>&1 || true) && echo HUDDLE_CA_INSTALLED_SYSTEM` +
    `; elif mkdir -p /usr/local/share/ca-certificates 2>/dev/null && cp /tmp/huddle-ca.crt ${SYS} 2>/dev/null; then ` +
    `(command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true) && echo HUDDLE_CA_INSTALLED_SYSTEM` +
    `; else ` +
    `D="$HOME/.config/huddle"; mkdir -p "$D"; cp /tmp/huddle-ca.crt "$D/huddle-ca.crt"; ` +
    `{ [ -f /etc/ssl/certs/ca-certificates.crt ] && cat /etc/ssl/certs/ca-certificates.crt; cat "$D/huddle-ca.crt"; } > "$D/ca-bundle.crt"; ` +
    `for f in "$HOME/.bash_profile" "$HOME/.profile" "$HOME/.bashrc"; do grep -q HUDDLE_CA_ENV "$f" 2>/dev/null || printf '# HUDDLE_CA_ENV\\nexport CURL_CA_BUNDLE=%s\\nexport NODE_EXTRA_CA_CERTS=%s\\nexport GIT_SSL_CAINFO=%s\\nexport REQUESTS_CA_BUNDLE=%s\\n' "$D/ca-bundle.crt" "$D/huddle-ca.crt" "$D/ca-bundle.crt" "$D/ca-bundle.crt" >> "$f"; done; ` +
    `echo HUDDLE_CA_INSTALLED_USER` +
    `; fi`;
  return ['sh', '-c', script];
}

/** Push Huddle's CA into a sandbox and refresh the trust store. */
export async function trustCa(name: string): Promise<SbxStep> {
  let out = '';
  let errOut = '';
  const command = `sbx exec ${name} -- sh -c '…install Huddle CA + update-ca-certificates…'`;
  try {
    const code = await ops.exec({ name, cmd: caInstallCommand() }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
      else errOut = cap(errOut + d);
    });
    return { label: 'install Huddle CA in sandbox (TLS trust)', command, code, stdout: out, stderr: errOut };
  } catch (err) {
    return { label: 'install Huddle CA in sandbox (TLS trust)', command, code: 1, stdout: out, stderr: cap(errOut || (err as Error).message) };
  }
}

export async function listSandboxes(): Promise<SandboxInfo[]> {
  return ops.list();
}

/** Raw `sbx policy log --json` for a sandbox + the denied entries we parse out. */
export async function policyLogFor(name: string): Promise<{ raw: string; denied: ops.DeniedEntry[] }> {
  const raw = await ops.policyLog({ kind: 'sandbox', name });
  return { raw, denied: ops.parsePolicyLogJson(raw) };
}

export async function removeSandbox(name: string, force = false): Promise<number> {
  return ops.remove({ name, force });
}

export async function sshSetup(): Promise<number> {
  return ops.sshSetup();
}
