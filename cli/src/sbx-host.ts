// ── Finding sbx on the host ───────────────────────────────────────────────────
// Docker Sandboxes (`sbx`) is a HOST binary. It manages VMs/containers through
// the user's own Docker installation and it is the thing Huddle points at its
// egress proxy — it was never something the gateway container could run.
//
// This module is what remains of the sbx bridge after the split (step 5 of
// docs/ADR-huddle-node-split.md): the bridge existed only to carry argv from a
// containerized Huddle to the host and back, and Huddle Node runs on the host,
// so it exec's sbx directly. Resolving WHICH binary and keeping Windows from
// flashing a console window are still real problems, so they live on here.

import { execFileSync } from 'child_process';

/**
 * No console window per child process on Windows.
 *
 * Huddle spawns sbx often and sometimes from a detached, console-less process;
 * without this, Windows opens a terminal window for every single call.
 */
export const NO_WINDOW = { windowsHide: true } as const;

/** Resolve the host sbx binary: HUDDLE_SBX_BIN, else `sbx`, else `sbx.exe`. */
export function resolveSbxBin(): string {
  const env = process.env.HUDDLE_SBX_BIN?.trim();
  if (env) return env;
  for (const c of ['sbx', 'sbx.exe']) {
    try { execFileSync(c, ['version'], { stdio: 'ignore', timeout: 15000, ...NO_WINDOW }); return c; } catch { /* try next */ }
  }
  return 'sbx';
}
