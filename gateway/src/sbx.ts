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
import type { SandboxInfo, WorkspaceSpec } from './sandbox/protocol';
import { normalizeWorkspacePath, workspaceArg } from './sandbox/protocol';
import {
  planSettingsFolders,
  mergeSandboxWorkspaces,
  buildSettingsFolderScript,
  type SandboxSettingsPlan,
} from './sandbox/settings-folders';
import { listFolderMappings } from './host-config';
import { getCaCertPem } from './tls-ca';
import { dropSandboxIdentity, mintSandboxIdentity } from './sandbox/registry';
import { UNCLAIMED_SANDBOX, mintSandboxSecret, redactProxyUrl, sandboxProxyUrl } from './sbx-identity';

export { reconcile };
export type { ReconcileReport };

import { SBX_PROXY_PORT, sbxUpstreamUrl } from './sbx-upstream';
export { SBX_PROXY_PORT, sbxUpstreamUrl };
const SBX_AGENT = process.env.HUDDLE_SBX_AGENT ?? 'claude';
const DEFAULT_WORKSPACE = process.env.HUDDLE_SBX_WORKSPACE ?? '.';
export interface SbxStep {
  label: string;
  command: string;
  code: number;
  stdout: string;
  stderr: string;
}

export interface SbxStartResult {
  ok: boolean;
  /** REDACTED: the upstream proxy carries the sandbox' secret and this is shown. */
  upstreamUrl: string;
  proxyPort: number;
  steps: SbxStep[];
  /** The folders the sandbox was created with (primary first), for the portal. */
  workspaces?: { path: string; readOnly: boolean }[];
  /** Which settings folders (folder mappings) travelled along, and which did not. */
  settingsFolders?: { name: string; hostPath: string; targetPath: string; readOnly: boolean }[];
  settingsSkipped?: { name: string; reason: string }[];
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
 * The folders a sandbox is created with: every folder the caller asked for, plus
 * Huddle's settings folders (folder mappings) so a sandbox is equipped like a
 * devcontainer. The first entry is the primary workspace (the folder the agent
 * starts in); the rest become extra `sbx create` positionals.
 */
function resolveWorkspaces(opts: { workspace?: string; workspaces?: WorkspaceSpec[] }): {
  primary: WorkspaceSpec;
  extras: WorkspaceSpec[];
  settings: SandboxSettingsPlan;
} {
  // Folder mappings are the same source of truth devcontainers mount from; a
  // missing/unreadable config must never block a sandbox, hence the guard.
  let settings: SandboxSettingsPlan = { folders: [], skipped: [] };
  try {
    settings = planSettingsFolders(listFolderMappings());
  } catch (err) {
    settings = { folders: [], skipped: [{ name: 'folder mappings', reason: (err as Error).message }] };
  }
  const { primary, extras } = mergeSandboxWorkspaces(opts.workspaces ?? [], settings, opts.workspace || DEFAULT_WORKSPACE);
  return { primary, extras, settings };
}

/**
 * `sbx settings set proxy.sandbox <url>` as a step.
 *
 * The real URL goes to sbx and nowhere else; the step carries the redacted one,
 * because the portal and the CLI print `command` verbatim so an operator can see
 * which command broke (docs/ADR-sbx-identity.md, section 5).
 */
async function setSandboxProxy(label: string, url: string): Promise<SbxStep> {
  const command = `sbx settings set proxy.sandbox ${redactProxyUrl(url)}`;
  try {
    await ops.setProxy({ which: 'sandbox', url });
    return { label, command, code: 0, stdout: '', stderr: '' };
  } catch (err) {
    return { label, command, code: 1, stdout: '', stderr: cap((err as Error).message) };
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A transient failure of the park-to-unclaimed step is the whole threat model
// here: the global setting is left on a just-created sandbox's REAL credential,
// so this is worth a few retries before we give up and fail closed.
const PARK_UNCLAIMED_ATTEMPTS = 3;
const PARK_UNCLAIMED_RETRY_DELAY_MS = 200;

/**
 * `setSandboxProxy` for the unclaimed park, retried: the step it wraps is not
 * "did the sandbox start" but "is the global credential still safe to leave
 * lying around", and giving up after one transient failure would defeat the
 * whole point of parking it (see the call site).
 */
async function parkUnclaimedProxy(): Promise<SbxStep> {
  let step: SbxStep;
  for (let attempt = 1; attempt <= PARK_UNCLAIMED_ATTEMPTS; attempt++) {
    step = await setSandboxProxy(
      'reset sandbox upstream proxy → unclaimed',
      sandboxProxyUrl(sbxUpstreamUrl(), UNCLAIMED_SANDBOX, mintSandboxSecret())
    );
    if (step.code === 0) return step;
    if (attempt < PARK_UNCLAIMED_ATTEMPTS) await sleep(PARK_UNCLAIMED_RETRY_DELAY_MS);
  }
  return step!;
}

export interface SbxStartOpts {
  name: string;
  agent?: string;
  workspace?: string;
  workspaces?: WorkspaceSpec[];
}

/** Serialises starts; see startSandbox. */
let startQueue: Promise<unknown> = Promise.resolve();

/**
 * Start an sbx sandbox with Huddle as its upstream proxy: (1) point the upstream
 * proxy at Huddle, with this box's own credential in the URL, (2) create the
 * sandbox with every requested folder plus the settings folders — which is where
 * sbx bakes that URL in — (3) park the global setting on a credential that maps
 * to no sandbox, (4) trust Huddle's CA, (5) link the settings folders where the
 * agent looks for them. Returns per-step output so the portal shows exactly
 * which command broke.
 *
 * Serialised: `proxy.sandbox` is ONE global setting and this is set-then-create,
 * so two starts in flight can hand both boxes the same identity or swap them.
 * The lock spans the whole sequence, from the `settings set` to the reset.
 */
export function startSandbox(opts: SbxStartOpts): Promise<SbxStartResult> {
  const next = startQueue.then(() => startSandboxExclusive(opts));
  // Swallowed, or one failed start wedges every start after it.
  startQueue = next.then(() => {}, () => {});
  return next;
}

async function startSandboxExclusive(opts: SbxStartOpts): Promise<SbxStartResult> {
  const agentName = opts.agent || SBX_AGENT;
  const { primary, extras, settings } = resolveWorkspaces(opts);
  const workspace = primary.path;
  const steps: SbxStep[] = [];
  const info = {
    workspaces: [primary, ...extras].map((w) => ({ path: normalizeWorkspacePath(w.path), readOnly: w.readOnly === true })),
    settingsFolders: settings.folders.map((f) => ({ name: f.name, hostPath: f.hostPath, targetPath: f.targetPath, readOnly: f.readOnly })),
    settingsSkipped: settings.skipped,
  };

  // A create always mints a FRESH secret: reusing one would make two boxes a
  // single identity wearing two names.
  const identity = mintSandboxIdentity(opts.name);
  const credentialedUrl = sandboxProxyUrl(sbxUpstreamUrl(), opts.name, identity.secret);
  // What every caller and every log gets to see instead.
  const upstreamUrl = redactProxyUrl(credentialedUrl);
  const result = (ok: boolean): SbxStartResult => ({ ok, upstreamUrl, proxyPort: SBX_PROXY_PORT, steps, ...info });

  const setStep = await setSandboxProxy('set sandbox upstream proxy → Huddle', credentialedUrl);
  steps.push(setStep);
  if (setStep.code !== 0) {
    dropSandboxIdentity(opts.name);
    return result(false);
  }

  let out = '';
  let errOut = '';
  // Every extra folder is one more positional: `sbx create AGENT PATH [PATH...]`,
  // `:ro` for a read-only one.
  const pathArgs = [normalizeWorkspacePath(workspace), ...extras.map((w) => workspaceArg(w))].join(' ');
  const command = `sbx create --name ${opts.name} ${agentName} ${pathArgs}`;
  let created = false;
  try {
    const code = await ops.create({ name: opts.name, agent: agentName, path: workspace, extraPaths: extras }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
      else errOut = cap(errOut + d);
    });
    steps.push({ label: `create sandbox (${info.workspaces.length} folder(s))`, command, code, stdout: out, stderr: errOut });
    created = code === 0;
  } catch (err) {
    steps.push({ label: 'create sandbox', command, code: 1, stdout: out, stderr: cap(errOut || (err as Error).message) });
  }

  // The credential is baked in now, so the global setting has done its job and
  // is only a liability: a restart path we have not exercised that re-reads it
  // would come back holding THIS box's identity. Park it on a credential that
  // maps to no sandbox — denied by name beats impersonating the last box
  // created (docs/ADR-sbx-identity.md, section 4).
  const parkStep = await parkUnclaimedProxy();
  steps.push(parkStep);

  if (parkStep.code !== 0) {
    // Retries (parkUnclaimedProxy) exhausted: the global setting is STILL this
    // box's real bearer credential and the identity row is still live. Pressing
    // on to trustCa/linkSettingsFolders as if nothing happened would leave a
    // sandbox created or restarted from the host free to inherit it and be
    // evaluated as THIS box — merging both boxes' policy and audit scopes,
    // exactly the impersonation the park step exists to prevent. Fail closed
    // instead: stop here so a caller cannot mistake this for an ordinary failed
    // step buried among otherwise-green ones.
    console.error(
      `[sbx] failed to park proxy.sandbox off "${opts.name}" after ${PARK_UNCLAIMED_ATTEMPTS} attempts — ` +
      'the global upstream-proxy credential is still this sandbox\'s real secret'
    );
    // A box that never created keeps no identity either way; one that DID
    // create must keep its row — it is the credential the running box itself
    // now authenticates with, and dropping it would just orphan a live secret.
    if (!created) dropSandboxIdentity(opts.name);
    return result(false);
  }

  if (!created) {
    // No box, so no identity — leaving the row would leave a live secret behind.
    dropSandboxIdentity(opts.name);
    return result(false);
  }
  // Trust Huddle's MITM CA inside the sandbox so HTTPS works (IDE downloads etc.).
  steps.push(await trustCa(opts.name));
  // Link the settings folders where the agent looks for them (~/.claude etc.).
  const linkStep = await linkSettingsFolders(opts.name, settings);
  if (linkStep) steps.push(linkStep);
  return result(steps.every((s) => s.code === 0));
}

/**
 * Link Huddle's settings folders (mounted by `sbx create` at their host path) to
 * the path the agent reads them from. Returns null when there is nothing to do,
 * so a plain sandbox keeps the exact same step list as before. Skipped mappings
 * are reported in the step output — a mapping that silently doesn't arrive is the
 * failure mode we want visible.
 */
export async function linkSettingsFolders(name: string, plan: SandboxSettingsPlan): Promise<SbxStep | null> {
  const notes = plan.skipped.map((s) => `huddle-settings: NOT MOUNTED ${s.name} — ${s.reason}`).join('\n');
  if (plan.folders.length === 0) {
    if (!notes) return null;
    return { label: 'mount settings folders', command: '(nothing to link)', code: 0, stdout: notes, stderr: '' };
  }
  const script = buildSettingsFolderScript(plan.folders);
  const command = `sbx exec ${name} -- sh -c '…link ${plan.folders.length} settings folder(s)…'`;
  let out = '';
  let errOut = '';
  try {
    const code = await ops.exec({ name, cmd: ['sh', '-c', script] }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
      else errOut = cap(errOut + d);
    });
    return { label: `link settings folders (${plan.folders.length})`, command, code, stdout: cap(notes ? `${notes}\n${out}` : out), stderr: errOut };
  } catch (err) {
    return { label: `link settings folders (${plan.folders.length})`, command, code: 1, stdout: cap(notes ? `${notes}\n${out}` : out), stderr: cap(errOut || (err as Error).message) };
  }
}

/** The settings-folder plan for the CURRENT folder mappings (portal/CLI preview). */
export function settingsFolderPlan(): SandboxSettingsPlan {
  return planSettingsFolders(listFolderMappings());
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
  const code = await ops.remove({ name, force });
  // Drop the identity NO MATTER what `sbx rm` returned. A sandbox does not
  // outlive its credential — there is no rotation beyond this — and a failed
  // `rm` is exactly the case where we cannot tell whether the box is still
  // intact or half torn down: the credential is the only thing the gateway
  // checks (identifySandbox → resolveSandboxBySecret), so gating the drop on
  // `code === 0` leaves that row, and the ability to pass for this "removed"
  // sandbox, live until someone retries. Fail closed instead — a box that is
  // truly still there just re-mints its row the next time Huddle (re)creates
  // or otherwise re-identifies it; one that isn't leaves no secret behind.
  dropSandboxIdentity(name);
  return code;
}

export async function sshSetup(): Promise<number> {
  return ops.sshSetup();
}
