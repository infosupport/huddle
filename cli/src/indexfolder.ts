import path from 'path';
import { get, post, del } from './api';
import { bold, green, yellow, cyan, dim, printTable } from './utils';

// `huddle indexfolder` — make host folders selectable in the portal.
//
// The walk itself lives in Huddle Node (gateway/src/host-scan.ts), which runs on
// the host and can read the filesystem directly. This command only resolves the
// folder from the operator's shell — `huddle indexfolder` with no argument means
// "here", and only the shell knows where that is — and asks Node to scan it.
// The portal has a Scan button that calls the same endpoint.

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
  root: string;
  truncated: boolean;
  scanMax: number;
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
  // A null byte makes every filesystem call throw ERR_INVALID_ARG_VALUE with a
  // stack trace; say what is wrong instead.
  if (input.includes('\0')) throw new Error('Invalid folder: the path contains a null byte.');
  return path.resolve(input);
}

// Whether `candidate` is the root or sits underneath it.
function contains(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
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
  // Resolved here, against the shell's cwd, so `huddle indexfolder` with no
  // argument still means "this folder". Everything after this is an absolute
  // path Node can act on without knowing where the CLI was run.
  const posixRoot = toPosix(resolveScanRoot(opts.path));

  console.log(`Indexing ${bold(posixRoot)} ${dim(`(depth ${depth}${opts.all ? ', including build folders' : ''})`)}`);
  const res = await post<IndexResponse>('/api/indexed-folders/scan', {
    path: posixRoot,
    depth,
    all: opts.all === true,
    replace: opts.replace === true,
  });
  if (res.truncated) {
    console.log(yellow(`[!] Stopped at ${res.scanMax} folders. Index a more specific folder, or lower --depth.`));
  }

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
