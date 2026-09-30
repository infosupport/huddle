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

import { exec as execCb } from 'child_process';
import { promisify } from 'util';
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
import { provisionSshAccess, getSshAccess, dropSshAccess, recordSshIdentity } from './ssh-keys';
import { UNCLAIMED_SANDBOX, mintSandboxSecret, redactProxyUrl, sandboxProxyUrl } from './sbx-identity';
import { probeSshBannerWithRetry } from './ssh-probe';
// Reused verbatim from the devcontainer path so a hand-typed env key/lifecycle
// command is validated and rendered identically in both runtimes — see
// docs/ADR-workspace-runtime-abstraction.md on keeping the devcontainer.json
// shape (env/lifecycle/customizations) common across container and sbx.
import { filterUserEnv, shQuote, type LifecycleCommands, type IdeName } from './docker';
import { readDevcontainerScript } from './devcontainer-scripts';

const execHostCommand = promisify(execCb);

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
  /** containerEnv/remoteEnv keys dropped for colliding with a Huddle-owned name — see filterUserEnv (docker.ts). */
  ignoredEnv?: string[];
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
  // devcontainer.json-shaped settings, same fields as StartParams (docker.ts) —
  // the create modal's right column is shared between kinds (§ADR-workspace-
  // runtime-abstraction), so a sandbox accepts the same shape a devcontainer
  // does. Applied best-effort inside the microVM; see startSandboxExclusive.
  containerEnv?: Record<string, string>;
  remoteEnv?: Record<string, string>;
  jbPlugins?: string[];
  jbSettings?: Record<string, unknown>;
  lifecycle?: LifecycleCommands;
}

/**
 * sbx has no `su vscode -c` equivalent — a sandbox execs as `agent` (uid 1000,
 * in the `sudo` group), not a picker of users the way a devcontainer's
 * `remoteUser` is, so, unlike buildLifecycleStep in docker.ts, the command
 * runs directly. Otherwise identical: best-effort, a failing command is
 * logged to stderr and swallowed rather than failing the step (and therefore
 * never fails the overall `ok`).
 */
function buildSbxLifecycleStep(label: string, command: string | undefined, workspace: string): string {
  const cmd = (command ?? '').trim();
  if (!cmd) return '';
  const inner = `cd ${shQuote(workspace)} 2>/dev/null; ${cmd}`;
  return `sh -c ${shQuote(inner)} || echo "[huddle] lifecycle:${label} exited non-zero" >&2`;
}

/**
 * containerEnv/remoteEnv, merged: a sandbox has no separate "baked into the
 * image" vs. "injected on attach" moment the way a container's create vs. exec
 * does (there is no image build step here at all), so both scopes land in the
 * same login-shell profile script — remoteEnv wins on a key collision since it
 * is the more specific ask. Mirrors buildRemoteEnvScript's heredoc idiom.
 */
function buildSbxEnvScript(entries: [string, string][]): string {
  if (entries.length === 0) return '';
  const lines = entries.map(([k, v]) => `export ${k}=${shQuote(v)}`).join('\n');
  return `cat <<'HUDDLE_SBX_ENV_EOF' > /etc/profile.d/95-huddle-env.sh
${lines}
HUDDLE_SBX_ENV_EOF
chmod 644 /etc/profile.d/95-huddle-env.sh`;
}

/**
 * customizations.jetbrains, recorded but not applied: a bare Docker Sandbox
 * has no JetBrains backend process to install plugins into or hand settings
 * to (ADR-workspace-runtime-abstraction §6 Phase 1 item 4 — "validate
 * JetBrains Gateway / VS Code attach" — is still open). Writing the same
 * shape docker.ts's buildJbConfigScript uses means a future Gateway attach
 * finds it already in place instead of this being a second migration later.
 */
function buildSbxJbConfigScript(plugins: string[], settings: Record<string, unknown> | undefined): string {
  if (plugins.length === 0 && (!settings || Object.keys(settings).length === 0)) return '';
  const payload = shQuote(JSON.stringify({ plugins, settings: settings ?? {} }));
  return `mkdir -p /.jbdevcontainer/config/JetBrains && printf '%s' ${payload} > /.jbdevcontainer/config/JetBrains/huddle-customizations.json`;
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
  // Resume vs create: sbx has no `start`/`restart` verb (docs/ADR-sbx-identity.md
  // §4, measured 2026-08-30) — a stopped sandbox "returns when someone next uses
  // it", and the proxy identity baked in at create survives a stop untouched (it
  // is never re-read from the global setting). A name `ops.list()` already knows
  // about is therefore a RESUME, not a create: re-running `ops.create` or
  // re-minting identity/SSH access would be redundant at best (sbx has no
  // create-on-existing semantics to lean on) and would desync Huddle's DB from
  // the credential/key actually already live on the box. Only what does NOT
  // survive a stop (the sshd process, the host-side port publish) needs action —
  // see resumeSandboxExclusive, which mirrors docker.ts's startExistingContainer.
  let existing: SandboxInfo | undefined;
  try {
    existing = (await ops.list()).find((s) => s.name === opts.name);
  } catch {
    // `sbx ls` failing is not proof of absence — fall through to the create path
    // below rather than risk re-creating (and re-minting the identity of) a
    // sandbox that may still be alive.
  }
  if (existing) return resumeSandboxExclusive(opts.name, opts.lifecycle);

  const agentName = opts.agent || SBX_AGENT;
  const { primary, extras, settings } = resolveWorkspaces(opts);
  const workspace = primary.path;
  const steps: SbxStep[] = [];
  const info = {
    workspaces: [primary, ...extras].map((w) => ({ path: normalizeWorkspacePath(w.path), readOnly: w.readOnly === true })),
    settingsFolders: settings.folders.map((f) => ({ name: f.name, hostPath: f.hostPath, targetPath: f.targetPath, readOnly: f.readOnly })),
    settingsSkipped: settings.skipped,
  };

  // initializeCommand (devcontainer.json semantics): runs on the HOST, before
  // the sbx proxy setting, identity, or sandbox exist — mirrors docker.ts's
  // createAndStartContainer placement exactly, including "failing here aborts
  // outright" (nothing to roll back yet, unlike a reserved-env-name warning).
  const initializeCommand = opts.lifecycle?.initializeCommand?.trim();
  if (initializeCommand) {
    const command = `(host) ${initializeCommand}`;
    try {
      await execHostCommand(initializeCommand, { cwd: workspace || undefined, timeout: 5 * 60 * 1000 });
      steps.push({ label: 'initializeCommand (host)', command, code: 0, stdout: '', stderr: '' });
    } catch (err: any) {
      const stderr = typeof err?.stderr === 'string' ? err.stderr : '';
      const stdout = typeof err?.stdout === 'string' ? err.stdout : '';
      steps.push({
        label: 'initializeCommand (host)', command,
        code: typeof err?.code === 'number' ? err.code : 1,
        stdout: cap(stdout), stderr: cap(stderr || (err as Error).message),
      });
      return { ok: false, upstreamUrl: '', proxyPort: SBX_PROXY_PORT, steps, ...info };
    }
  }

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

  // SSH access (Stage 2): mint a keypair + fixed host port, bootstrap sshd
  // inside the sandbox, then publish that host port to the sandbox's :22 so
  // it's actually reachable. Docker Sandboxes' own `sbx setup ssh` /
  // `ssh <name>.sbx` (host-local ssh_config generation, authenticated over
  // the daemon's Unix socket) is a separate, redundant path onto the same
  // box — removed from Huddle rather than kept alongside this one, since it
  // duplicated this mechanism without adding anything the JetBrains link or
  // `huddle sbx ssh-setup` need.
  const sshAccess = provisionSshAccess(opts.name, 'sbx');
  steps.push(await bootstrapSsh(opts.name, sshAccess.publicKey));
  const publishStep = await publishSshPort(opts.name, sshAccess.port);
  steps.push(publishStep);
  // Only probe a port that was actually published — otherwise the publish
  // failure is the error worth reporting and the probe just doubles it.
  if (publishStep.code === 0) steps.push(await verifySshReachable(sshAccess.port));

  // JetBrains backend install (background) — see ideInstallScript's doc comment.
  steps.push(await runInSandbox(opts.name, 'install JetBrains IDE backend (background)', ideInstallScript(sshAccess.port)));

  // Link the settings folders where the agent looks for them (~/.claude etc.).
  const linkStep = await linkSettingsFolders(opts.name, settings);
  if (linkStep) steps.push(linkStep);

  // ── devcontainer.json-shaped settings — same fields the container path
  // accepts, applied best-effort inside the microVM (§ADR-workspace-runtime-
  // abstraction: the create modal's right column is shared across kinds). ──
  const containerEnvFilter = filterUserEnv(opts.containerEnv);
  const remoteEnvFilter = filterUserEnv(opts.remoteEnv);
  const ignoredEnv = [...containerEnvFilter.ignored, ...remoteEnvFilter.ignored];
  // No create-vs-attach moment to tell containerEnv and remoteEnv apart inside
  // a sandbox (there is no image build step at all) — merge into one profile
  // script; remoteEnv wins a collision as the more specific of the two asks.
  const mergedEnv = new Map(containerEnvFilter.applied);
  for (const [k, v] of remoteEnvFilter.applied) mergedEnv.set(k, v);
  const envScript = buildSbxEnvScript([...mergedEnv.entries()]);
  if (envScript) steps.push(await runInSandbox(opts.name, 'apply environment variables', envScript));

  const lifecycleScript = [
    buildSbxLifecycleStep('onCreate', opts.lifecycle?.onCreateCommand, workspace),
    // updateContentCommand has no real trigger on a just-created sandbox any
    // more than it does for a container — approximated as "runs once at
    // create", the same call docker.ts makes for the same reason.
    buildSbxLifecycleStep('updateContent', opts.lifecycle?.updateContentCommand, workspace),
    buildSbxLifecycleStep('postCreate', opts.lifecycle?.postCreateCommand, workspace),
    buildSbxLifecycleStep('postStart', opts.lifecycle?.postStartCommand, workspace),
    // postAttachCommand: docker.ts polls for an IDE backend process to
    // approximate "on attach" (buildPostAttachWatcher) — a bare sandbox has no
    // such process to watch for yet (ADR-workspace-runtime-abstraction §6
    // Phase 1 item 4), so this runs once here instead of pretending to
    // observe an attach event that cannot happen.
    buildSbxLifecycleStep('postAttach', opts.lifecycle?.postAttachCommand, workspace),
  ].filter(Boolean).join('\n');
  if (lifecycleScript) steps.push(await runInSandbox(opts.name, 'run lifecycle commands', lifecycleScript));

  const jbScript = buildSbxJbConfigScript(
    (opts.jbPlugins ?? []).map((p) => p.trim()).filter(Boolean),
    opts.jbSettings
  );
  if (jbScript) steps.push(await runInSandbox(opts.name, 'record JetBrains customizations', jbScript));

  return { ...result(steps.every((s) => s.code === 0)), ignoredEnv: ignoredEnv.length ? ignoredEnv : undefined };
}

/**
 * Resume a sandbox `ops.list()` already knows about (see the branch at the top
 * of startSandboxExclusive). Deliberately does NOT call `mintSandboxIdentity` or
 * `ops.create` — per docs/ADR-sbx-identity.md §4, the box's proxy credential
 * survives a stop untouched, and sbx has no create-on-existing/restart verb to
 * invoke. Mirrors docker.ts's startExistingContainer: SSH access is fetched
 * read-only rather than re-minted, and only what does NOT survive a stop is
 * re-run (the sshd process inside the box, and the host-side port publish,
 * which is the daemon's own state and separate from the box's filesystem).
 */
async function resumeSandboxExclusive(name: string, lifecycle: LifecycleCommands | undefined): Promise<SbxStartResult> {
  const steps: SbxStep[] = [];
  const result = (ok: boolean): SbxStartResult => ({ ok, upstreamUrl: '', proxyPort: SBX_PROXY_PORT, steps });

  // Touching the box is what actually wakes a stopped one ("returns when
  // someone next uses it") and doubles as a liveness check before anything
  // below assumes it's reachable.
  steps.push(await runInSandbox(name, 'wake sandbox', 'true'));

  steps.push(await trustCa(name));

  // The KEY/PORT survive a stop (reuse when we can — see the function's own
  // doc comment), but sshd itself does not, the same reason
  // startExistingContainer re-runs SSHD_BOOTSTRAP unconditionally on every
  // resume: only the dummy PID1 process auto-restarts, not sshd. Running the
  // bootstrap script is therefore NOT conditional on whether ssh_access
  // already existed — that only decides whether the key itself gets reused
  // or (rare: a sandbox created outside Huddle, or a lost row) minted fresh.
  let sshAccess = getSshAccess(name);
  if (!sshAccess) sshAccess = provisionSshAccess(name, 'sbx');
  steps.push(await bootstrapSsh(name, sshAccess.publicKey));
  const publishStep = await publishSshPort(name, sshAccess.port);
  steps.push(publishStep);
  if (publishStep.code === 0) steps.push(await verifySshReachable(sshAccess.port));

  // postStartCommand only — onCreate/updateContent/postCreate/env-script/
  // settings-folder-linking/JetBrains install are create-only concerns,
  // exactly like docker.ts's startExistingContainer only re-running
  // postStartCommand on every resume.
  const postStartScript = buildSbxLifecycleStep('postStart', lifecycle?.postStartCommand, DEFAULT_WORKSPACE);
  if (postStartScript) steps.push(await runInSandbox(name, 'run lifecycle commands', postStartScript));

  return result(steps.every((s) => s.code === 0));
}

/**
 * Bind the host port Huddle minted for this sandbox's sshd (`ssh-keys.ts`,
 * `provisionSshAccess`) to its container-side port 22, via `sbx ports`.
 * Without this, the port shown to the user in the UI/CLI (`huddle sbx
 * ssh-setup`) is never actually reachable — sshd runs inside the box, but
 * nothing on the host forwards to it. A failure here is reported as a normal
 * failed create-step rather than swallowed, since a silently-unpublished
 * port looks identical to a working one until someone tries to connect.
 */
async function publishSshPort(name: string, hostPort: number): Promise<SbxStep> {
  const spec = `${hostPort}:22`;
  const command = `sbx ports ${name} --publish ${spec}`;
  try {
    const r = await ops.portsPublish(name, spec);
    return { label: 'publish SSH port', command, code: r.code, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    return { label: 'publish SSH port', command, code: 1, stdout: '', stderr: (err as Error).message };
  }
}

/** Generic "run this script inside the sandbox" step — same shape as trustCa/linkSettingsFolders. */
async function runInSandbox(name: string, label: string, script: string): Promise<SbxStep> {
  const command = `sbx exec ${name} -- sh -c '…${label}…'`;
  let out = '';
  let errOut = '';
  try {
    const code = await ops.exec({ name, cmd: ['sh', '-c', script] }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
      else errOut = cap(errOut + d);
    });
    return { label, command, code, stdout: out, stderr: errOut };
  } catch (err) {
    return { label, command, code: 1, stdout: out, stderr: cap(errOut || (err as Error).message) };
  }
}

/**
 * Run sshBootstrapScript and record the user/home it reports. The exec user is
 * NOT root (see sshBootstrapScript) and it is not knowable from the host, so
 * the script that places authorized_keys is also the thing that tells us which
 * user to put in the generated ~/.ssh/config and which home to point VS Code's
 * remote path at. Parsed even on a failed step: step 1 of the script runs
 * before anything that can fail, so a red step still teaches us the user.
 */
async function bootstrapSsh(name: string, publicKey: string): Promise<SbxStep> {
  const step = await runInSandbox(name, 'install SSH server + authorized_keys', sshBootstrapScript(publicKey));
  const user = /^HUDDLE_SSH_USER=(.+)$/m.exec(step.stdout)?.[1]?.trim();
  const home = /^HUDDLE_SSH_HOME=(.+)$/m.exec(step.stdout)?.[1]?.trim();
  if (user && home) recordSshIdentity(name, user, home);
  return step;
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

/**
 * SSH access (Stage 2) — install openssh-server if missing, generate host keys,
 * drop the developer's public key into authorized_keys, start sshd, and VERIFY
 * it is listening before returning.
 *
 * A sandbox does NOT run as root. `sbx exec` runs as `agent` (uid 1000, member
 * of the `sudo` group) — confirmed live 2026-09-29 (`id` inside a real
 * sandbox: `uid=1000(agent) ... groups=1000(agent),27(sudo),1001(docker)`).
 * The previous version of this script assumed root, so the install, the
 * host-key generation and the port-22 bind all failed silently (`|| true`,
 * plus a trailing `&` that forces a script's
 * exit status to 0 no matter what) and Huddle reported a green step for a
 * sandbox with no sshd in it at all. Everything privileged therefore goes
 * through `sudo -n` here, exactly like caInstallCommand() above, and every
 * failure is a real non-zero exit with a HUDDLE_SSHD_FAILED reason on stderr —
 * which the portal step list and the create modal print verbatim.
 *
 * The only backgrounded command is the final `sshd -D`; everything that can
 * fail runs and is checked in the foreground first, and the listener readback
 * after it keeps the step's exit code honest. sshd's stdio is redirected to a
 * file and its stdin to /dev/null so `sbx exec` still returns immediately —
 * streamSbx() has no timeout, so a script that blocks hangs the API request.
 *
 * Idempotent: a sandbox that is already listening on :22 (the resume path
 * re-runs this on every start) only gets its authorized_keys refreshed, which
 * sshd re-reads per authentication anyway.
 *
 * Emits HUDDLE_SSH_USER= / HUDDLE_SSH_HOME= on stdout — bootstrapSsh() parses
 * those, because the real login user is what the ~/.ssh/config `User` line and
 * the VS Code remote path have to carry (they used to hardcode `root`).
 *
 * apt install/update ordering (added 2026-09-30, confirmed root-caused live):
 * sbx's default agent kit runs its own root, backgrounded `apt-get update` on
 * every sandbox start (create AND resume), so this script tries `apt-get
 * install openssh-server` directly FIRST — both to skip a redundant update in
 * the common case and, more importantly, because plain `apt-get install` never
 * takes the apt *lists* lock (`/var/lib/apt/lists/lock`), only `apt-get
 * update` does, so going straight to install sidesteps the race entirely. Only
 * when the direct install fails with a "stale/missing metadata" signature does
 * it fall back to its own `apt-get update`, retried in a bounded (~100s)
 * backoff loop — that update IS the call that can genuinely race the kit's own
 * update for the lists lock ("Could not get lock ... held by process <N>
 * (apt-get)"). `DPkg::Lock::Timeout` does NOT help here — confirmed by local
 * reproduction — it only covers the dpkg frontend lock (install/remove), never
 * the lists lock `apt-get update` takes.
 *
 * NOTE: keep this script free of `${`, backticks and backslashes so it needs no
 * escaping inside this template literal.
 */
export function sshBootstrapScript(publicKey: string): string {
  const pubB64 = Buffer.from(publicKey, 'utf8').toString('base64');
  return `LOG=/tmp/huddle-sshd.log
INSTALL_LOG=/tmp/huddle-sshd-install.log

fail() {
  echo "HUDDLE_SSHD_FAILED $1" >&2
  exit 1
}

# Is anything listening on port 22? 'ss' is NOT installed in the sbx base image
# (confirmed live), so /proc/net/tcp is the primary source: a listening socket
# has state 0A, local port 0016 (hex 22) and an all-zero remote address.
port22_listening() {
  grep -qE ':0016 [0-9A-F]+:0000 0A ' /proc/net/tcp /proc/net/tcp6 2>/dev/null && return 0
  if command -v ss >/dev/null 2>&1; then
    ss -ltn 2>/dev/null | grep -qE '[^0-9]22[[:space:]]' && return 0
  fi
  return 1
}

can_verify() {
  [ -r /proc/net/tcp ] && return 0
  [ -r /proc/net/tcp6 ] && return 0
  command -v ss >/dev/null 2>&1 && return 0
  return 1
}

# ---- 1. who are we (this is also WHERE authorized_keys has to land) ----------
SSH_USER=$(id -un)
[ -n "$SSH_USER" ] || fail "WHOAMI: could not determine the exec user"
SSH_HOME=$HOME
[ -n "$SSH_HOME" ] || SSH_HOME=/home/$SSH_USER
[ -d "$SSH_HOME" ] || fail "NO_HOME: home directory $SSH_HOME does not exist"
echo "HUDDLE_SSH_USER=$SSH_USER"
echo "HUDDLE_SSH_HOME=$SSH_HOME"

# ---- 2. authorized_keys (the one step that never needs root) -----------------
mkdir -p "$SSH_HOME/.ssh" || fail "AUTHKEYS: mkdir $SSH_HOME/.ssh"
chmod 700 "$SSH_HOME/.ssh" || fail "AUTHKEYS: chmod 700 $SSH_HOME/.ssh"
printf '%s' '${pubB64}' | base64 -d > "$SSH_HOME/.ssh/authorized_keys" || fail "AUTHKEYS: could not write $SSH_HOME/.ssh/authorized_keys"
chmod 600 "$SSH_HOME/.ssh/authorized_keys" || fail "AUTHKEYS: chmod 600 failed"
echo HUDDLE_SSH_AUTHORIZED_KEYS_OK

# ---- 3. already running? (resume re-runs this on every start) ----------------
if port22_listening; then
  echo HUDDLE_SSHD_ALREADY_LISTENING
  exit 0
fi

# ---- 4. privilege ------------------------------------------------------------
if [ "$(id -u)" = 0 ]; then
  SUDO=
  echo HUDDLE_SSHD_PRIVILEGE=root
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  SUDO="sudo -n"
  echo HUDDLE_SSHD_PRIVILEGE=sudo
else
  fail "NO_ROOT: sshd needs root to install openssh-server, write host keys in /etc/ssh and bind port 22, but this sandbox execs as '$SSH_USER' and passwordless sudo is not available"
fi

# ---- 5. sshd present, or install it ------------------------------------------
SSHD_BIN=
for c in /usr/sbin/sshd /usr/local/sbin/sshd; do
  if [ -x "$c" ]; then SSHD_BIN=$c; break; fi
done
[ -n "$SSHD_BIN" ] || SSHD_BIN=$(command -v sshd 2>/dev/null)
if [ -z "$SSHD_BIN" ]; then
  command -v apt-get >/dev/null 2>&1 || fail "NO_SSHD: openssh-server is not installed and apt-get is not available in this image"
  echo HUDDLE_SSHD_INSTALLING

  # sbx's default (claude) agent kit runs its own root, backgrounded
  # 'apt-get update' on EVERY sandbox start - create and resume alike (kit
  # spec setup.startup hook, confirmed by reading docker/sbx-kits-contrib -
  # this is not a Huddle bug, it's how the kit is written). Try installing
  # directly first: the kit's own update has very likely already refreshed
  # the cache, so this both skips a redundant 'apt-get update' in the common
  # case AND - more importantly - avoids racing the kit's update for the apt
  # lists lock at all, since plain 'apt-get install' never touches
  # /var/lib/apt/lists/lock (only 'apt-get update' does). That race is
  # exactly what produced "Could not get lock /var/lib/apt/lists/lock. It is
  # held by process <N> (apt-get)" before this fix.
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server > "$INSTALL_LOG" 2>&1
  install_rc=$?

  if [ "$install_rc" != 0 ] && grep -qiE 'unable to locate package|has no installation candidate|maybe run apt-get update|unable to fetch some archives' "$INSTALL_LOG"; then
    # The direct install failed in a way that points at stale/missing package
    # metadata (not e.g. a plain fetch error on the .deb itself) - fall back
    # to our own 'apt-get update'. THIS is the call that can genuinely race
    # the kit's background update for the lists lock, so it is retried in a
    # bounded loop instead of failing on the first lock error.
    #
    # DPkg::Lock::Timeout deliberately NOT used here: confirmed by local
    # reproduction of the exact lock scenario that it only ever covers the
    # dpkg FRONTEND lock (/var/lib/dpkg/lock-frontend, taken by apt-get
    # install/remove) and has zero effect on the LISTS lock apt-get update
    # takes (/var/lib/apt/lists/lock) - byte-identical failure with or
    # without the flag set. A real fix has to actually retry the command.
    echo HUDDLE_SSHD_STALE_CACHE
    apt_lock_deadline_s=100
    apt_waited_s=0
    apt_retry_delay_s=2
    update_rc=1
    while :; do
      $SUDO apt-get update -qq >> "$INSTALL_LOG" 2>&1
      update_rc=$?
      [ "$update_rc" = 0 ] && break
      [ "$apt_waited_s" -ge "$apt_lock_deadline_s" ] && break
      sleep "$apt_retry_delay_s"
      apt_waited_s=$((apt_waited_s + apt_retry_delay_s))
      apt_retry_delay_s=$((apt_retry_delay_s * 2))
      [ "$apt_retry_delay_s" -gt 10 ] && apt_retry_delay_s=10
    done
    if [ "$update_rc" != 0 ]; then
      tail -n 30 "$INSTALL_LOG" >&2
      # Two-tier hint: distinguish "another process held the lock the whole
      # time" (retry-worthy, NOT a firewall problem - the old message here
      # sent people chasing a firewall issue that didn't exist) from a real
      # fetch/network failure (DNS, connection refused, 404 from a mirror).
      if grep -qiE 'could not get lock|is another process using it|resource temporarily unavailable' "$INSTALL_LOG"; then
        fail "INSTALL: apt-get update timed out waiting $apt_lock_deadline_s seconds for another process (most likely sbx's own background apt-get update) to release the package lock - this is lock contention, not a firewall problem; it should clear on its own, retry sbx start shortly"
      else
        fail "INSTALL: apt-get update failed with a real fetch error (not lock contention) - check DNS/connectivity and that Huddle's firewall allows archive.ubuntu.com, security.ubuntu.com, download.docker.com, and (on arm64 hosts) ports.ubuntu.com"
      fi
    fi
    $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends openssh-server >> "$INSTALL_LOG" 2>&1
    install_rc=$?
  fi

  if [ "$install_rc" != 0 ]; then
    tail -n 30 "$INSTALL_LOG" >&2
    fail "INSTALL: apt-get install openssh-server failed"
  fi
  for c in /usr/sbin/sshd /usr/local/sbin/sshd; do
    if [ -x "$c" ]; then SSHD_BIN=$c; break; fi
  done
  [ -n "$SSHD_BIN" ] || SSHD_BIN=$(command -v sshd 2>/dev/null)
  [ -n "$SSHD_BIN" ] || fail "INSTALL: openssh-server reported success but no sshd binary was found"
  echo HUDDLE_SSHD_INSTALLED
fi
echo "HUDDLE_SSHD_BIN=$SSHD_BIN"

# ---- 6. host keys + privilege-separation directory ---------------------------
if ! $SUDO ssh-keygen -A > /tmp/huddle-sshd-keygen.log 2>&1; then
  tail -n 20 /tmp/huddle-sshd-keygen.log >&2
  fail "HOSTKEYS: ssh-keygen -A could not write host keys in /etc/ssh"
fi
# Debian/Ubuntu sshd refuses to start without this; it is NOT created by the
# package on a machine with no running init (confirmed missing, live).
$SUDO mkdir -p /run/sshd || fail "RUNDIR: could not create /run/sshd"
$SUDO chmod 0755 /run/sshd || fail "RUNDIR: could not chmod /run/sshd"
echo HUDDLE_SSHD_HOSTKEYS_OK

# ---- 7. validate BEFORE backgrounding ----------------------------------------
if ! $SUDO "$SSHD_BIN" -t > /tmp/huddle-sshd-test.log 2>&1; then
  cat /tmp/huddle-sshd-test.log >&2
  fail "CONFIG: sshd -t rejected the configuration or the host keys"
fi
echo HUDDLE_SSHD_CONFIG_OK

# ---- 8. launch (the ONLY backgrounded command) -------------------------------
: > "$LOG" 2>/dev/null
nohup $SUDO "$SSHD_BIN" -D -e >> "$LOG" 2>&1 < /dev/null &
disown 2>/dev/null || true

# ---- 9. readback: is it actually listening? ----------------------------------
if ! can_verify; then
  echo HUDDLE_SSHD_VERIFY_UNAVAILABLE
  exit 0
fi
i=0
while [ "$i" -lt 15 ]; do
  if port22_listening; then
    echo HUDDLE_SSHD_LISTENING
    exit 0
  fi
  sleep 1
  i=$((i + 1))
done
echo "--- tail of $LOG ---" >&2
tail -n 40 "$LOG" >&2 2>/dev/null
fail "NOT_LISTENING: sshd was launched but nothing is listening on port 22 after 15s"`;
}

/**
 * Prove the published port actually reaches sshd, from the host side. The
 * bootstrap script verifies the listener INSIDE the box and publishSshPort
 * verifies the daemon accepted the mapping — neither covers the gap between
 * them, which is exactly where "kex_exchange_identification: Connection
 * aborted" lives. A failure here is a real red step: SSH not working is not a
 * cosmetic detail of a sandbox whose whole purpose is being connected to.
 */
async function verifySshReachable(port: number): Promise<SbxStep> {
  const command = `(host) tcp 127.0.0.1:${port} -> expect an "SSH-" banner`;
  const r = await probeSshBannerWithRetry(port);
  return {
    label: 'verify SSH reachable',
    command,
    code: r.ok ? 0 : 1,
    stdout: r.banner,
    stderr: r.ok ? '' : `SSH on 127.0.0.1:${port} did not answer: ${r.error}`,
  };
}

/**
 * IDE backend install, entirely backgrounded inside the sandbox — unlike
 * docker.ts's buildJbConfigScript, there is no shared dist/ volume here (each
 * sbx sandbox is its own filesystem), so the ~1.5 GB IntelliJ download is
 * never a cache hit. Blocking `sbx create` on it would turn today's
 * near-instant create into a multi-minute one, so the script backgrounds the
 * whole install+run sequence and returns immediately; the frontend polls
 * jetbrainsGatewayLink() for the resulting connect link.
 *
 * `run` (not just `install`) is what makes this useful over the SSH flow: it
 * passes `--ssh-link-host/--ssh-link-port`, which makes the backend itself
 * print a ready `jetbrains-gateway://connect#…` link — reading that off the
 * backend's own log is simpler and more robust than hand-building Gateway's
 * undocumented link parameters ourselves (pocsshcontainers/README.md,
 * "Can credentials go into the Gateway link?").
 *
 * sbx has no per-sandbox IDE picker yet, so this always installs IntelliJ —
 * same default docker.ts uses for a devcontainer with no ideName given.
 */
function ideInstallScript(sshPort: number): string {
  const ide: IdeName = 'intellij';
  const scriptB64 = Buffer.from(readDevcontainerScript('install-ide.sh'), 'utf8').toString('base64');
  const install = `HUDDLE_SBX_ROOT=1 /usr/local/bin/huddle-install-ide.sh install ${shQuote(ide)}`;
  const run = `HUDDLE_SBX_ROOT=1 /usr/local/bin/huddle-install-ide.sh run ${shQuote(ide)} localhost ${sshPort}`;
  return `echo '${scriptB64}' | base64 -d > /usr/local/bin/huddle-install-ide.sh
chmod 755 /usr/local/bin/huddle-install-ide.sh
( ${install} && ${run} ) > /root/huddle-ide-install.log 2>&1 &
disown 2>/dev/null || true`;
}

/**
 * Best-effort peek at the JetBrains backend's own log for the
 * `jetbrains-gateway://…` link it prints once started (pocsshcontainers/
 * run-poc.sh greps the same way). Returns null while the backend is still
 * downloading/installing/indexing — the caller (the API route) is polled
 * again from the frontend rather than this function waiting itself, so a
 * slow install never ties up an HTTP request.
 */
export async function jetbrainsGatewayLink(name: string): Promise<string | null> {
  const script = `grep -ohE 'jetbrains-gateway://[^[:space:]"]+' /root/backend.log 2>/dev/null | tail -1`;
  let out = '';
  try {
    await ops.exec({ name, cmd: ['sh', '-c', script] }, (s, d) => {
      if (s === 'stdout') out = cap(out + d);
    });
  } catch {
    return null;
  }
  const link = out.trim();
  return link || null;
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
  dropSshAccess(name);
  return code;
}
