import fs from 'fs';
import path from 'path';
import { get, post, del } from './api';
import { bold, green, yellow, cyan, dim, printTable } from './utils';

// `huddle indexfolder` — make host folders selectable in the portal.
//
// The portal runs inside a container: it cannot open a file dialog on the host,
// so every host path had to be typed from memory. This command walks the host
// filesystem where the operator already is (their projects folder) and posts the
// folders it finds to the gateway, which stores them as an index. The portal then
// offers that index wherever a host path is needed.
//
// Deliberately a snapshot, not a live view: the gateway has no way to read the
// host filesystem, and re-running the command is cheap.

// Folders that are never a workspace choice but do contain thousands of
// subfolders. Skipping them is what keeps a scan of a projects folder in the
// hundreds rather than the tens of thousands. `--all` turns this off; hidden
// (dot) folders stay skipped either way.
const NOISE = new Set([
  'node_modules', 'dist', 'build', 'out', 'bin', 'obj', 'target', 'vendor',
  'venv', '__pycache__', 'coverage', 'packages', 'AppData', 'Library',
  '$RECYCLE.BIN', 'System Volume Information', 'Windows', 'Program Files',
  'Program Files (x86)', 'ProgramData',
]);

// Hard stop on discovery, well under the gateway's own cap. Pointing the command
// at a drive root should end in a clear warning, not a ten-minute walk.
const MAX_FOLDERS = 1500;

export interface IndexFolderOptions {
  path?: string;
  depth?: string;
  all?: boolean;
  replace?: boolean;
  clear?: boolean;
  list?: boolean;
}

interface IndexedFolder {
  id: number;
  path: string;
  label: string;
  source: string;
  created_at: number;
}

interface IndexResponse {
  added: number;
  updated: number;
  skipped: number;
  removed: number;
  invalid: { path: string; error: string }[];
  total: number;
  max: number;
}

// Host paths travel to the gateway with forward slashes: `path.resolve` hands
// back `T:\projects\app` on Windows, and the whole stack (the portal, the index,
// the Docker mount translation) speaks the forward-slash form. The gateway
// normalizes again on ingest — this is only so what we PRINT matches what gets
// stored.
function toPosix(p: string): string {
  return p.replace(/\\/g, '/').replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);
}

function parseDepth(raw: string | undefined): number {
  if (raw === undefined) return 2;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 8) {
    throw new Error(`Invalid --depth "${raw}": use a whole number between 0 and 8.`);
  }
  return n;
}

// The folder to walk comes from argv, or from wherever the operator's shell is.
// Resolving it here — once, before anything touches the filesystem — is what lets
// the rest of the command treat "the root" as one absolute, `..`-free path: the
// walk below, the containment check, and the paths posted to the gateway all
// derive from this value.
function resolveScanRoot(raw: string | undefined): string {
  const input = raw ?? process.cwd();
  // A null byte makes every fs call throw ERR_INVALID_ARG_VALUE with a stack
  // trace; say what is wrong instead.
  if (input.includes('\0')) throw new Error('Invalid folder: the path contains a null byte.');
  return path.resolve(input);
}

// Whether `candidate` is the root or sits underneath it.
function contains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

// Breadth-first so a depth cut-off keeps the folders nearest the root — those are
// the ones an operator actually mounts. Symlinks are not followed: `isDirectory()`
// is false for a symlink entry, which also rules out a link loop.
function scan(root: string, depth: number, all: boolean): { folders: string[]; truncated: boolean } {
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
        // Nothing outside the folder the operator named ever enters the index or
        // gets opened by the next round of readdirSync. Entries come from
        // readdirSync and symlinks are already skipped, so this should never
        // fire — it is here so a scan can never walk out of its root by accident.
        if (!contains(root, full)) continue;
        folders.push(full);
        next.push(full);
        if (folders.length >= MAX_FOLDERS) return { folders, truncated: true };
      }
    }
    level = next;
    if (level.length === 0) break;
  }
  return { folders, truncated: false };
}

export async function runIndexFolder(opts: IndexFolderOptions): Promise<void> {
  if (opts.list) {
    const res = await get<{ folders: IndexedFolder[]; max: number }>('/api/indexed-folders');
    if (res.folders.length === 0) {
      console.log(dim('No folders indexed yet. Run `huddle indexfolder` in your projects folder.'));
      return;
    }
    printTable(
      ['ID', 'PATH', 'SOURCE'],
      res.folders.map((f) => [String(f.id), f.path, f.source]),
    );
    console.log(dim(`\n${res.folders.length} folder(s) indexed (max ${res.max}).`));
    return;
  }

  if (opts.clear) {
    // Scoped when a folder is given, so clearing one project's entries does not
    // throw away everything else that was indexed.
    const root = opts.path ? toPosix(resolveScanRoot(opts.path)) : undefined;
    const query = root ? `?root=${encodeURIComponent(root)}` : '';
    const res = await del<{ removed: number }>(`/api/indexed-folders${query}`);
    console.log(green(`[OK] Removed ${res.removed} folder(s) from the index${root ? ` under ${cyan(root)}` : ''}.`));
    return;
  }

  const depth = parseDepth(opts.depth);
  const root = resolveScanRoot(opts.path);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(root);
  } catch {
    throw new Error(`Folder does not exist: ${root}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${root}`);

  const posixRoot = toPosix(root);
  console.log(`Indexing ${bold(posixRoot)} ${dim(`(depth ${depth}${opts.all ? ', including build folders' : ''})`)}`);
  const { folders, truncated } = scan(root, depth, opts.all === true);
  if (truncated) {
    console.log(yellow(`[!] Stopped at ${MAX_FOLDERS} folders. Index a more specific folder, or lower --depth.`));
  }

  const res = await post<IndexResponse>('/api/indexed-folders', {
    paths: folders.map(toPosix),
    root: posixRoot,
    replace: opts.replace === true,
  });

  if (res.removed) console.log(dim(`  Replaced: removed ${res.removed} earlier entr(y|ies) under this folder.`));
  console.log(green(`[OK] ${res.added} added, ${res.updated} already known — ${res.total} folder(s) in the index.`));
  if (res.skipped) {
    console.log(yellow(`[!] ${res.skipped} folder(s) skipped (index limit ${res.max} reached, or a duplicate spelling).`));
  }
  for (const bad of res.invalid.slice(0, 5)) {
    console.log(yellow(`[!] Refused ${bad.path}: ${bad.error}`));
  }
  if (res.invalid.length > 5) console.log(yellow(`[!] ...and ${res.invalid.length - 5} more refused.`));
  console.log();
  console.log('Pick these folders in the portal when starting a devcontainer,');
  console.log(`or manage the index under ${cyan('Settings > Indexed folders')}.`);
}
