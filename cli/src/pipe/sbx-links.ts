// ── Host pipe op `sbx.links`: Settings → Folder mappings for a Docker Sandbox ──
// sbx mounts only the folders it is given at create, at their host path. So each
// sandbox gets two extra folders, ~/.huddle/sbx/links/<name>/rw and /ro, with one
// link per folder mapping in them (a junction on Windows, which needs no admin
// rights or developer mode; a symlink elsewhere). The gateway passes them to
// `sbx create`, ro with `:ro`, and links each one to its container path inside.
//
// Tested against sbx v0.39.0 on Windows (sbx-folder-links-poc.mjs): sbx's file
// share follows these links on the host side, `:ro` on the ro folder holds for
// what is behind them too, and a link the sandbox makes in rw itself stays inside
// the sandbox (it never appears on the host, so it cannot reach other folders).
//
// The op only (re)builds those folders. An empty list removes the sandbox's
// folder. Links in it are removed, never followed.

import fs from 'fs';
import path from 'path';
import { CONFIG_DIR } from '../config';
import { PipeError, ensurePrivateDir } from './protocol';
import { isAbsoluteHostPath, toHuddlePath } from './fs-list';

export const SBX_LINKS_DIR = path.join(CONFIG_DIR, 'sbx', 'links');

// Same rules as the gateway (environments/sbx.ts): the name is a folder name here.
const SANDBOX_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
const LINK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_LINKS = 64;

export interface SbxLinkSpec {
  id: string;
  hostPath: string;
  readOnly: boolean;
}

export interface SbxLinksResult {
  /** The sandbox's rw and ro folders as host paths, or null when it has none. */
  rw: string | null;
  ro: string | null;
  /** Mappings that were left out, with why. */
  skipped: { id: string; reason: string }[];
}

/** Removes `p` without following any link in it: a link is removed itself. */
export function removeNoFollow(p: string): void {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(p);
  } catch {
    return;
  }
  if (st.isSymbolicLink()) {
    // A junction is a directory to unlink() on some Node versions.
    try { fs.unlinkSync(p); } catch { fs.rmdirSync(p); }
  } else if (st.isDirectory()) {
    for (const e of fs.readdirSync(p)) removeNoFollow(path.join(p, e));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

function inside(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const norm = (s: string) => {
    const h = toHuddlePath(s, platform);
    return platform === 'win32' ? h.toLowerCase() : h;
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p.endsWith('/') ? p : `${p}/`);
}

function parseLinks(raw: unknown, platform: NodeJS.Platform): SbxLinkSpec[] {
  if (!Array.isArray(raw)) throw new PipeError('bad_request', 'links must be an array');
  if (raw.length > MAX_LINKS) throw new PipeError('bad_request', `at most ${MAX_LINKS} links`);
  const seen = new Set<string>();
  return raw.map((l) => {
    const { id, hostPath, readOnly } = (l ?? {}) as Record<string, unknown>;
    if (typeof id !== 'string' || !LINK_ID_RE.test(id)) throw new PipeError('bad_request', 'link id must be 1-64 letters, digits, _ or -');
    if (seen.has(id)) throw new PipeError('bad_request', `duplicate link id ${id}`);
    seen.add(id);
    if (typeof hostPath !== 'string' || hostPath.includes('\0') || !isAbsoluteHostPath(hostPath, platform)) {
      throw new PipeError('bad_request', `link ${id}: hostPath must be an absolute path`);
    }
    return { id, hostPath, readOnly: readOnly === true };
  });
}

/** The `sbx.links` op. `root` and `huddleHome` are only moved in tests. */
export function sbxLinks(
  args: Record<string, unknown>,
  root: string = SBX_LINKS_DIR,
  huddleHome: string = CONFIG_DIR,
  platform: NodeJS.Platform = process.platform,
): SbxLinksResult {
  const { name } = args;
  if (typeof name !== 'string' || !SANDBOX_NAME_RE.test(name)) throw new PipeError('bad_request', 'invalid sandbox name');
  const links = parseLinks(args.links, platform);

  // Resolved first: a mapping that is itself a link counts as where it points.
  const usable: (SbxLinkSpec & { target: string })[] = [];
  const skipped: SbxLinksResult['skipped'] = [];
  for (const l of links) {
    let target: string;
    try {
      target = fs.realpathSync(l.hostPath);
      if (!fs.statSync(target).isDirectory()) { skipped.push({ id: l.id, reason: 'not a folder' }); continue; }
    } catch {
      skipped.push({ id: l.id, reason: 'does not exist' });
      continue;
    }
    // Same rule as every mount Huddle makes (gateway host-path.ts): never
    // ~/.huddle or inside it, and a folder around it only read-only.
    if (inside(target, huddleHome, platform)) { skipped.push({ id: l.id, reason: "is Huddle's own folder or inside it" }); continue; }
    if (!l.readOnly && inside(huddleHome, target, platform)) { skipped.push({ id: l.id, reason: "contains Huddle's own folder, so only read-only" }); continue; }
    usable.push({ ...l, target });
  }

  const boxDir = path.join(root, name);
  try {
    removeNoFollow(boxDir);
    if (usable.length === 0) return { rw: null, ro: null, skipped };
    ensurePrivateDir(path.dirname(root));
    ensurePrivateDir(root);
    ensurePrivateDir(boxDir);
    const made: Record<'rw' | 'ro', string | null> = { rw: null, ro: null };
    for (const l of usable) {
      const kind = l.readOnly ? 'ro' : 'rw';
      const dir = path.join(boxDir, kind);
      if (!made[kind]) {
        fs.mkdirSync(dir, { mode: 0o700 });
        made[kind] = toHuddlePath(dir, platform);
      }
      fs.symlinkSync(l.target, path.join(dir, l.id), platform === 'win32' ? 'junction' : 'dir');
    }
    return { ...made, skipped };
  } catch (err) {
    if (err instanceof PipeError) throw err;
    throw new PipeError('internal', `could not prepare the folder links: ${(err as Error).message ?? err}`);
  }
}
