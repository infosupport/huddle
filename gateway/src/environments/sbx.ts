// Docker Sandboxes (`sbx`) as an environment provider. Every command is an argv
// array handed to the host agent's `tool.run` (never a shell), and every value
// that ends up in that argv is validated here first. Ported from
// feat/sbx-sandboxes-rebased:gateway/src/sandbox/ops.ts, minus everything that
// needed the gateway on the host (identity, proxy, policy reconcile, SSH).

import crypto from 'crypto';
import { hostPipe, HostPipe } from '../host-pipe';
import { normalizeHostPath, hostPathError, hostPathLeaf } from '../host-path';
import {
  EnvironmentProvider,
  InvalidSpecError,
  ProviderStatus,
  SandboxCreateResult,
  SandboxInfo,
  SandboxSpec,
  ToolFailedError,
} from './types';

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
    paths.push(i > 0 && w.readOnly === true ? `${p}:ro` : p);
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
    let ws: unknown;
    if (typeof e === 'string') name = e;
    else if (e && typeof e === 'object') {
      const o = e as Record<string, unknown>;
      name = o.name ?? o.Name ?? o.vm_name ?? o.id ?? o.ID;
      status = o.status ?? o.Status ?? o.state ?? o.State;
      ws = o.workspaces ?? o.Workspaces ?? o.paths;
    }
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    seen.add(name);
    const info: SandboxInfo = { name, provider: 'sbx' };
    if (typeof status === 'string') info.status = status;
    if (Array.isArray(ws)) {
      const paths = ws
        .map((w) => (typeof w === 'string' ? w : w && typeof w === 'object' ? (w as any).path : undefined))
        .filter((p): p is string => typeof p === 'string' && !!p);
      if (paths.length) info.workspaces = paths;
    }
    out.push(info);
  }
  return out;
}

function failure(r: RunResult, fallback: string): ToolFailedError {
  return new ToolFailedError((r.stderr || r.stdout).trim() || fallback, r.code);
}

export class SbxProvider implements EnvironmentProvider {
  readonly id = 'sbx';
  readonly label = 'Docker Sandbox';

  constructor(private readonly pipe: PipeCall = hostPipe) {}

  private run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<RunResult> {
    return this.pipe.call<RunResult>('tool.run', { tool: 'sbx', args, timeoutMs }, { timeoutMs: timeoutMs + PIPE_GRACE_MS });
  }

  // Not available is an answer, not an error: sbx missing or broken on the host
  // is shown in the portal. A dead pipe is the caller's problem (503).
  async status(): Promise<ProviderStatus> {
    const base = { id: this.id, label: this.label, agents: [...SBX_AGENTS] };
    try {
      const r = await this.run(['version']);
      if (r.code !== 0) return { ...base, available: false, error: failure(r, 'sbx version failed').message };
      const version = r.stdout.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 200);
      return { ...base, available: true, version };
    } catch (err: any) {
      if (err?.code === 'host_pipe_offline') throw err;
      if (err?.code === 'tool_missing') return { ...base, available: false, error: 'sbx is not installed on the host' };
      return { ...base, available: false, error: err?.message ?? String(err) };
    }
  }

  async list(): Promise<SandboxInfo[]> {
    // Prefer --json: structured, so a header row can never pass for a sandbox.
    // Older sbx without --json: parse the table.
    const j = await this.run(['ls', '--json']);
    if (j.code === 0) return parseSbxLsJson(j.stdout) ?? parseSbxLsTable(j.stdout);
    const r = await this.run(['ls']);
    if (r.code !== 0) throw failure(r, 'sbx ls failed');
    return parseSbxLsTable(r.stdout);
  }

  async create(spec: SandboxSpec): Promise<SandboxCreateResult> {
    const first = Array.isArray(spec?.workspaces) && spec.workspaces.length ? validWorkspacePath(spec.workspaces[0]?.path) : '';
    const name = spec.name || (first ? defaultSandboxName(first) : '');
    const args = buildCreateArgs({ ...spec, name });
    const r = await this.run(args, CREATE_TIMEOUT_MS);
    return {
      name,
      ok: r.code === 0,
      steps: [{ label: 'Create sandbox', command: displayCommand(args), code: r.code, stdout: r.stdout, stderr: r.stderr }],
    };
  }

  async remove(name: string, opts: { force: boolean }): Promise<void> {
    if (!SANDBOX_NAME_RE.test(name)) throw new InvalidSpecError('invalid sandbox name');
    const r = await this.run(opts.force ? ['rm', '--force', name] : ['rm', name]);
    if (r.code !== 0) throw failure(r, 'sbx rm failed');
  }
}
