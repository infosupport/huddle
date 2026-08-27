// ── sbx passthrough (execFile) ────────────────────────────────────────────────
// Runs `$HUDDLE_SBX_BIN` (default `sbx`) with an argv array — NEVER a shell.
// Every name/target is validated BEFORE it reaches the process. See
// docs/sbx-cli-surface.md.
//
// sbx is a HOST binary: it drives the user's own Docker installation and Huddle
// points it at the sbx egress proxy. It is therefore reachable only from Huddle
// Node, which runs on the host. A containerized Huddle used to reach it through
// a file mailbox — the container's `sbx` was a shim that forwarded argv to a
// watcher on Windows through a bind-mounted folder. That bridge is gone (step 5
// of docs/ADR-huddle-node-split.md); this module now always execs the real
// binary, and refuses up front where that binary cannot exist.

import { execFile, spawn } from 'node:child_process';
import { runtimeEnv } from '../runtime-env';
import {
  isValidSandboxName,
  isValidPolicyTarget,
  isValidWorkspacePath,
  normalizeWorkspacePath,
  workspaceArg,
  type Scope,
  type CreateParams,
  type RemoveParams,
  type ExecParams,
  type SetProxyParams,
  type PolicyListParams,
  type PolicySetParams,
  type PolicyRemoveParams,
  type SandboxInfo,
  type PolicyRule,
} from './protocol';

export const SBX_BIN = process.env.HUDDLE_SBX_BIN ?? 'sbx';

/**
 * Why sbx cannot be used, or null when it can. Pure, so the two branches are
 * testable without reaching for the process environment.
 *
 * Only host mode can run sbx. Answering that up front rather than letting
 * execFile fail turns a confusing `'sbx' not found on PATH` — which reads like a
 * missing install — into the actual reason, with the actual fix. An explicit
 * HUDDLE_SBX_BIN is taken at face value: someone who sets it has told us where
 * the binary is, and that is not ours to second-guess.
 */
export function unavailableReason(hostMode: boolean, binOverride: string | undefined): string | null {
  if (hostMode || binOverride) return null;
  return 'sbx runs on your machine, not in the gateway container — sandboxes are managed by Huddle Node on the host (huddle node)';
}

/** unavailableReason for THIS process. */
export function sbxUnavailableReason(): string | null {
  return unavailableReason(runtimeEnv.hostMode, process.env.HUDDLE_SBX_BIN);
}
const DEFAULT_AGENT = process.env.HUDDLE_SBX_AGENT ?? 'claude';
const STEP_TIMEOUT_MS = Number(process.env.HUDDLE_SBX_TIMEOUT_MS ?? '300000');

/** Agent identifiers become an argv positional; keep them tame (no leading `-`). */
const AGENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Non-streaming run of `sbx <args>`. Resolves even on non-zero exit. */
export function runSbx(args: string[]): Promise<RunResult> {
  const blocked = sbxUnavailableReason();
  if (blocked) return Promise.resolve({ code: -1, stdout: '', stderr: blocked });
  return new Promise((resolve) => {
    execFile(
      SBX_BIN,
      args,
      { timeout: STEP_TIMEOUT_MS, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        let code = 0;
        let se = String(stderr ?? '');
        if (e) {
          if (e.code === 'ENOENT') {
            code = -1;
            se = `'${SBX_BIN}' not found on PATH`;
          } else if (e.killed) {
            // timeout / signal
            code = 124;
            if (!se) se = `sbx timed out after ${STEP_TIMEOUT_MS}ms`;
          } else if (typeof e.code === 'number') {
            code = e.code;
          } else {
            code = 1;
            if (!se) se = e.message;
          }
        }
        resolve({ code, stdout: String(stdout ?? ''), stderr: se });
      }
    );
  });
}

export type StreamChunk = (stream: 'stdout' | 'stderr', data: string) => void;

/**
 * Streaming run of `sbx <args>`: onChunk is called for stdout/stderr as it
 * arrives; resolves with the exit code and the accumulated stderr (used to
 * detect actionable failures like a stale docker login). Used by
 * sandbox.create / sandbox.exec.
 */
export function streamSbx(
  args: string[],
  onChunk: StreamChunk
): Promise<{ code: number; stderr: string }> {
  const blocked = sbxUnavailableReason();
  if (blocked) {
    onChunk('stderr', blocked);
    return Promise.resolve({ code: -1, stderr: blocked });
  }
  return new Promise((resolve) => {
    let stderrBuf = '';
    let child;
    try {
      child = spawn(SBX_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      const msg = `[spawn error] ${(err as Error).message}`;
      onChunk('stderr', msg);
      resolve({ code: -1, stderr: msg });
      return;
    }
    child.stdout.on('data', (d) => onChunk('stdout', d.toString()));
    child.stderr.on('data', (d) => {
      const s = d.toString();
      // Cap what we retain for error detection; keep the tail (errors surface last).
      stderrBuf = (stderrBuf + s).slice(-64 * 1024);
      onChunk('stderr', s);
    });
    child.on('error', (err) => {
      const isEnoent = (err as NodeJS.ErrnoException).code === 'ENOENT';
      const msg = isEnoent ? `'${SBX_BIN}' not found on PATH` : `[spawn error] ${err.message}`;
      onChunk('stderr', msg);
      resolve({ code: -1, stderr: msg });
    });
    child.on('close', (code) => resolve({ code: code ?? 0, stderr: stderrBuf }));
  });
}

// ── pure helpers (unit-tested in selftest.ts) ─────────────────────────────────

/**
 * Detect the well-known "stale / revoked docker login" failure that breaks
 * sandboxd startup, and turn it into a single actionable message. Returns null
 * when the text does not match, so callers fall back to the raw error.
 */
export function detectDockerLoginError(...texts: string[]): string | null {
  const s = texts.join('\n').toLowerCase();
  if (s.includes('invalid_grant') || s.includes('refresh token') || s.includes('login.docker.com')) {
    return 'Docker login required on the host: run `docker login` (the current Docker credentials are missing, expired, or revoked).';
  }
  return null;
}

/**
 * Parse `sbx ls` (docker-style tabwriter) into SandboxInfo[]. Defensive:
 * - Tolerates a header row (skipped) and uses its column offsets for fixed-width
 *   slicing when present (STATUS values can contain spaces, e.g. "Up 2 hours").
 * - Falls back to "first whitespace token = name, rest = status" with no header.
 * - Never throws; unknown columns are ignored.
 */
export function parseSbxLs(stdout: string): SandboxInfo[] {
  const out: SandboxInfo[] = [];
  const lines = stdout.split(/\r?\n/);
  let sawFirst = false;
  const colStarts: number[] = [];
  const colKeys: string[] = [];
  for (const rawLine of lines) {
    // rtrim only — keep leading spaces so header offsets stay meaningful.
    const line = rawLine.replace(/\s+$/, '');
    if (line.trim().length === 0) continue;
    if (!sawFirst) {
      sawFirst = true;
      const firstTok = line.trim().split(/\s+/)[0] ?? '';
      const looksLikeHeader = /^name$/i.test(firstTok) || /\bNAME\b/.test(line);
      if (looksLikeHeader) {
        const re = /\S+/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(line)) !== null) {
          colKeys.push(m[0].toLowerCase());
          colStarts.push(m.index);
        }
        continue; // header consumed, not emitted
      }
      // no header: fall through and treat this first line as data
    }
    if (colStarts.length >= 1) {
      const fields: Record<string, string> = {};
      for (let i = 0; i < colStarts.length; i++) {
        const start = colStarts[i];
        const end = i + 1 < colStarts.length ? colStarts[i + 1] : line.length;
        fields[colKeys[i]] = line.slice(start, end).trim();
      }
      const name = fields['name'] || line.trim().split(/\s+/)[0] || '';
      if (!name) continue;
      const status = fields['status'] || fields['state'] || undefined;
      out.push({ name, status: status || undefined, raw: line.trim() });
    } else {
      const trimmed = line.trim();
      const parts = trimmed.split(/\s+/);
      const name = parts[0];
      if (!name) continue;
      const status = parts.length > 1 ? parts.slice(1).join(' ') : undefined;
      out.push({ name, status, raw: trimmed });
    }
  }
  return out;
}

/**
 * Best-effort parser for `sbx policy list`. The exact output format is UNKNOWN
 * (TODO(T1.3): confirm via `sbx policy list` on the host and tighten this).
 * Strategy: scan for lines carrying an allow/deny verb, pick the first
 * host/cidr/host:port/wildcard-looking token as the target, and recognise a
 * `--sandbox <name>` / `sandbox=<name>` hint for scope.
 *
 * Returns `null` when the format is not recognisable at all (no allow/deny verb
 * anywhere in non-empty output), so the caller can degrade to [] rather than
 * surface garbage. Returns [] for genuinely empty output.
 */
export function parsePolicyList(stdout: string): PolicyRule[] | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return [];
  const rules: PolicyRule[] = [];
  let sawVerb = false;
  for (const line of lines) {
    const verbMatch = line.match(/\b(allow|deny)\b/i);
    // Skip obvious header rows that have no verb.
    if (!verbMatch) {
      if (/^(NAME|ACTION|TARGET|SCOPE|RULE|POLICY)\b/i.test(line)) continue;
      continue;
    }
    sawVerb = true;
    const action = verbMatch[1].toLowerCase() as 'allow' | 'deny';
    // Scope: an explicit sandbox hint, else global.
    let scope: Scope = { kind: 'global' };
    const sm = line.match(/(?:--sandbox\s+|sandbox[=:]\s*)([a-zA-Z0-9][a-zA-Z0-9._-]{0,63})/i);
    if (sm && isValidSandboxName(sm[1])) scope = { kind: 'sandbox', name: sm[1] };
    // Target: first token that looks like a host / wildcard / host:port / CIDR
    // (i.e. contains a dot, colon, slash or star). Excludes the verb & keywords.
    const tokens = line.split(/\s+/);
    const target = tokens.find(
      (t) =>
        t.toLowerCase() !== action &&
        t.toLowerCase() !== 'network' &&
        /[.:/*]/.test(t) &&
        isValidPolicyTarget(t)
    );
    if (!target) continue;
    rules.push({ action, target, scope });
  }
  if (!sawVerb) return null;
  return rules;
}

// ── high-level operations ─────────────────────────────────────────────────────

export async function version(): Promise<string> {
  const r = await runSbx(['version']);
  if (r.code !== 0) throwSbxError(r, 'sbx version failed');
  return r.stdout.trim();
}

export async function setProxy(p: SetProxyParams): Promise<void> {
  // proxy.sandbox (NOT proxy) keeps daemon auth/registry direct — see docs.
  const key = p.which === 'both' ? 'proxy' : p.which === 'daemon' ? 'proxy.daemon' : 'proxy.sandbox';
  const r = await runSbx(['settings', 'set', key, p.url]);
  if (r.code !== 0) throwSbxError(r, `failed to set ${key}`);
}

/**
 * argv for `sbx create --name <name> <agent> PATH [PATH...]`. Extra workspaces are
 * appended in order, each with sbx's `:ro` suffix when read-only. Duplicates are
 * dropped (the primary path wins, then first occurrence) because sbx rejects the
 * same folder twice. Pure, so the argv order is unit-testable without a real sbx.
 */
export function buildCreateArgs(p: CreateParams): string[] {
  if (!isValidSandboxName(p.name)) throw new Error(`invalid sandbox name: ${p.name}`);
  if (!isValidWorkspacePath(p.path)) throw new Error(`invalid workspace path: ${p.path}`);
  const agent = p.agent || DEFAULT_AGENT;
  if (!AGENT_RE.test(agent)) throw new Error(`invalid agent: ${agent}`);

  const primary = normalizeWorkspacePath(p.path);
  const seen = new Set([primary]);
  const extras: string[] = [];
  for (const extra of p.extraPaths ?? []) {
    if (!isValidWorkspacePath(extra?.path)) throw new Error(`invalid workspace path: ${extra?.path}`);
    const norm = normalizeWorkspacePath(extra.path);
    if (seen.has(norm)) continue;
    seen.add(norm);
    extras.push(workspaceArg({ path: norm, readOnly: extra.readOnly }));
  }
  return ['create', '--name', p.name, agent, primary, ...extras];
}

export async function create(p: CreateParams, onChunk: StreamChunk): Promise<number> {
  const args = buildCreateArgs(p);
  // proxy.sandbox (NOT proxy) so daemon auth/registry stays direct — see docs.
  if (p.proxySandbox) await setProxy({ which: 'sandbox', url: p.proxySandbox });
  const { code, stderr } = await streamSbx(args, onChunk);
  if (code !== 0) {
    const login = detectDockerLoginError(stderr);
    if (login) throw new Error(login);
  }
  return code;
}

export async function remove(p: RemoveParams): Promise<number> {
  if (!isValidSandboxName(p.name)) throw new Error(`invalid sandbox name: ${p.name}`);
  const args = ['rm'];
  if (p.force) args.push('--force');
  args.push(p.name);
  const r = await runSbx(args);
  if (r.code !== 0) {
    const login = detectDockerLoginError(r.stderr, r.stdout);
    if (login) throw new Error(login);
  }
  return r.code;
}

export async function exec(p: ExecParams, onChunk: StreamChunk): Promise<number> {
  if (!isValidSandboxName(p.name)) throw new Error(`invalid sandbox name: ${p.name}`);
  if (!Array.isArray(p.cmd) || p.cmd.length === 0 || !p.cmd.every((c) => typeof c === 'string')) {
    throw new Error('exec requires a non-empty string[] cmd');
  }
  const args = ['exec'];
  if (p.tty) args.push('-it');
  args.push(p.name, '--', ...p.cmd);
  const { code, stderr } = await streamSbx(args, onChunk);
  if (code !== 0) {
    const login = detectDockerLoginError(stderr);
    if (login) throw new Error(login);
  }
  return code;
}

export async function sshSetup(): Promise<number> {
  // TODO(T2.3): confirm exact verb (`sbx setup ssh` vs `sbx ssh setup`).
  const r = await runSbx(['setup', 'ssh']);
  if (r.code !== 0) {
    const login = detectDockerLoginError(r.stderr, r.stdout);
    if (login) throw new Error(login);
  }
  return r.code;
}

// ── policy ────────────────────────────────────────────────────────────────────

function scopeArgs(scope: Scope): string[] {
  // TODO(T0.3/T1.3): confirm the per-sandbox scope flag via `sbx policy --help`
  // (docs reference sandbox-scoped rules; `--sandbox <name>` is the best guess).
  return scope.kind === 'sandbox' ? ['--sandbox', scope.name] : [];
}

export async function policySet(p: PolicySetParams): Promise<void> {
  if (!isValidPolicyTarget(p.target)) throw new Error(`invalid policy target: ${p.target}`);
  if (p.scope.kind === 'sandbox' && !isValidSandboxName(p.scope.name)) {
    throw new Error(`invalid sandbox name: ${p.scope.name}`);
  }
  const r = await runSbx(['policy', p.action, 'network', p.target, ...scopeArgs(p.scope)]);
  if (r.code !== 0) throwSbxError(r, 'policy set failed');
}

/** An actual sbx policy rule as returned by `sbx policy ls --json` — carries the
 * rule id (needed to remove it) alongside the action/target/scope. */
export interface ActualPolicyRule extends PolicyRule {
  id: string;
}

/** Strip a trailing `:port` so sbx's `host:443` matches Huddle's bare `host`. */
function stripPort(t: string): string {
  return t.replace(/:\d+$/, '');
}

/**
 * Remove a network rule by its sbx RULE ID (from `sbx policy ls --json`):
 *   sbx policy rm network --id <id> [--sandbox <name>]
 * --sandbox scopes to that sandbox's local policy; omitted = global policy.
 */
export async function policyRemove(id: string, scope: Scope): Promise<void> {
  if (!id) throw new Error('policyRemove requires a rule id');
  const args = ['policy', 'rm', 'network', '--id', id];
  if (scope.kind === 'sandbox') {
    if (!isValidSandboxName(scope.name)) throw new Error(`invalid sandbox name: ${scope.name}`);
    args.push('--sandbox', scope.name);
  }
  const r = await runSbx(args);
  if (r.code !== 0) throwSbxError(r, 'policy rm failed');
}

/**
 * All ACTIVE, EDITABLE network rules across every scope, via `sbx policy ls --json`.
 * Schema (confirmed 2026-08-16): entries carry id, decision (allow|deny),
 * resource_type, resources[] (may include :port), scope ("global" | "sandbox:<n>")
 * / sandbox_id, editable, status. We skip non-network, non-editable (org/system),
 * and non-active rules — reconciliation must never touch those. One entry can list
 * several resources → one ActualPolicyRule each. Never throws on odd JSON.
 */
export function parsePolicyLsJson(stdout: string): ActualPolicyRule[] | null {
  const text = stdout.trim();
  if (!text) return [];
  let parsed: any;
  try { parsed = JSON.parse(text); } catch { return null; }
  let items: any[];
  if (Array.isArray(parsed)) items = parsed;
  else if (parsed && typeof parsed === 'object') items = parsed.policies ?? parsed.rules ?? parsed.items ?? parsed.network ?? [];
  else return null;
  if (!Array.isArray(items)) return null;

  const out: ActualPolicyRule[] = [];
  for (const e of items) {
    if (!e || typeof e !== 'object') continue;
    if (e.resource_type && e.resource_type !== 'network') continue;   // network rules only
    if (e.editable === false) continue;                               // never touch org/system rules
    if (e.status && e.status !== 'active') continue;
    const id = e.id ?? e.rule_id ?? e.ID;
    if (typeof id !== 'string' || !id) continue;
    const decision = e.decision ?? e.action;
    const action: 'allow' | 'deny' | null = decision === 'deny' ? 'deny' : decision === 'allow' ? 'allow' : null;
    if (!action) continue;
    let scope: Scope = { kind: 'global' };
    const sc = typeof e.scope === 'string' ? e.scope : typeof e.applies_to === 'string' ? e.applies_to : '';
    const m = /^sandbox:(.+)$/.exec(sc);
    if (m && isValidSandboxName(m[1])) scope = { kind: 'sandbox', name: m[1] };
    else if (typeof e.sandbox_id === 'string' && isValidSandboxName(e.sandbox_id)) scope = { kind: 'sandbox', name: e.sandbox_id };
    const raw = e.resources ?? e.resource ?? e.target;
    const resources: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
    for (const res of resources) {
      if (typeof res !== 'string' || !res.trim()) continue;
      out.push({ id, action, target: stripPort(res.trim().toLowerCase()), scope });
    }
  }
  return out;
}

/** All actual sbx policy rules (global + every sandbox) in one call. */
export async function policyListAll(): Promise<ActualPolicyRule[]> {
  const r = await runSbx(['policy', 'ls', '--json']);
  if (r.code !== 0) throwSbxError(r, 'sbx policy ls failed');
  const parsed = parsePolicyLsJson(r.stdout);
  if (parsed === null) {
    console.warn('[sbx] policy ls --json: unrecognised output; returning []');
    return [];
  }
  return parsed;
}

export async function list(): Promise<SandboxInfo[]> {
  // Prefer `sbx ls --json` — structured, so we never mistake the tabwriter header
  // row ("NAME  STATUS …") for a sandbox. Fall back to parsing the text table on
  // older sbx that doesn't support --json.
  const j = await runSbx(['ls', '--json']);
  if (j.code === 0) {
    const parsed = parseSandboxListJson(j.stdout);
    if (parsed !== null) return parsed;
    return parseSbxLs(j.stdout); // --json accepted but output wasn't JSON
  }
  const r = await runSbx(['ls']);
  if (r.code !== 0) throwSbxError(r, 'sbx ls failed');
  return parseSbxLs(r.stdout);
}

/**
 * Parse `sbx ls --json`. Schema is not fully pinned, so this is tolerant: accepts
 * a top-level array, or an object with a sandboxes/items/list/boxes array; reads
 * name from name/Name/vm_name/id and status from status/Status/state/State.
 * Returns null when it isn't recognisable JSON (caller falls back to the text
 * parser); [] for genuinely empty output.
 */
export function parseSandboxListJson(stdout: string): SandboxInfo[] | null {
  const t = stdout.trim();
  if (!t) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch {
    return null;
  }
  let items: any[];
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
    if (typeof e === 'string') name = e;
    else if (e && typeof e === 'object') {
      name = (e as any).name ?? (e as any).Name ?? (e as any).vm_name ?? (e as any).id ?? (e as any).ID;
      status = (e as any).status ?? (e as any).Status ?? (e as any).state ?? (e as any).State;
    }
    if (typeof name !== 'string' || !name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, status: typeof status === 'string' ? status : undefined });
  }
  return out;
}

// ── policy log ingest (sbx → Huddle discovery) ────────────────────────────────

export interface DeniedEntry {
  domain: string;
  sandbox?: string;
}

/**
 * `sbx policy log --json` — the per-sandbox traffic/deny log. Used to discover
 * what a sandbox tried to reach and was blocked, so Huddle can surface those as
 * `requested` rows to approve (the reverse of the rule projection). Returns raw
 * stdout; parsing is done by parsePolicyLogJson (kept pure/testable).
 */
export async function policyLog(scope: Scope): Promise<string> {
  if (scope.kind === 'sandbox' && !isValidSandboxName(scope.name)) {
    throw new Error(`invalid sandbox name: ${scope.name}`);
  }
  const r = await runSbx(['policy', 'log', '--json', ...scopeArgs(scope)]);
  if (r.code !== 0) throwSbxError(r, 'policy log failed');
  return r.stdout;
}

/** Reduce a value like "https://x.example.com:443/p" to the bare host "x.example.com". */
function hostOf(v: unknown): string | null {
  if (typeof v !== 'string' || !v) return null;
  let s = v.trim();
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, ''); // strip scheme
  s = s.split('/')[0].split('?')[0]; // strip path/query
  if (s.startsWith('[')) s = s.slice(1, s.indexOf(']') > 0 ? s.indexOf(']') : s.length); // ipv6
  else s = s.split(':')[0]; // strip :port
  s = s.replace(/\.$/, '').toLowerCase();
  return isValidPolicyTarget(s) && /[.:]/.test(s) ? s : null;
}

/**
 * Parse `sbx policy log --json` into the DENIED destinations. The real sbx schema
 * (confirmed 2026-08-15) is:
 *   { "blocked_hosts": [ { "host": "toonisleuk.be:80", "vm_name": "<sandbox>",
 *                          "reason": "...", "count_since": N, ... }, ... ],
 *     "allowed_hosts":  [ ... ] }
 * We take blocked_hosts (allowed_hosts already got through → not pending), strip
 * the :port off `host`, and scope each to its `vm_name`. Skips sbx-internal DNS
 * plumbing (…​.docker.internal). Falls back to a few generic shapes/JSONL so it
 * degrades instead of throwing. Never throws; returns [] on unrecognised input.
 */
export function parsePolicyLogJson(stdout: string): DeniedEntry[] {
  const text = stdout.trim();
  if (!text) return [];

  let parsed: any = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    // JSONL fallback
    const arr: any[] = [];
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim();
      if (!l) continue;
      try { arr.push(JSON.parse(l)); } catch { /* skip */ }
    }
    parsed = arr;
  }

  let candidates: any[] = [];
  let requireDecision = false;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Array.isArray(parsed.blocked_hosts)) {
    candidates = parsed.blocked_hosts; // canonical sbx shape — already "blocked"
  } else if (Array.isArray(parsed)) {
    candidates = parsed;
    requireDecision = true;
  } else if (parsed && typeof parsed === 'object') {
    candidates = parsed.events || parsed.log || parsed.entries || parsed.items || [parsed];
    requireDecision = true;
  }
  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  const out: DeniedEntry[] = [];
  const seen = new Set<string>();
  for (const e of candidates) {
    if (!e || typeof e !== 'object') continue;
    // Skip TRANSIENT blocks — "policy snapshot stale (retryable)" means sbx just
    // hadn't loaded the policy yet (it retries and usually succeeds; the host
    // often shows up in allowed_hosts moments later). Those are churn, not a
    // genuine "needs approval" — don't surface them as pending. Only real policy
    // denials (e.g. "DNS lookup blocked by proxy policy") become pending.
    const reason = typeof e.reason === 'string' ? e.reason : '';
    if (/\b(stale|retry(?:able)?|transient|pending)\b/i.test(reason)) continue;
    if (requireDecision) {
      let denied = e.blocked === true || e.allowed === false || e.denied === true;
      for (const k of ['action', 'decision', 'verdict', 'result', 'disposition', 'status', 'reason']) {
        const v = e[k];
        if (typeof v === 'string' && /\b(den(y|ied)|block(ed)?|reject(ed)?|refused)\b/i.test(v)) denied = true;
      }
      if (!denied) continue;
    }
    const host = hostOf(e.host ?? e.domain ?? e.hostname ?? e.target ?? e.destination ?? e.dest ?? e.url ?? e.address);
    if (!host) continue;
    if (host.endsWith('.docker.internal')) continue; // sbx-internal DNS plumbing, not real egress
    const vm = e.vm_name ?? e.sandbox ?? e.sandbox_name ?? e.box;
    const sandbox = typeof vm === 'string' && isValidSandboxName(vm) ? vm : undefined;
    const key = `${sandbox ?? ''}|${host}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ domain: host, sandbox });
  }
  return out;
}

// ── error helper ───────────────────────────────────────────────────────────────

/** Throw a clear error from a failed RunResult, upgrading docker-login failures. */
function throwSbxError(r: RunResult, fallback: string): never {
  const login = detectDockerLoginError(r.stderr, r.stdout);
  if (login) throw new Error(login);
  throw new Error((r.stderr || r.stdout).trim() || fallback);
}
