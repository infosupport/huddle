// Walking the host filesystem to fill the folder index.
//
// This used to live only in the CLI (`huddle indexfolder`) because the portal
// ran in a container and could not see the host at all — the index was a
// snapshot the operator had to push from a shell. Huddle Node runs ON the host,
// so it can do the walk itself and the portal can offer a Scan button; the CLI
// command now asks Node to scan rather than walking a second implementation.
//
// Host mode only. In container mode this would happily walk the container's own
// filesystem and index paths that mean nothing on the host, so the API refuses
// there instead of returning plausible nonsense.

import fs from 'fs';
import path from 'path';

// Folders that are never a workspace choice but do contain thousands of
// subfolders. Skipping them is what keeps a scan of a projects folder in the
// hundreds rather than the tens of thousands. `all` turns this off; hidden (dot)
// folders stay skipped either way.
const NOISE = new Set([
  'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target', 'vendor',
  'venv', '__pycache__', 'coverage', 'packages', 'AppData', 'Library',
  '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData',
]);

// Hard stop on discovery, well under the index's own cap. Pointing a scan at a
// drive root should end in a clear warning, not a ten-minute walk.
export const MAX_SCAN_FOLDERS = 1500;

export const MAX_SCAN_DEPTH = 8;

export interface ScanResult {
  root: string;
  folders: string[];
  truncated: boolean;
}

// Whether `candidate` is the root or sits underneath it.
function contains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Breadth-first walk from `root`, `depth` levels deep.
 *
 * Breadth-first so the depth cut-off keeps the folders NEAREST the root — those
 * are the ones an operator actually mounts. Symlinks are not followed:
 * `isDirectory()` is false for a symlink entry, which also rules out a link loop
 * and keeps the walk inside the folder that was named.
 */
export function scanHostFolders(root: string, depth: number, all: boolean): ScanResult {
  const folders: string[] = [root];
  let level = [root];
  for (let d = 0; d < depth; d++) {
    const next: string[] = [];
    for (const dir of level) {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        continue; // unreadable folder (permissions, a vanished dir) — skip it
      }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name.startsWith('.')) continue;
        if (!all && NOISE.has(e.name)) continue;
        const full = path.join(dir, e.name);
        // Nothing outside the folder that was named ever enters the index or
        // gets opened by the next round of readdirSync. Entries come from
        // readdirSync and symlinks are already skipped, so this should never
        // fire — it is here so a scan can never walk out of its root by accident.
        if (!contains(root, full)) continue;
        folders.push(full);
        next.push(full);
        if (folders.length >= MAX_SCAN_FOLDERS) return { root, folders, truncated: true };
      }
    }
    level = next;
    if (level.length === 0) break;
  }
  return { root, folders, truncated: false };
}

/** null when the path is a readable directory, otherwise why it is not. */
export function scanRootProblem(root: string): string | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    return `does not exist on the host (${root})`;
  }
  if (!stat.isDirectory()) return `is not a folder (${root})`;
  return null;
}
