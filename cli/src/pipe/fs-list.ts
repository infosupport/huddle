// ── Host pipe op `fs.list`: browsing the host, one folder at a time ───────────
// Replaces the old folder *index* (`huddle indexfolder`), which existed only
// because the portal runs in a container and cannot see the host: an operator
// had to walk the host from a shell and push a snapshot of folder names into the
// database. Through the host pipe the portal can just look, and a live look is
// strictly better than a snapshot that went stale the moment a folder was made.
//
// Nothing is stored and nothing walks: each call reads exactly one directory,
// which keeps a drive root cheap and a folder created five seconds ago visible.
// Port of host-browse.ts from feat/sbx-sandboxes-rebased.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { MAX_FOLDER_ENTRIES, PipeError } from './protocol';

export interface HostFolder {
  /** Absolute host path in Huddle notation ('C:/Users/me', '/home/me'). */
  path: string;
  /** The leaf to show ('me'), or the root itself ('C:', '/'). */
  name: string;
}

export interface HostFolderListing {
  /** The folder that was listed; '' for the roots. */
  path: string;
  folders: HostFolder[];
  truncated: boolean;
  max: number;
}

/**
 * A host path in Huddle notation: forward slashes, upper-case drive letter, no
 * trailing slash except on a root. One spelling for the whole system, so the
 * gateway can compare and store paths without knowing the host's platform.
 * Duplicated (on purpose) from the gateway's host-path.ts: the CLI must not
 * depend on gateway code.
 */
export function toHuddlePath(p: string, platform: NodeJS.Platform = process.platform): string {
  // A bare drive ('c:') is that drive's root here, not its current directory.
  if (platform === 'win32' && /^[A-Za-z]:$/.test(p)) return `${p.toUpperCase()}/`;
  const normalized = platform === 'win32' ? path.win32.normalize(p) : path.posix.normalize(p);
  let s = normalized.replace(/\\/g, '/');
  s = s.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
  while (s.length > 1 && s.endsWith('/') && !/^[A-Z]:\/$/.test(s)) s = s.slice(0, -1);
  return s;
}

/** Absolute in the host's own sense: '/x' on POSIX, 'C:/x' or a UNC '//server/share' on Windows. */
export function isAbsoluteHostPath(p: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') return /^[A-Za-z]:[\\/]/.test(p) || /^[\\/]{2}[^\\/]/.test(p);
  return p.startsWith('/');
}

function leaf(p: string): string {
  if (p === '/') return '/';
  if (/^[A-Z]:\/$/.test(p)) return p.slice(0, 2);
  return p.slice(p.lastIndexOf('/') + 1);
}

// Joins in Huddle notation rather than the platform's, so Windows hands back
// 'C:/projects/app' and not 'C:\projects\app'.
function joinHost(parent: string, segment: string): string {
  return parent.endsWith('/') ? `${parent}${segment}` : `${parent}/${segment}`;
}

/**
 * Where browsing starts: the drives (Windows) or `/` (elsewhere), plus the home
 * folder because that is where projects usually live and nobody wants to click
 * through /home/<user> every time.
 */
export function hostRoots(): HostFolder[] {
  const out: HostFolder[] = [];
  const seen = new Set<string>();
  const add = (p: string, name?: string): void => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, name: name ?? leaf(p) });
  };

  if (process.platform === 'win32') {
    // Probing 26 letters is a stat per letter and no slower than the WMI query
    // that answers the same question, without a dependency. A CD drive with no
    // disc exists but throws on read; it is no place for a workspace, so
    // anything unreadable is left out.
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      try {
        fs.readdirSync(`${letter}:/`);
      } catch {
        continue;
      }
      add(`${letter}:/`, `${letter}:`);
    }
  } else {
    add('/', '/');
  }

  const home = os.homedir();
  if (home) {
    try {
      if (fs.statSync(home).isDirectory()) add(toHuddlePath(home));
    } catch { /* no readable home: the drives/root above are enough */ }
  }
  return out;
}

/**
 * The immediate subfolders of `dir`, sorted case-insensitively like a file
 * dialog. Only one level: the portal asks again when it opens a folder.
 *
 * Hidden (dot) folders are included: `.config`, `.local` or a dotted worktree
 * are real places, and a picker that omits a folder the operator sees in their
 * own file manager reads as broken. Symlinked folders are included too; nothing
 * walks, so a link loop is at worst someone clicking in circles.
 *
 * Sorting happens before truncation, so a huge folder shows its first `max`
 * names alphabetically rather than an arbitrary readdir-order slice.
 */
export async function listHostFolders(dir: string, max: number = MAX_FOLDER_ENTRIES): Promise<HostFolderListing> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    throw new PipeError('not_found', `cannot read folder ${dir}: ${(err as NodeJS.ErrnoException).code ?? err}`);
  }

  const names: string[] = [];
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = (await fs.promises.stat(path.join(dir, e.name))).isDirectory();
      } catch {
        continue; // dangling link
      }
    }
    if (isDir) names.push(e.name);
  }

  names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const truncated = names.length > max;
  const folders = names.slice(0, max).map((name) => ({ path: joinHost(dir, name), name }));
  return { path: dir, folders, truncated, max };
}

/** The `fs.list` op: no path → the roots, otherwise one folder. */
export async function fsList(args: Record<string, unknown>, max: number = MAX_FOLDER_ENTRIES): Promise<HostFolderListing> {
  const raw = args.path;
  if (raw === undefined || raw === null || raw === '') {
    return { path: '', folders: hostRoots(), truncated: false, max };
  }
  if (typeof raw !== 'string') throw new PipeError('bad_request', 'path must be a string');
  if (raw.includes('\0')) throw new PipeError('bad_request', 'path contains a NUL byte');
  if (!isAbsoluteHostPath(raw)) throw new PipeError('bad_request', `not an absolute host path: ${raw}`);
  return listHostFolders(toHuddlePath(raw), max);
}
