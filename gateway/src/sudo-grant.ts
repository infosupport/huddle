// ── Ephemeral admin grants for the 'noot' user ───────────────────────────────
// Besides the regular dev user `vscode`, every managed devcontainer has a
// separate admin user `noot` (member of the sudo/wheel group). `noot` is LOCKED
// by default without a usable password: only when the operator grants admin
// access do we set a FRESH random password, unlock the account for a bounded
// duration, and show that password exactly once. On expiry (sweeper) or revoke
// the account is locked again. This way permanent admin credentials never exist
// (finding #10).
//
// The docker-exec boundary is injected (ContainerExec) so this logic can be
// unit-tested without a live docker daemon.

import crypto from 'crypto';
import { setSudoGrant, deleteSudoGrant, getExpiredSudoGrants } from './db';

export const NOOT_USER = 'noot';

// Result of an exec in the container. `exitCode` is null if the daemon returned
// no code (in which case we treat it as a failure when setting the password).
export interface ExecResult {
  exitCode: number | null;
  stdout?: string;
}

// Injectable exec boundary: runs `cmd` (execve array, NO shell) as root in the
// container and pipes `stdin` to the process. The real implementation lives in
// docker.ts (execInContainer); tests pass a mock.
export type ContainerExec = (containerName: string, cmd: string[], stdin: string) => Promise<ExecResult>;

// Strong random password: 18 bytes ≈ 144 bits of entropy, base64url so it can be
// passed as text without any quoting/injection risk.
export function generateNootPassword(): string {
  return crypto.randomBytes(18).toString('base64url');
}

// `chpasswd` reads `user:password` lines from stdin. The password is therefore
// NEVER passed as a shell argument (no injection, not visible in the process list).
export function chpasswdCmd(): string[] {
  return ['chpasswd'];
}

export function chpasswdStdin(password: string): string {
  return `${NOOT_USER}:${password}\n`;
}

// Unlock command (execve array, fixed arguments — no interpolation).
export function unlockCmd(): string[] {
  return ['usermod', '-U', NOOT_USER];
}

// Lock + make the password unusable. All arguments are constant; `sh -c`
// contains no caller input whatsoever, so there is no injection vector. `passwd -l`
// prefixes the hash field with '!', `passwd -e` forces expiry, and the
// `usermod -L` fallback covers distros without `passwd -l`.
export function lockCmd(): string[] {
  return ['sh', '-c', `usermod -L ${NOOT_USER} 2>/dev/null; passwd -l ${NOOT_USER} 2>/dev/null; passwd -e ${NOOT_USER} 2>/dev/null; true`];
}

// Grant admin access: set a fresh password + unlock in the container and only
// store the grant on success. FAIL CLOSED — if the chpasswd exec fails we throw
// and NO active grant is stored (no false "success").
export async function grantSudo(
  containerName: string,
  minutes: number,
  exec: ContainerExec,
  now: number = Date.now(),
): Promise<{ password: string; until: number }> {
  const password = generateNootPassword();
  const set = await exec(containerName, chpasswdCmd(), chpasswdStdin(password));
  if (set.exitCode !== 0) {
    throw new Error(`could not set noot password (exit ${set.exitCode})`);
  }
  // chpasswd usually already unlocks the account by overwriting the hash field;
  // usermod -U is the explicit unlock. Best-effort: on an already-unlocked account
  // usermod returns a non-zero code, which must not make the grant fail.
  try { await exec(containerName, unlockCmd(), ''); } catch { /* best-effort */ }
  const until = Math.floor(now / 1000) + minutes * 60;
  setSudoGrant(containerName, until);
  return { password, until };
}

// Revoke admin access immediately: lock the account (best-effort — the container
// may already be gone) and delete the grant row regardless.
export async function revokeSudo(containerName: string, exec: ContainerExec): Promise<void> {
  try {
    await exec(containerName, lockCmd(), '');
  } catch {
    /* container may have disappeared — clean up the grant anyway */
  }
  deleteSudoGrant(containerName);
}

// Active sweep: lock every container with an expired grant and clean up the row.
// Best-effort per container so that one disappeared/unreachable container does not
// block the rest. Returns the containers that were successfully locked (handy for
// logging/tests).
export async function sweepExpiredSudoGrants(
  exec: ContainerExec,
  now: number = Date.now(),
): Promise<string[]> {
  const nowSec = Math.floor(now / 1000);
  const expired = getExpiredSudoGrants(nowSec);
  const locked: string[] = [];
  for (const containerName of expired) {
    try {
      const res = await exec(containerName, lockCmd(), '');
      if (res.exitCode === 0) locked.push(containerName);
    } catch {
      /* container gone/unreachable — clean up anyway */
    }
    deleteSudoGrant(containerName);
  }
  return locked;
}
