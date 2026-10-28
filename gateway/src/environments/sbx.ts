// Docker Sandboxes (`sbx`) as an environment provider. Every command is an argv
// array handed to the host agent's `tool.run` (never a shell), and every value
// that ends up in that argv is validated here first. Ported from
// feat/sbx-sandboxes-rebased:gateway/src/sandbox/ops.ts, minus everything that
// needed the gateway on the host (policy reconcile, SSH). Egress goes through
// Huddle with a proxy secret per sandbox: see sbx-egress.ts.

import crypto from 'crypto';
import { hostPipe, HostPipe } from '../host-pipe';
import { normalizeHostPath, hostPathError, hostPathLeaf, huddleHomeMountError, hostHuddleHome } from '../host-path';
import { HostFolderMapping, listFolderMappings } from '../host-config';
import { containerPathError } from '../workspace-root';
import { getCaCertPem } from '../tls-ca';
import {
  EnvironmentProvider,
  IdeKind,
  IdeLink,
  InvalidSpecError,
  ProviderDisabledError,
  ProviderStatus,
  RecreateState,
  SandboxCreateResult,
  SandboxInfo,
  SandboxSpec,
  SandboxStep,
  ToolFailedError,
} from './types';
import {
  RESET_USER,
  caFingerprint,
  hashProxySecret,
  isHuddleProxyUrl,
  newProxySecret,
  redactProxyUrls,
  sbxProxyHostPort,
  sbxProxyUrl,
} from './sbx-egress';

export const SBX_AGENTS = ['claude', 'codex', 'copilot', 'gemini', 'shell'];
export const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const MAX_WORKSPACES = 32;
const CREATE_TIMEOUT_MS = 15 * 60_000;
const DEFAULT_TIMEOUT_MS = 30_000;
// Gateway-side wait on top of the host-side timeout, so a slow tool comes back
// as the agent's own result rather than as host_pipe_timeout.
const PIPE_GRACE_MS = 10_000;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

type PipeCall = Pick<HostPipe, 'call'>;

// `huddle-<leaf of first workspace>-<4 hex>`, squeezed into the name rules: a
// Windows leaf like `My Project_v2` becomes `my-project-v2`.
export function defaultSandboxName(firstWorkspace: string, rand: string = crypto.randomBytes(2).toString('hex')): string {
  const leaf = hostPathLeaf(firstWorkspace)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63 - 'huddle-'.length - '-xxxx'.length)
    .replace(/-+$/, '');
  return leaf ? `huddle-${leaf}-${rand}` : `huddle-${rand}`;
}

// One workspace path as sbx gets it: normalized, then held to the same rules as
// any mount path. A colon outside the drive letter is refused too: sbx reads a
// trailing `:ro` as a flag, so `/a:ro` must not be smuggled in as a path.
function validWorkspacePath(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidSpecError('workspace path must be a string');
  const p = normalizeHostPath(raw);
  const problem = hostPathError(p);
  if (problem) throw new InvalidSpecError(`workspace path ${problem}`);
  if (p.replace(/^[A-Za-z]:/, '').includes(':')) throw new InvalidSpecError("workspace path must not contain ':'");
  return p;
}

// argv for `sbx create --name <name> <agent> <primary> [<path>[:ro] ...]`. The
// first workspace is never read-only (sbx needs somewhere to write); duplicates
// are dropped (sbx rejects the same folder twice; Windows compares case-
// insensitively). Pure, so the argv is unit-testable without a host.
export function buildCreateArgs(spec: SandboxSpec & { name: string }): string[] {
  if (!SANDBOX_NAME_RE.test(spec.name)) {
    throw new InvalidSpecError('name must be 1-63 characters: lower-case letters, digits and -, not starting with -');
  }
  if (!SBX_AGENTS.includes(spec.agent)) throw new InvalidSpecError(`agent must be one of: ${SBX_AGENTS.join(', ')}`);
  if (!Array.isArray(spec.workspaces) || spec.workspaces.length === 0) {
    throw new InvalidSpecError('at least one workspace is required');
  }
  if (spec.workspaces.length > MAX_WORKSPACES) throw new InvalidSpecError(`at most ${MAX_WORKSPACES} workspaces`);

  const key = (p: string) => (/^[A-Z]:\//.test(p) ? p.toLowerCase() : p);
  const seen = new Set<string>();
  const paths: string[] = [];
  spec.workspaces.forEach((w, i) => {
    const p = validWorkspacePath(w?.path);
    if (seen.has(key(p))) return;
    seen.add(key(p));
    const readOnly = i > 0 && w.readOnly === true;
    const homeProblem = huddleHomeMountError(p, readOnly);
    if (homeProblem) throw new InvalidSpecError(`workspace path ${homeProblem}`);
    paths.push(readOnly ? `${p}:ro` : p);
  });
  return ['create', '--name', spec.name, spec.agent, ...paths];
}

// For the step log in the portal: argv as one readable line.
function displayCommand(args: string[]): string {
  return ['sbx', ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');
}

/**
 * Parse `sbx ls` (docker-style tabwriter). Uses the header's column offsets for
 * fixed-width slicing when present (STATUS can contain spaces, e.g. "Up 2
 * hours"); without a header the first token is the name. Never throws.
 */
export function parseSbxLsTable(stdout: string): SandboxInfo[] {
  const out: SandboxInfo[] = [];
  const colStarts: number[] = [];
  const colKeys: string[] = [];
  let sawFirst = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    // rtrim only — leading spaces keep the header offsets meaningful.
    const line = rawLine.replace(/\s+$/, '');
    if (!line.trim()) continue;
    if (!sawFirst) {
      sawFirst = true;
      if (/^\s*name\b/i.test(line) || /\bNAME\b/.test(line)) {
        const re = /\S+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          colKeys.push(m[0].toLowerCase());
          colStarts.push(m.index);
        }
        continue;
      }
    }
    let name: string;
    let status: string | undefined;
    if (colStarts.length) {
      const fields: Record<string, string> = {};
      colStarts.forEach((start, i) => {
        const end = i + 1 < colStarts.length ? colStarts[i + 1] : line.length;
        fields[colKeys[i]] = line.slice(start, end).trim();
      });
      name = fields['name'] || line.trim().split(/\s+/)[0] || '';
      status = fields['status'] || fields['state'] || undefined;
    } else {
      const parts = line.trim().split(/\s+/);
      name = parts[0];
      status = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
    }
    if (name) out.push({ name, provider: 'sbx', status });
  }
  return out;
}

/**
 * Parse `sbx ls --json`. The schema is not pinned, so this is tolerant: a
 * top-level array, or an object holding a sandboxes/items/list/boxes array;
 * name from name/Name/vm_name/id, status from status/Status/state/State,
 * workspaces from workspaces/Workspaces/paths (strings or {path}). Returns null
 * when it is not recognisable JSON (caller falls back to the table parser).
 */
export function parseSbxLsJson(stdout: string): SandboxInfo[] | null {
  const t = stdout.trim();
  if (!t) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  let items: unknown[];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    const arr = o.sandboxes ?? o.items ?? o.list ?? o.boxes;
    if (!Array.isArray(arr)) return null;
    items = arr;
  } else return null;

  const out: SandboxInfo[] = [];
  const seen = new Set<string>();
  for (const e of items) {
    let name: unknown;
    let status: unknown;
    let agent: unknown;
    let ws: unknown;
    if (typeof e === 'string') name = e;
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      name = o.name ?? o.Name ?? o.vm_name ?? o.id ?? o.ID;
      status = o.status ?? o.Status ?? o.state ?? o.State;
      agent = o.agent ?? o.Agent ?? o.agent_name;
      ws = o.workspaces ?? o.Workspaces ?? o.paths;
    }
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    seen.add(name);
    const info: SandboxInfo = { name, provider: 'sbx' };
    if (typeof status === 'string') info.status = status;
    if (typeof agent === 'string' && agent) info.agent = agent;
    if (Array.isArray(ws)) {
      // A read-only workspace keeps sbx's own `:ro` suffix, so it can be recreated as one.
      const pathOf = (w: any): string | undefined => {
        if (typeof w === 'string') return w;
        if (!w || typeof w !== 'object' || typeof w.path !== 'string') return undefined;
        return w.readOnly === true || w.read_only === true || w.readonly === true || w.ro === true ? `${w.path}:ro` : w.path;
      };
      const paths = ws.map(pathOf).filter((p): p is string => typeof p === 'string' && !!p);
      if (paths.length) info.workspaces = paths;
    }
    out.push(info);
  }
  return out;
}


function failure(r: RunResult, fallback: string): ToolFailedError {
  return new ToolFailedError(redactProxyUrls((r.stderr || r.stdout).trim()) || fallback, r.code);
}

/**
 * The sandbox spec back from an `sbx ls --json` row, for recreating a sandbox
 * Huddle has no record of. Null when sbx did not say which agent or folders.
 */
export function specFromListing(info: SandboxInfo): SandboxSpec | null {
  // Folders inside ~/.huddle are the folder-mapping links: the create adds them again.
  const workspaces = (info.workspaces ?? [])
    .map((w) => (/:ro$/.test(w) ? { path: w.slice(0, -3), readOnly: true } : { path: w, readOnly: false }))
    .filter((w) => !huddleHomeMountError(normalizeHostPath(w.path), true));
  if (!info.agent || !SBX_AGENTS.includes(info.agent) || !workspaces.length) return null;
  return { name: info.name, agent: info.agent, workspaces };
}

// ── Folder mappings ──────────────────────────────────────────────────────────
// Settings → Folder mappings in a sandbox: the host agent links each mapping
// into ~/.huddle/sbx/links/<name>/rw or /ro (op `sbx.links`), those two folders
// go to `sbx create` as extra workspaces (ro with `:ro`), and after the create a
// script in the sandbox links each one to its container path. See
// cli/src/pipe/sbx-links.ts for why this is safe.

export interface FolderMappingPlan {
  /** What the host agent links: id → host folder. */
  links: { id: string; hostPath: string; readOnly: boolean }[];
  /** id → container path and display name. */
  targets: Map<string, { containerPath: string; name: string }>;
  /** Mappings left out, with why, for the create's steps. */
  skipped: string[];
}

/** Which mappings can go into a sandbox. Same checks as for a devcontainer mount. */
export function planFolderMappings(mappings: HostFolderMapping[]): FolderMappingPlan {
  const plan: FolderMappingPlan = { links: [], targets: new Map(), skipped: [] };
  const usedTargets = new Set<string>();
  mappings.forEach((m, i) => {
    if (!m.enabled) return;
    const name = m.name || `#${m.id}`;
    if (!m.hostPath?.trim()) {
      if (m.volumeName?.trim()) plan.skipped.push(`${name}: a Docker volume, only for devcontainers`);
      return;
    }
    const hostPath = normalizeHostPath(m.hostPath.trim());
    const hostProblem = hostPathError(hostPath) ?? huddleHomeMountError(hostPath, m.readOnly);
    if (hostProblem) return void plan.skipped.push(`${name}: host path ${hostProblem}`);
    const containerPath = m.containerPath.trim().replace(/\/+$/, '');
    const containerProblem = containerPathError(containerPath);
    if (containerProblem) return void plan.skipped.push(`${name}: container path ${containerProblem}`);
    if (usedTargets.has(containerPath)) return void plan.skipped.push(`${name}: ${containerPath} is mapped already`);
    usedTargets.add(containerPath);
    const id = /^\d{1,12}$/.test(String(m.id)) ? `m${m.id}` : `i${i}`;
    plan.links.push({ id, hostPath, readOnly: m.readOnly });
    plan.targets.set(id, { containerPath, name });
  });
  return plan;
}

/** Where sbx puts a host folder in the sandbox: `C:/Users/me` → `/c/Users/me`, POSIX as is. */
export function sandboxPathOf(hostPath: string): string {
  const p = normalizeHostPath(hostPath);
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  return drive ? `/${drive[1].toLowerCase()}${drive[2] && drive[2] !== '/' ? drive[2] : ''}` : p;
}

const sq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * The script `sbx exec` runs after the create: each mapping folder linked to
 * its container path. The devcontainer paths assume user vscode, so
 * /home/vscode becomes the sandbox user's $HOME. Whatever the sandbox has at
 * that path already is moved to `<path>.huddle-orig` (an empty folder is just
 * removed), like a mount hides it in a devcontainer. Paths outside $HOME may
 * need sudo; when that is not there, that one mapping fails and the rest go on.
 */
export function buildLinkScript(links: { from: string; to: string }[]): string {
  const target = (p: string) => {
    const home = /^\/home\/vscode(\/.*)?$/.exec(p);
    return home ? `"$HOME"${home[1] ? sq(home[1]) : ''}` : sq(p);
  };
  return [
    'l() {',
    '  if [ -e "$2" ] && [ ! -L "$2" ]; then',
    '    rmdir "$2" 2>/dev/null || mv "$2" "$2.huddle-orig" 2>/dev/null || sudo -n mv "$2" "$2.huddle-orig" || return 1',
    '  fi',
    '  d=$(dirname "$2")',
    '  mkdir -p "$d" 2>/dev/null || sudo -n mkdir -p "$d" || return 1',
    '  ln -sfn "$1" "$2" 2>/dev/null || sudo -n ln -sfn "$1" "$2"',
    '}',
    'rc=0',
    ...links.map((l) => `l ${sq(l.from)} ${target(l.to)} || { echo "could not link "${target(l.to)} >&2; rc=1; }`),
    'exit $rc',
  ].join('\n');
}

/** What the host agent's `sbx.links` returns. */
interface SbxLinksResult {
  rw: string | null;
  ro: string | null;
  skipped: { id: string; reason: string }[];
}

/**
 * vscode://vscode-remote/ssh-remote+<host><folder> for VS Code Remote-SSH, or a
 * JetBrains Toolbox SSH link (jetbrains://gateway/ssh/environment; Gateway's own
 * jetbrains-gateway:// links are on their way out). Both use the ssh alias as
 * host and no user or port, so the ssh config `sbx setup ssh` wrote decides how
 * to get there and as whom. No ideHint: Toolbox asks which IDE. A folder that is
 * not an absolute POSIX path (a Windows path) is left out.
 */
export function buildIdeLink(ide: IdeKind, sshHost: string, folder?: string): string {
  const posix = folder && folder.startsWith('/') ? folder : undefined;
  if (ide === 'vscode') {
    return `vscode://vscode-remote/ssh-remote+${encodeURIComponent(sshHost)}${posix ? posix.split('/').map(encodeURIComponent).join('/') : ''}`;
  }
  const params: [string, string][] = [['h', sshHost], ['launchIde', 'true']];
  if (posix) params.push(['projectHint', posix]);
  return 'jetbrains://gateway/ssh/environment?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}

/**
 * `sbx policy allow|rm network --sandbox <name> "**"`: every host, for one sandbox.
 * Only for a sandbox routed through Huddle, whose firewall then decides alone.
 */
/** The kit the host agent writes for the Huddle CA (cli/src/pipe/sbx-kit.ts). */
const CA_KIT = 'huddle-ca';
// What an sbx without kits says to `create --kit`.
const NO_KIT_RE = /(unknown|undefined|unrecognized) (flag|option)[^\n]*kit|flag provided but not defined:? -+kit/i;

/** What the gateway keeps of a sandbox: its spec, and whether it trusts the Huddle CA. */
// huddleCa: created with the Huddle CA kit; caSha256: of which CA (missing on
// sandboxes from before it was stored).
export type StoredSandboxSpec = SandboxSpec & { huddleCa?: boolean; caSha256?: string };

// What `sbx policy rm` says when there was no such rule: nothing left to remove.
const NO_RULE_RE = /not found|no (matching )?(rule|polic)|does not exist|doesn't exist/i;

export function allowAllArgs(verb: 'allow' | 'rm', name: string): string[] {
  return ['policy', verb, 'network', '--sandbox', name, '**'];
}

/** What the provider keeps between runs (the DB in production, see sbx-store.ts). */
export interface SbxStore {
  enabled(): boolean;
  setEnabled(on: boolean): void;
  /** The reset secret, minted on first use and then kept (it must survive a gateway restart). */
  resetSecret(): string;
  /**
   * The `proxy.sandbox` value from before Huddle took it over, '' for unset.
   * Null: none saved. May come back with its password masked (`:***@`).
   */
  originalProxy(): string | null;
  setOriginalProxy(value: string | null): void;
  saveIdentity(name: string, secretHash: string, spec: SandboxSpec): void;
  spec(name: string): SandboxSpec | null;
  clearIdentities(): void;
  /** Whether the gateway knows this sandbox's current proxy secret. */
  identified(name: string): boolean;
}

// After a recreate that the reset secret triggered, ignore the reset secret for
// this long: a sandbox that could not be recreated keeps presenting it, and that
// must not turn into a loop of recreating everything.
const RESET_COOLDOWN_MS = 5 * 60_000;

const NO_PORT = 'The Huddle CLI did not publish the sandbox egress port. Run `huddle init` again.';

export class SbxProvider implements EnvironmentProvider {
  readonly id = 'sbx';
  readonly label = 'Docker Sandbox';
  private queue: Promise<unknown> = Promise.resolve();
  private recreate: RecreateState | undefined;
  private recreating: Promise<void> | undefined;
  // Removed through Huddle since the running recreate listed the sandboxes: it
  // must not bring them back.
  private removedSinceListing = new Set<string>();
  // `sbx setup ssh` ran (once per gateway run is enough: it writes the host's ssh config).
  private sshReady = false;

  constructor(
    private readonly pipe: PipeCall = hostPipe,
    private readonly store: SbxStore,
    private readonly hostPort: number | null = sbxProxyHostPort(),
    private readonly folderMappings: () => HostFolderMapping[] = listFolderMappings,
    private readonly caPem: () => string = getCaCertPem,
  ) {}

  private run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
    return this.pipe.call<RunResult>('tool.run', { tool: 'sbx', args, timeoutMs }, { timeoutMs: timeoutMs + PIPE_GRACE_MS });
  }

  // Runs a command and logs it as a step, with every proxy secret masked.
  private async step(steps: SandboxStep[], label: string, args: string[], timeoutMs?: number): Promise<RunResult> {
    const r = await this.run(args, timeoutMs);
    steps.push({
      label,
      command: redactProxyUrls(displayCommand(args)),
      code: r.code,
      stdout: redactProxyUrls(r.stdout),
      stderr: redactProxyUrls(r.stderr),
    });
    return r;
  }

  // `proxy.sandbox` is one setting for the whole machine, so everything that
  // sets it runs one at a time: two creates at once could swap their secrets.
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  isEnabled(): boolean {
    return this.store.enabled();
  }

  private isOurs(value: string): boolean {
    return isHuddleProxyUrl(value, this.hostPort as number, this.store.resetSecret());
  }

  private resetUrl(): string {
    return sbxProxyUrl(RESET_USER, this.store.resetSecret(), this.hostPort as number);
  }

  // Not available is an answer, not an error: sbx missing or broken on the host
  // is shown in the portal. A dead pipe is the caller's problem (503).
  async status(): Promise<ProviderStatus> {
    const base: ProviderStatus = {
      id: this.id,
      label: this.label,
      enabled: this.isEnabled(),
      available: false,
      agents: [...SBX_AGENTS],
      ...(this.hostPort === null ? { unavailableReason: NO_PORT } : {}),
      ...(this.recreate ? { recreate: structuredClone(this.recreate) } : {}),
    };
    try {
      const r = await this.run(['version']);
      if (r.code !== 0) return { ...base, error: failure(r, 'sbx version failed').message };
      const version = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200);
      return { ...base, available: true, version };
    } catch (err: any) {
      if (err?.code === 'host_pipe_offline') throw err;
      if (err?.code === 'tool_missing') return { ...base, error: 'sbx is not installed on the host' };
      return { ...base, error: err?.message ?? String(err) };
    }
  }

  private requireEnabled(): void {
    if (!this.isEnabled()) throw new ProviderDisabledError('Docker Sandbox is switched off in Huddle');
    // Switched on under a CLI that published the port, now running without it:
    // there is no URL to give a new sandbox.
    if (this.hostPort === null) throw new ProviderDisabledError(NO_PORT);
  }

  async list(): Promise<SandboxInfo[]> {
    this.requireEnabled();
    return this.listAll();
  }

  private async listAll(): Promise<SandboxInfo[]> {
    // Prefer --json: structured, so a header row can never pass for a sandbox.
    // Older sbx without --json: parse the table.
    const j = await this.run(['ls', '--json']);
    if (j.code === 0) return parseSbxLsJson(j.stdout) ?? parseSbxLsTable(j.stdout);
    const r = await this.run(['ls']);
    if (r.code !== 0) throw failure(r, 'sbx ls failed');
    return parseSbxLsTable(r.stdout);
  }

  async create(spec: SandboxSpec): Promise<SandboxCreateResult> {
    this.requireEnabled();
    const first = Array.isArray(spec?.workspaces) && spec.workspaces.length ? validWorkspacePath(spec.workspaces[0]?.path) : '';
    const name = spec.name || (first ? defaultSandboxName(first) : '');
    const args = buildCreateArgs({ ...spec, name });
    const steps: SandboxStep[] = [];
    const ok = await this.exclusive(async () => {
      // A taken name: sbx create refuses it, but only after preparing the folder
      // mappings has replaced the links the existing sandbox with that name uses.
      if (planFolderMappings(this.folderMappings()).links.length && (await this.listAll()).some((s) => s.name === name)) {
        steps.push({ label: 'Create sandbox', command: '', code: 1, stdout: '', stderr: `a sandbox named ${name} already exists` });
        return false;
      }
      return this.createWithSecret({ ...spec, name }, args, steps);
    });
    return { name, ok, steps };
  }

  /**
   * The create sequence (call inside exclusive()): point `proxy.sandbox` at the
   * gateway with a fresh secret, create, and point it back at the reset secret,
   * also when the create failed. The sandbox is only known to the gateway when
   * all three worked: with the setting still on this box's secret, the next
   * sandbox anyone creates would get this box's identity.
   */
  private async createWithSecret(spec: SandboxSpec & { name: string }, args: string[], steps: SandboxStep[]): Promise<boolean> {
    // Switched off while this waited in the queue: the setting is the user's again.
    if (!this.isEnabled()) throw new ProviderDisabledError('Docker Sandbox was switched off in Huddle');
    const mappings = await this.prepareFolderMappings(spec.name, steps);
    const kit = await this.prepareCaKit(steps);
    const secret = newProxySecret();
    const set = await this.step(steps, 'Route the sandbox through Huddle', ['settings', 'set', 'proxy.sandbox', sbxProxyUrl(spec.name, secret, this.hostPort as number)]);
    if (set.code !== 0) return false;
    // Huddle is this sandbox's firewall, so sbx's own policy lets everything
    // through to it instead of asking a second time. Set before the create when
    // sbx takes a rule for a sandbox that does not exist yet, else right after.
    const allowedEarly = await this.run(allowAllArgs('allow', spec.name)).then((r) => r.code === 0, () => false);
    let created: RunResult | undefined;
    let trustsCa = kit !== null;
    try {
      const createArgs = [...args, ...mappings.paths];
      created = await this.step(steps, 'Create sandbox', kit ? [createArgs[0], '--kit', kit, ...createArgs.slice(1)] : createArgs, CREATE_TIMEOUT_MS);
      // An sbx without kits: create it as before, without TLS inspection.
      if (kit && created.code !== 0 && NO_KIT_RE.test(`${created.stderr}\n${created.stdout}`)) {
        trustsCa = false;
        created = await this.step(steps, 'Create sandbox (this sbx has no kits: no TLS inspection)', createArgs, CREATE_TIMEOUT_MS);
      }
    } finally {
      await this.step(steps, 'Reset the proxy for the next sandbox', ['settings', 'set', 'proxy.sandbox', this.resetUrl()]).then(
        (r) => { if (r.code !== 0) created = undefined; },
        (err) => { created = undefined; steps.push({ label: 'Reset the proxy for the next sandbox', command: '', code: -1, stdout: '', stderr: String(err?.message ?? err) }); },
      );
    }
    if (created?.code !== 0) return false;
    if (!allowedEarly) {
      // A sandbox that still asks works, it only prompts: not a failed create.
      await this.step(steps, 'Leave the firewall to Huddle (sbx policy)', allowAllArgs('allow', spec.name)).catch((err) => {
        steps.push({ label: 'Leave the firewall to Huddle (sbx policy)', command: '', code: -1, stdout: '', stderr: String(err?.message ?? err) });
      });
    }
    const stored: StoredSandboxSpec = {
      name: spec.name,
      agent: spec.agent,
      workspaces: spec.workspaces.map((w) => ({ path: normalizeHostPath(w.path), readOnly: w.readOnly === true })),
    };
    if (trustsCa) {
      stored.huddleCa = true;
      try { stored.caSha256 = caFingerprint(this.caPem()); } catch { /* the kit was just made from it */ }
    }
    this.store.saveIdentity(spec.name, hashProxySecret(secret), stored);
    // The sandbox exists and is routed: a mapping that could not be linked shows
    // in the steps, it does not undo the create.
    if (mappings.links.length) {
      await this.step(steps, 'Link the folder mappings', ['exec', spec.name, '--', 'sh', '-c', buildLinkScript(mappings.links)]).catch((err) => {
        steps.push({ label: 'Link the folder mappings', command: '', code: -1, stdout: '', stderr: String(err?.message ?? err) });
      });
    }
    return true;
  }

  /**
   * Has the host agent write the kit that makes a sandbox trust the Huddle CA
   * (cli/src/pipe/sbx-kit.ts), and returns its folder for `sbx create --kit`.
   * Null when there is none (an older host agent): the sandbox is then created
   * without it, and its TLS is not inspected.
   */
  private async prepareCaKit(steps: SandboxStep[]): Promise<string | null> {
    const label = 'Prepare the Huddle CA (TLS inspection)';
    const skip = (why: string) => { steps.push({ label, command: '', code: 0, stdout: '', stderr: `no TLS inspection for this sandbox: ${why}` }); return null; };
    let caPem: string;
    try {
      caPem = this.caPem();
    } catch (err: any) {
      return skip(err?.message ?? String(err));
    }
    let res: { dir?: unknown };
    try {
      res = await this.pipe.call<{ dir?: unknown }>('sbx.kit', { caPem });
    } catch (err: any) {
      return skip(err?.message ?? String(err));
    }
    // Only ever Huddle's own kit folder.
    const dir = normalizeHostPath(String(res?.dir ?? ''));
    const home = hostHuddleHome();
    if (hostPathError(dir) || !dir.endsWith(`/sbx/kits/${CA_KIT}`) || (home && dir.toLowerCase() !== `${home}/sbx/kits/${CA_KIT}`.toLowerCase())) {
      return skip(`unexpected folder from the host (${dir})`);
    }
    steps.push({ label, command: '', code: 0, stdout: dir, stderr: '' });
    return dir;
  }

  /**
   * Has the host agent link the enabled folder mappings for this sandbox, and
   * returns the extra `sbx create` workspaces plus what to link inside. Never
   * fails the create: a mapping that cannot go in is listed in the steps.
   */
  private async prepareFolderMappings(name: string, steps: SandboxStep[]): Promise<{ paths: string[]; links: { from: string; to: string }[] }> {
    const none = { paths: [], links: [] };
    const plan = planFolderMappings(this.folderMappings());
    const label = 'Prepare the folder mappings';
    const note = (code: number, stdout: string, skipped: string[]) =>
      steps.push({ label, command: '', code, stdout, stderr: skipped.length ? `left out:\n${skipped.join('\n')}` : '' });
    if (plan.links.length === 0) {
      if (plan.skipped.length) note(0, '', plan.skipped);
      return none;
    }
    let res: SbxLinksResult;
    try {
      res = await this.pipe.call<SbxLinksResult>('sbx.links', { name, links: plan.links });
    } catch (err: any) {
      note(-1, '', [`all folder mappings: ${err?.message ?? err}`]);
      return none;
    }
    const skipped = [...plan.skipped, ...(res.skipped ?? []).map((s) => `${plan.targets.get(s.id)?.name ?? s.id}: ${s.reason}`)];
    const left = new Set((res.skipped ?? []).map((s) => s.id));
    const paths: string[] = [];
    const links: { from: string; to: string }[] = [];
    for (const kind of ['rw', 'ro'] as const) {
      const raw = res[kind];
      if (!raw) continue;
      // Only ever this sandbox's own folder under ~/.huddle/sbx/links.
      const dir = normalizeHostPath(String(raw));
      const home = hostHuddleHome();
      const expected = home ? `${home}/sbx/links/${name}/${kind}` : null;
      if (hostPathError(dir) || !dir.endsWith(`/sbx/links/${name}/${kind}`) || (expected && dir.toLowerCase() !== expected.toLowerCase())) {
        skipped.push(`${kind} mappings: unexpected folder from the host (${dir})`);
        continue;
      }
      paths.push(kind === 'ro' ? `${dir}:ro` : dir);
      for (const l of plan.links) {
        if ((l.readOnly ? 'ro' : 'rw') !== kind || left.has(l.id)) continue;
        links.push({ from: `${sandboxPathOf(dir)}/${l.id}`, to: plan.targets.get(l.id)!.containerPath });
      }
    }
    note(0, links.map((l) => `${l.to}`).join('\n'), skipped);
    return { paths, links };
  }

  async remove(name: string, opts: { force: boolean }): Promise<void> {
    this.requireEnabled();
    if (!SANDBOX_NAME_RE.test(name)) throw new InvalidSpecError('invalid sandbox name');
    // In the queue, so it cannot land between a recreate's rm and create.
    await this.exclusive(async () => {
      // Switched off while this waited in the queue: the sandbox is the user's again.
      if (!this.isEnabled()) throw new ProviderDisabledError('Docker Sandbox was switched off in Huddle');
      // Its allow-all rule first: a rule left behind would let a later sandbox
      // with this name, created outside Huddle, go anywhere.
      await this.run(allowAllArgs('rm', name)).catch(() => undefined);
      const r = await this.run(opts.force ? ['rm', '--force', name] : ['rm', name]);
      if (r.code !== 0) throw failure(r, 'sbx rm failed');
      this.removedSinceListing.add(name);
      // Its folder-mapping links (best effort: an older host agent lacks the op).
      await this.pipe.call('sbx.links', { name, links: [] }).catch(() => undefined);
    });
  }

  // `sbx setup ssh` makes every sandbox reachable as `<name>.sbx` from the
  // host's ssh config; the IDE on the host connects to that alias.
  async ideLink(name: string, ide: IdeKind): Promise<IdeLink> {
    this.requireEnabled();
    if (!SANDBOX_NAME_RE.test(name)) throw new InvalidSpecError('invalid sandbox name');
    const info = (await this.listAll()).find((s) => s.name === name);
    if (!info) throw new InvalidSpecError(`no sandbox named ${name}`);
    if (!this.sshReady) {
      const r = await this.run(['setup', 'ssh']);
      if (r.code !== 0) throw failure(r, 'sbx setup ssh failed');
      this.sshReady = true;
    }
    const sshHost = `${name}.sbx`;
    const folder = this.store.spec(name)?.workspaces[0]?.path ?? info.workspaces?.[0]?.replace(/:ro$/, '');
    return { link: buildIdeLink(ide, sshHost, folder), sshHost };
  }

  async setEnabled(enabled: boolean): Promise<SandboxStep[]> {
    if (enabled && this.hostPort === null) {
      throw new InvalidSpecError(NO_PORT);
    }
    const steps: SandboxStep[] = [];
    await this.exclusive(() => (enabled ? this.switchOn(steps) : this.switchOff(steps)));
    // Every sandbox that exists now still has the old (or no) Huddle identity.
    if (enabled && this.isEnabled()) await this.recreateAll('switched on');
    return steps;
  }

  // Call inside exclusive(). Only marked on once the daemon restart worked: until
  // then existing sandboxes may still have their old, direct way out, and saying
  // "on" would be a lie. Any failure puts the user's own setting back.
  private async switchOn(steps: SandboxStep[]): Promise<void> {
    if (this.isEnabled()) return;
    // Remember the user's own setting, to put back when switched off. Never our
    // own URL (left behind by a crash): restoring that would keep pointing here.
    const current = await this.run(['settings', 'get', 'proxy.sandbox']);
    if (current.code !== 0) throw failure(current, 'sbx settings get failed');
    const value = current.stdout.trim();
    // Saved before anything changes: while off, a saved setting also says a
    // switch-on was under way (see finishInterruptedSwitchOn).
    if (!this.isOurs(value)) this.store.setOriginalProxy(value);
    else if (this.store.originalProxy() === null) this.store.setOriginalProxy('');
    const set = await this.step(steps, 'Route new sandboxes through Huddle', ['settings', 'set', 'proxy.sandbox', this.resetUrl()]);
    if (set.code !== 0) {
      this.store.setOriginalProxy(null);
      throw failure(set, 'sbx settings set failed');
    }
    // Fail closed: after the restart every existing sandbox presents the reset
    // secret and is denied until it is recreated. Without it, a sandbox that
    // cannot be recreated would keep its old, direct way out.
    const restart = await this.step(steps, 'Restart the sbx daemon so running sandboxes go through Huddle', ['daemon', 'restart'], CREATE_TIMEOUT_MS);
    if (restart.code !== 0) {
      const restored = await this.restoreOriginal(steps).catch(() => undefined);
      if (restored?.code === 0) this.store.setOriginalProxy(null);
      throw failure(restart, 'sbx daemon restart failed');
    }
    this.store.setEnabled(true);
  }

  // Call inside exclusive(). Stays on until the user's setting is back and the
  // daemon has dropped Huddle, so a failure leaves something to retry: switched
  // off with sandboxes still pointing here, every one of them would get a 407.
  private async switchOff(steps: SandboxStep[]): Promise<void> {
    if (!this.isEnabled()) return;
    // The sandboxes are the user's again, without Huddle in the way: sbx's own
    // policy decides for them again, so their allow-all rule goes. One that is
    // left would let that box go anywhere once Huddle is out of the way, so a
    // failure keeps Huddle on (a box that had no rule is fine).
    const kept: string[] = [];
    for (const info of await this.listAll()) {
      const r = await this.step(steps, `Hand ${info.name} back to the sbx firewall`, allowAllArgs('rm', info.name))
        .catch((err) => ({ code: -1, stdout: '', stderr: String(err?.message ?? err) }));
      if (r.code !== 0 && !NO_RULE_RE.test(`${r.stdout}\n${r.stderr}`)) kept.push(info.name);
    }
    if (kept.length) throw new ToolFailedError(`could not remove the allow-all sbx policy of ${kept.join(', ')}; Huddle stays on, try again`, 1);
    const restore = await this.restoreOriginal(steps);
    if (restore.code !== 0) throw failure(restore, 'restoring proxy.sandbox failed');
    // Running sandboxes keep the Huddle proxy until sbx rebuilds their network.
    const restart = await this.step(steps, 'Restart the sbx daemon so running sandboxes drop Huddle', ['daemon', 'restart'], CREATE_TIMEOUT_MS);
    if (restart.code !== 0) throw failure(restart, 'sbx daemon restart failed');
    this.store.setEnabled(false);
    this.store.clearIdentities();
    this.store.setOriginalProxy(null);
  }

  private restoreOriginal(steps: SandboxStep[]): Promise<RunResult> {
    const original = this.store.originalProxy() ?? '';
    // A saved setting whose password was not kept (see SbxStore.originalProxy)
    // cannot be put back as it was: unset, and say so.
    if (original.includes(':***@')) {
      return this.step(steps, 'Your own sandbox proxy had a password, which Huddle did not keep: set it again with `sbx settings set proxy.sandbox`', ['settings', 'unset', 'proxy.sandbox']);
    }
    return original
      ? this.step(steps, 'Restore your own sandbox proxy', ['settings', 'set', 'proxy.sandbox', original])
      : this.step(steps, 'Restore the default sandbox proxy', ['settings', 'unset', 'proxy.sandbox']);
  }

  /**
   * Recreates every sandbox on the machine with a fresh secret, in the
   * background. Sandboxes Huddle did not create are adopted: they are recreated
   * from what `sbx ls --json` says about them. Everything inside a sandbox
   * outside its workspaces is lost; the workspaces are host folders and stay.
   */
  async recreateAll(reason: string): Promise<RecreateState> {
    this.requireEnabled();
    if (this.recreating) return structuredClone(this.recreate!);
    const state: RecreateState = { running: true, reason, startedAt: new Date().toISOString(), results: [] };
    this.recreate = state;
    this.recreating = this.recreateEach(state)
      .catch((err) => { state.results.push({ name: '*', ok: false, message: redactProxyUrls(String(err?.message ?? err)) }); })
      .finally(() => {
        state.running = false;
        state.finishedAt = new Date().toISOString();
        this.recreating = undefined;
      });
    return structuredClone(state);
  }

  /**
   * At gateway start. A gateway that stopped in the middle of a create or a
   * recreate does not know the secret of some sandboxes, and those get nothing
   * but 407s: recreate everything then. A switch-on or switch-off it stopped
   * in is undone or finished first. False when the host could not be asked
   * (pipe not up yet), so the caller tries again later.
   */
  async reconcile(): Promise<boolean> {
    if (this.hostPort === null) return true;
    if (!this.isEnabled()) return this.exclusive(() => this.finishInterruptedSwitchOn()).catch(() => false);
    let listed: SandboxInfo[];
    try {
      if (!(await this.exclusive(() => this.finishInterruptedSwitchOff()))) return false;
      if (!this.isEnabled()) return true;
      listed = await this.listAll();
    } catch {
      return false;
    }
    if (this.recreating) return true;
    if (listed.some((s) => !this.store.identified(s.name))) {
      await this.recreateAll('the gateway restarted without the secret of every sandbox');
    } else if (listed.some((s) => this.trustsOldCa(s.name))) {
      await this.recreateAll('the Huddle CA changed');
    }
    return true;
  }

  // Created trusting a Huddle CA that is no longer the current one (its files
  // were lost and it was regenerated): the listener does not inspect its TLS
  // (sbxTrustsHuddleCa) until a recreate gives it a kit with the current CA.
  private trustsOldCa(name: string): boolean {
    const spec = this.store.spec(name) as StoredSandboxSpec | null;
    if (!spec?.huddleCa || !spec.caSha256) return false;
    try { return spec.caSha256 !== caFingerprint(this.caPem()); } catch { return false; }
  }

  // A gateway that stopped inside switchOff() after the user's setting was put
  // back still says "on", while sandboxes may already go around Huddle. The
  // setting on the host decides: not ours means the switch-off was under way, so
  // finish it (restart, so no sandbox keeps a Huddle proxy it can never use).
  // False when it could not be told or finished.
  private async finishInterruptedSwitchOff(): Promise<boolean> {
    if (!this.isEnabled()) return true;
    const current = await this.run(['settings', 'get', 'proxy.sandbox']);
    if (current.code !== 0) return false;
    const value = current.stdout.trim();
    if (this.isOurs(value)) return this.movePort(value);
    const restart = await this.run(['daemon', 'restart'], CREATE_TIMEOUT_MS);
    if (restart.code !== 0) return false;
    this.store.setEnabled(false);
    this.store.clearIdentities();
    this.store.setOriginalProxy(null);
    return true;
  }

  // Huddle's setting on another port: `huddle init` published a new one since
  // sbx was switched on. Point it at this listener and restart, so no sandbox
  // keeps a port nothing may be listening on; they come back with the reset
  // secret and reconcile recreates them all.
  private async movePort(value: string): Promise<boolean> {
    if (Number(new URL(value).port) === this.hostPort) return true;
    const set = await this.run(['settings', 'set', 'proxy.sandbox', this.resetUrl()]);
    if (set.code !== 0) return false;
    const restart = await this.run(['daemon', 'restart'], CREATE_TIMEOUT_MS);
    if (restart.code !== 0) return false;
    this.store.clearIdentities();
    return true;
  }

  // A gateway that stopped inside switchOn() is off, but `proxy.sandbox` and
  // maybe every running sandbox point at Huddle: new sandboxes would get only
  // 407s and Huddle would never put the user's setting back. Undo it: setting
  // back, daemon restart. False when that could not be done.
  private async finishInterruptedSwitchOn(): Promise<boolean> {
    if (this.isEnabled() || this.store.originalProxy() === null) return true;
    const current = await this.run(['settings', 'get', 'proxy.sandbox']);
    if (current.code !== 0) return false;
    if (this.isOurs(current.stdout.trim())) {
      const restore = await this.restoreOriginal([]);
      if (restore.code !== 0) return false;
    }
    // Also when the setting is the user's again: the crash may have come after
    // the restart that handed the running sandboxes Huddle's reset secret.
    const restart = await this.run(['daemon', 'restart'], CREATE_TIMEOUT_MS);
    if (restart.code !== 0) return false;
    this.store.setOriginalProxy(null);
    return true;
  }

  /** The reset secret reached the gateway: recreate, unless that just happened. */
  onResetSecretSeen(): void {
    if (!this.isEnabled() || this.recreating) return;
    const last = this.recreate?.finishedAt ? Date.parse(this.recreate.finishedAt) : 0;
    if (Date.now() - last < RESET_COOLDOWN_MS) return;
    void this.recreateAll('a sandbox presented the reset secret');
  }

  // A sandbox that could not be recreated has no identity: all it can present
  // is the reset secret, which would set off another recreate of everything.
  // Stopped it is quiet (best effort: it may already be gone).
  private async stopUnrouted(name: string): Promise<void> {
    // Switched off meanwhile: the sandbox is the user's again, leave it running.
    if (!this.isEnabled()) return;
    await this.run(['stop', name]).catch(() => undefined);
  }

  private async recreateEach(state: RecreateState): Promise<void> {
    // Every old secret goes first: whichever box still holds one is denied.
    this.store.clearIdentities();
    this.removedSinceListing.clear();
    // Switched off meanwhile: the sandboxes left are the user's again, untouched.
    const switchedOff = (name: string) => state.results.push({ name, ok: false, message: 'not recreated: Docker Sandbox was switched off in Huddle' });
    for (const info of await this.listAll()) {
      if (!this.isEnabled()) {
        switchedOff(info.name);
        continue;
      }
      const spec = this.store.spec(info.name) ?? specFromListing(info);
      if (!spec) {
        await this.stopUnrouted(info.name);
        state.results.push({ name: info.name, ok: false, message: 'sbx did not say which agent and folders it has, so it cannot be recreated; stopped' });
        continue;
      }
      const steps: SandboxStep[] = [];
      let removed = false;
      try {
        const args = buildCreateArgs({ ...spec, name: info.name });
        const ok = await this.exclusive(async () => {
          if (!this.isEnabled()) return false;
          if (this.removedSinceListing.has(info.name)) {
            removed = true;
            return false;
          }
          const rm = await this.step(steps, 'Remove sandbox', ['rm', '--force', info.name]);
          if (rm.code !== 0) return false;
          return this.createWithSecret({ ...spec, name: info.name }, args, steps);
        });
        if (removed) {
          state.results.push({ name: info.name, ok: false, message: 'not recreated: removed in the meantime' });
          continue;
        }
        if (!ok && !this.isEnabled() && steps.length === 0) {
          switchedOff(info.name);
          continue;
        }
        const failed = steps.find((s) => s.code !== 0);
        if (!ok) await this.stopUnrouted(info.name);
        state.results.push(ok ? { name: info.name, ok } : { name: info.name, ok, message: failed ? `${failed.label}: ${(failed.stderr || failed.stdout).trim().slice(0, 500)}` : 'failed' });
      } catch (err: any) {
        await this.stopUnrouted(info.name);
        state.results.push({ name: info.name, ok: false, message: redactProxyUrls(String(err?.message ?? err)) });
      }
    }
  }
}
