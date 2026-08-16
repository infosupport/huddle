// ── sbx types + validators ────────────────────────────────────────────────────
// Shared shapes and input validation for the sbx passthrough (ops.ts), the pure
// rule projection (projection.ts) and reconciliation (reconcile.ts). Validation
// runs BEFORE any name/target reaches a child process argv.

export type Scope = { kind: 'global' } | { kind: 'sandbox'; name: string };

export interface CreateParams {
  name: string;
  agent?: string;
  path: string;
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
 * A policy target is a hostname, wildcard host, host:port, or CIDR — never a
 * shell string. Reject anything with shell metacharacters or whitespace.
 */
export function isValidPolicyTarget(target: unknown): target is string {
  if (typeof target !== 'string' || target.length === 0 || target.length > 253) return false;
  // Allow letters, digits, dot, hyphen, star, colon (port), slash (CIDR).
  return /^[A-Za-z0-9.\-*:/]+$/.test(target);
}
