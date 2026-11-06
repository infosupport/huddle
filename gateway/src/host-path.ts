// Host paths as the gateway receives them — one choke point for Windows notation.
//
// Huddle's portal runs in a container and cannot see the host filesystem, so
// every host path arrives as text: typed in the modal, typed in Settings, or
// picked from the host folder browser (fs.list over the host pipe). On Windows that text can look
// like `T:\projects\huddle`, `t:/projects/huddle` or `T:\projects\huddle\`, all
// meaning the same folder. Normalising once, on ingest, keeps the rest of the
// gateway from having to care:
//  - backslashes become forward slashes (Docker's mount `Source` and
//    toLinuxPath() in docker.ts both accept that form),
//  - a drive letter is upper-cased and repeated/trailing slashes collapse, so
//    two spellings of one folder compare as a single folder,
//  - UNC paths (`\\server\share`) keep their leading double slash.
// Translating a host path to the path the ENGINE mounts (/mnt/<drive>/… or
// /run/desktop/mnt/host/<drive>/…) stays in docker.ts: that depends on the
// engine, not on the notation.

import { hostPipe, HostPipeError, type HostPipe } from './host-pipe';

export function normalizeHostPath(raw: string): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '';
  const unc = /^[\\/]{2}[^\\/]/.test(trimmed);
  let p = trimmed.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
  if (unc) p = `/${p}`;
  // Upper-case the drive letter: Windows treats `t:` and `T:` as one folder.
  p = p.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  // Strip a trailing slash, but never turn `C:/` or `/` into the empty string.
  if (p.length > 1 && p.endsWith('/') && !/^[A-Za-z]:\/$/.test(p)) p = p.slice(0, -1);
  return p;
}

// Everything a host path must satisfy before it is stored or mounted, as a
// human-readable complaint (null = fine). Deliberately stricter than "the OS
// would accept it": these values end up in a Docker mount spec and in the
// portal, so control characters, shell metacharacters and traversal segments are
// refused rather than normalised away. Call this on the NORMALIZED path.
export function hostPathError(p: string): string | null {
  if (!p) return 'must not be empty';
  if (p.length > 512) return 'must be at most 512 characters';
  if (/[\x00-\x1f\x7f]/.test(p)) return 'must not contain control characters';
  if (/["'`$]/.test(p)) return 'must not contain quotes, backticks or $';
  const isWindows = /^[A-Za-z]:\//.test(p);
  const isUnc = p.startsWith('//');
  if (!isWindows && !isUnc && !p.startsWith('/')) {
    return 'must be an absolute path (e.g. C:/projects/app or /home/me/app)';
  }
  const segments = p.replace(/^[A-Za-z]:/, '').split('/').filter(Boolean);
  if (segments.some((s) => s === '.' || s === '..')) return "must not contain '.' or '..' segments";
  return null;
}

// Last path segment, for a short label in the portal ('huddle' for
// 'T:/projects/huddle'). Falls back to the drive ('C:') or the path itself.
export function hostPathLeaf(p: string): string {
  const segments = p.split('/').filter(Boolean);
  return segments.length ? segments[segments.length - 1] : p;
}

// Huddle's own host folder (~/.huddle), as `huddle init` passes it in
// HUDDLE_HOST_HOME_DIR; null when the gateway was started without it. It holds
// config.json (with the operator token) and the host pipe (pipe/), which runs
// allowlisted tools on the host for whoever can write a request file. A mount
// that exposes it would hand a devcontainer or sandbox those powers, so:
//  - ~/.huddle itself and everything inside it is never mounted;
//  - a folder that contains it (the home folder, a drive root) only read-only.
// Compared case-insensitively: Windows and macOS file systems are, and on Linux
// this only over-refuses. Symlinks are not resolved here (the gateway can't see the
// host); resolvedHuddleHomeError asks the host agent for that.
export function hostHuddleHome(): string | null {
  return normalizeHostPath(process.env.HUDDLE_HOST_HOME_DIR ?? '') || null;
}

export function huddleHomeMountError(p: string, readOnly: boolean, home: string | null = hostHuddleHome()): string | null {
  if (!home) return null;
  const path = p.toLowerCase();
  const huddle = home.toLowerCase();
  const withSlash = (s: string) => (s.endsWith('/') ? s : `${s}/`);
  if (path === huddle || path.startsWith(withSlash(huddle))) {
    return `must not be Huddle's own folder (${home}) or inside it`;
  }
  if (!readOnly && huddle.startsWith(withSlash(path))) {
    return `contains Huddle's own folder (${home}), so it can only be mounted read-only`;
  }
  return null;
}

/**
 * huddleHomeMountError for where the paths really are: a workspace that is a
 * link (or junction) into ~/.huddle, or to a folder around it, passes the
 * lexical check. The host agent resolves them (`fs.resolve`). Without an agent,
 * or with one from before that op, nobody can look, and the lexical check is all
 * there is. Any other pipe failure refuses the mount.
 */
export async function resolvedHuddleHomeError(
  mounts: { path: string; readOnly: boolean }[],
  pipe: Pick<HostPipe, 'call'> = hostPipe,
  home: string | null = hostHuddleHome(),
): Promise<string | null> {
  if (!home || !mounts.length) return null;
  let resolved: unknown;
  try {
    ({ paths: resolved } = await pipe.call<{ paths: unknown }>('fs.resolve', { paths: [home, ...mounts.map((m) => m.path)] }, { timeoutMs: 10_000 }));
  } catch (err) {
    if (err instanceof HostPipeError && (err.code === 'host_pipe_offline' || err.code === 'unknown_op')) return null;
    throw err;
  }
  if (!Array.isArray(resolved) || resolved.length !== mounts.length + 1) throw new HostPipeError('internal', 'unexpected fs.resolve reply');
  const homes = typeof resolved[0] === 'string' ? [home, normalizeHostPath(resolved[0])] : [home];
  for (const [i, m] of mounts.entries()) {
    const real = resolved[i + 1];
    if (typeof real !== 'string') continue; // missing: the mount fails on its own
    const target = normalizeHostPath(real);
    for (const h of homes) {
      const problem = huddleHomeMountError(target, m.readOnly, h);
      if (problem) return `${problem}: "${m.path}" leads to ${target}`;
    }
  }
  return null;
}
