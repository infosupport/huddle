// Browsing the host filesystem, one folder at a time.
//
// This replaces the folder *index* (#69's `huddle indexfolder`), which existed
// only because the portal ran in a container: it could not see the host, so an
// operator had to walk the host from a shell and push a snapshot of the folder
// names into the database. Huddle Node runs ON the host, so it can just look —
// and a live look is strictly better than a snapshot, which was stale the moment
// a folder was created or renamed.
//
// Nothing is stored. Each call reads exactly one directory, which is what keeps
// browsing a drive root cheap and a folder created five seconds ago visible.
//
// Host mode only. In container mode this would list the container's own
// filesystem and hand back paths that mean nothing on the host, so the API
// refuses there rather than returning plausible nonsense.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostPathLeaf } from './host-path';

export interface HostFolder {
  /** Absolute host path, normalized the way host-path.ts stores them. */
  path: string;
  /** The segment to show ('huddle'), or the root itself ('C:', '/'). */
  name: string;
}

// One directory can hold a lot of entries; a mail spool or a cache directory can
// hold a hundred thousand. Listing is per folder now, so this only has to bound
// one readdir — and a folder with more than this many subfolders is not one you
// pick a workspace from by scrolling.
export const MAX_FOLDER_ENTRIES = 2000;

export interface HostFolderListing {
  path: string;
  folders: HostFolder[];
  truncated: boolean;
}

/**
 * Where browsing starts: the drives (Windows) or `/` (POSIX), plus the home
 * folder because that is where projects usually live and nobody wants to click
 * through `/home/<user>` every time.
 */
export function hostRoots(): HostFolder[] {
  const out: HostFolder[] = [];
  const seen = new Set<string>();
  const add = (p: string, name?: string): void => {
    const key = p.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: p, name: name ?? hostPathLeaf(p) });
  };

  if (process.platform === 'win32') {
    // Probing 26 letters is a stat per letter and no slower than the WMI query
    // that would answer the same question, and it needs no extra dependency.
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i);
      // A CD drive with no disc in it exists but throws on read; it is not a
      // place to put a workspace, so anything unreadable is left out.
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

  const home = normalizeSlashes(os.homedir());
  if (home) {
    try {
      if (fs.statSync(home).isDirectory()) add(home);
    } catch { /* no readable home — the drives/root above are enough */ }
  }
  return out;
}

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * The immediate subfolders of `dir`, sorted the way a file dialog sorts them.
 *
 * Only one level: the caller asks again when it opens a folder. That is what
 * makes this affordable on a drive root, and it is why there is no depth
 * parameter to get wrong.
 *
 * Hidden (dot) folders are included. They were left out at first on the theory
 * that they are configuration rather than workspaces, which is wrong often
 * enough to matter — `.config`, `.local`, a dotted worktree — and a picker that
 * silently omits a folder the operator can see in their own file manager reads
 * as broken, not as tidy.
 *
 * Symlinked folders are included (they are ordinary folders to whoever made
 * them), which is safe here in a way it was not for the old recursive scan:
 * nothing walks, so a link loop is at worst a user clicking in circles.
 */
export function listHostFolders(dir: string): HostFolderListing {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return { path: dir, folders: [], truncated: false };
  }

  const folders: HostFolder[] = [];
  let truncated = false;
  for (const e of entries) {
    let isDir = e.isDirectory();
    if (!isDir && e.isSymbolicLink()) {
      try {
        isDir = fs.statSync(path.join(dir, e.name)).isDirectory();
      } catch {
        continue; // dangling link
      }
    }
    if (!isDir) continue;
    if (folders.length >= MAX_FOLDER_ENTRIES) { truncated = true; break; }
    folders.push({ path: joinHost(dir, e.name), name: e.name });
  }

  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  return { path: dir, folders, truncated };
}

// Joins in the portal's notation rather than the platform's, so a Windows Node
// hands back 'C:/projects/app' and not 'C:\projects\app' — the whole point of
// host-path.ts is that one spelling reaches the rest of the system.
function joinHost(parent: string, segment: string): string {
  return parent.endsWith('/') ? `${parent}${segment}` : `${parent}/${segment}`;
}

/** null when the path is a readable directory on this host, otherwise why not. */
export function hostFolderProblem(dir: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(dir);
  } catch {
    return `does not exist on the host (${dir})`;
  }
  if (!stat.isDirectory()) return `is not a folder (${dir})`;
  return null;
}
