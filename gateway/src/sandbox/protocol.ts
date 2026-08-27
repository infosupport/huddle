// ── sbx types + validators ────────────────────────────────────────────────────
// Shared shapes and input validation for the sbx passthrough (ops.ts), the pure
// rule projection (projection.ts) and reconciliation (reconcile.ts). Validation
// runs BEFORE any name/target reaches a child process argv.

export type Scope = { kind: 'global' } | { kind: 'sandbox'; name: string };

/**
 * One host folder to bind into a sandbox. sbx mounts every workspace INSIDE the
 * sandbox at the same path it has on the host (`sbx create AGENT PATH [PATH...]`),
 * so — unlike a devcontainer mount — there is no container path to choose here.
 * `readOnly` appends the `:ro` suffix sbx documents for extra workspaces.
 */
export interface WorkspaceSpec {
  path: string;
  readOnly?: boolean;
}

export interface CreateParams {
  name: string;
  agent?: string;
  /** The primary workspace — the folder the agent starts in. */
  path: string;
  /** Extra folders, appended after the primary path (each may be read-only). */
  extraPaths?: WorkspaceSpec[];
  proxySandbox?: string;
}

export interface RemoveParams {
  name: string;
  force?: boolean;
}

export interface ExecParams {
  name: string;
  cmd: string[];
  tty?: boolean;
}

export interface SetProxyParams {
  which: 'sandbox' | 'daemon' | 'both';
  url: string;
}

export interface PolicyListParams {
  scope: Scope;
}

export interface PolicySetParams {
  scope: Scope;
  action: 'allow' | 'deny';
  target: string;
}

export interface PolicyRemoveParams {
  scope: Scope;
  target: string;
}

export interface SandboxInfo {
  name: string;
  status?: string;
  raw?: string;
}

export interface PolicyRule {
  action: 'allow' | 'deny';
  target: string;
  scope: Scope;
}

// ── validation helpers ────────────────────────────────────────────────────────

/** Sandbox names must be tame: they become argv to `sbx` and keys in the DB. */
export const SANDBOX_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export function isValidSandboxName(name: unknown): name is string {
  return typeof name === 'string' && SANDBOX_NAME_RE.test(name);
}

/**
 * A workspace path is a HOST path (Windows or POSIX) that becomes an argv
 * positional for `sbx create`. It is never passed through a shell, so the checks
 * here are about the two ways a path could still break out of its slot:
 *   - a leading `-` would be read by sbx as a flag;
 *   - a newline would split the argument in two, because the container-side `sbx`
 *     is a file mailbox that writes argv ONE ARGUMENT PER LINE (bridge/sbx.sh).
 * `|` is rejected as well: it is the field separator of the settings-folder link
 * script (sandbox/settings-folders.ts).
 */
export function isValidWorkspacePath(p: unknown): p is string {
  if (typeof p !== 'string') return false;
  const s = p.trim();
  if (!s || s.length > 4096) return false;
  if (s.startsWith('-')) return false;
  return !/[\r\n\u0000|]/.test(s);
}

/**
 * Trim a workspace path and drop ONE trailing separator, so `C:\proj\` and
 * `C:\proj` dedupe to the same entry. A bare root (`/`, `C:\`) keeps its
 * separator — stripping it would leave an empty path or a bare drive letter.
 */
export function normalizeWorkspacePath(p: string): string {
  const s = p.trim();
  if (s.length <= 1) return s;
  const stripped = s.slice(0, -1);
  if (!/[/\\]$/.test(s)) return s;
  if (stripped === '' || stripped.endsWith(':')) return s;
  return stripped;
}

/** `PATH` or `PATH:ro` — the read-only workspace suffix sbx documents. */
export function workspaceArg(spec: WorkspaceSpec): string {
  const p = normalizeWorkspacePath(spec.path);
  return spec.readOnly ? `${p}:ro` : p;
}

/**
 * A policy target is a hostname, wildcard host, host:port, or CIDR — never a
 * shell string. Reject anything with shell metacharacters or whitespace.
 */
export function isValidPolicyTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0 || target.length > 253) return false;
  // Allow letters, digits, dot, hyphen, star, colon (port), slash (CIDR).
  return /^[A-Za-z0-9.\-*:/]+$/.test(target);
}
