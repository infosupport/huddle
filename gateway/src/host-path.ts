// Host paths as the gateway receives them — one choke point for Windows notation.
//
// A browser cannot hand a server a folder path, so every host path arrives as
// text: typed in the modal, typed in Settings, or clicked together in the folder
// picker from what Node listed. On Windows that text can look
// like `T:\projects\huddle`, `t:/projects/huddle` or `T:\projects\huddle\`, all
// meaning the same folder. Normalising once, on ingest, keeps the rest of the
// gateway from having to care:
//  - backslashes become forward slashes (Docker's mount `Source` and
//    toLinuxPath() in docker.ts both accept that form),
//  - a drive letter is upper-cased and repeated/trailing slashes collapse, so
//    two spellings of one folder are one string again,
//  - UNC paths (`\\server\share`) keep their leading double slash.
// Translating a host path to the path the ENGINE mounts (/mnt/<drive>/… or
// /run/desktop/mnt/host/<drive>/…) stays in docker.ts: that depends on the
// engine, not on the notation.

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
