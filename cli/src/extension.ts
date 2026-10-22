import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { get, del, uploadFile } from './api';
import { createZip, type ZipEntry } from './zip';
import { CONTAINER } from './init';
import { resolveRuntime } from './runtime';
import { printTable, dim, green, yellow } from './utils';

export interface ExtensionManifest {
  id: string;
  name: string;
  version?: string | null;
}

export interface InstalledExtension extends ExtensionManifest {
  enabled?: boolean;
}

export type InstallPlan =
  | { action: 'install' }
  | { action: 'update'; from: string }
  | { action: 'refuse'; reason: string };

const SKIPPED = new Set(['node_modules']);
export const MAX_FOLDER_DEPTH = 32;

/** The gateway's own id rule: one lowercase path component, so it can never point outside the extensions folder. */
export const isExtensionId = (id: unknown): id is string => typeof id === 'string' && /^[a-z0-9-]+$/.test(id);

/** Resolves `rel` within `root` and refuses anything that lands outside it (`..`, absolute paths). */
export function insideFolder(root: string, rel: string): string {
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  if (abs !== base && !abs.startsWith(base + path.sep)) throw new Error(`${rel} is outside the extension folder`);
  return abs;
}

/**
 * Reads a regular file of the folder; a symlink is refused, so the zip can never carry a file from outside it.
 * @param root the resolved extension folder @param rel a path relative to it, from readdir
 */
function readPlainFile(root: string, rel: string): Buffer {
  const abs = insideFolder(root, rel);
  const stat = fs.lstatSync(abs);
  if (stat.isSymbolicLink()) throw new Error(`${rel} is a symlink; extensions are packaged without symlinks`);
  if (!stat.isFile()) throw new Error(`${rel} is not a regular file`);
  return fs.readFileSync(abs);
}

/** Reads an extension folder into zip entries; the manifest must pass the gateway's own id rule. */
export function collectExtensionFiles(dir: string): { manifest: ExtensionManifest; entries: ZipEntry[] } {
  const root = path.resolve(dir);
  for (const required of ['manifest.json', 'index.js']) {
    if (!fs.lstatSync(insideFolder(root, required), { throwIfNoEntry: false })) throw new Error(`${required} missing in ${root}`);
  }
  const manifest = JSON.parse(readPlainFile(root, 'manifest.json').toString('utf8')) as ExtensionManifest;
  if (!isExtensionId(manifest.id)) {
    throw new Error(`manifest id ${JSON.stringify(manifest.id)} must be lowercase letters, digits and -`);
  }
  if (typeof manifest.name !== 'string' || !manifest.name) throw new Error('manifest name is required');
  readPlainFile(root, 'index.js');

  const entries: ZipEntry[] = [];
  const walk = (rel: string, depth: number): void => {
    if (depth > MAX_FOLDER_DEPTH) throw new Error(`${rel} is nested deeper than ${MAX_FOLDER_DEPTH} folders`);
    for (const item of fs.readdirSync(insideFolder(root, rel), { withFileTypes: true })) {
      if (item.name.startsWith('.') || SKIPPED.has(item.name)) continue;
      const childRel = rel ? `${rel}/${item.name}` : item.name;
      if (item.isSymbolicLink()) throw new Error(`${childRel} is a symlink; extensions are packaged without symlinks`);
      if (item.isDirectory()) walk(childRel, depth + 1);
      else if (item.isFile()) entries.push({ name: childRel, data: readPlainFile(root, childRel) });
    }
  };
  walk('', 0);
  return { manifest, entries };
}

/** An id already taken by an extension with another name is someone else's; only --force replaces it. */
export function planInstall(incoming: ExtensionManifest, installed: InstalledExtension[], force: boolean): InstallPlan {
  const existing = installed.find((e) => e.id === incoming.id);
  if (!existing) return { action: 'install' };
  const from = existing.version ?? 'unknown';
  if (existing.name !== incoming.name && !force) {
    return {
      action: 'refuse',
      reason: `id '${incoming.id}' belongs to "${existing.name}" (v${from}), not "${incoming.name}". Use --force to replace it.`,
    };
  }
  return { action: 'update', from };
}

/** The answer of /api/extensions, or an error when another service holds Huddle's address. */
export function asExtensionList(value: unknown): InstalledExtension[] {
  if (!Array.isArray(value)) throw new Error('could not reach Huddle: the address answered, but not with its extensions. Check HUDDLE_URL.');
  return value as InstalledExtension[];
}

export async function runExtensionList(): Promise<void> {
  const installed = asExtensionList(await get<unknown>('/api/extensions'));
  if (!installed.length) {
    console.log('No extensions installed.');
    return;
  }
  printTable(
    ['ID', 'NAME', 'VERSION', 'ENABLED'],
    installed.map((e) => [e.id, e.name, e.version ?? '-', e.enabled === false ? 'no' : 'yes']),
  );
}

export async function runExtensionInstall(dir: string, opts: { force: boolean; restart: boolean }): Promise<void> {
  const { manifest, entries } = collectExtensionFiles(dir);
  const plan = planInstall(manifest, asExtensionList(await get<unknown>('/api/extensions')), opts.force);
  if (plan.action === 'refuse') throw new Error(plan.reason);

  const result = await uploadFile<{ id: string; restartRequired: boolean }>(
    '/api/extensions/upload',
    `${manifest.id}.zip`,
    createZip(entries),
  );
  const verb = plan.action === 'update' ? `Updated ${manifest.id} v${plan.from} → v${manifest.version ?? '?'}` : `Installed ${manifest.id} v${manifest.version ?? '?'}`;
  console.log(green(`[OK] ${verb}`));

  if (!result.restartRequired) return;
  if (!opts.restart) {
    console.log(yellow('The gateway keeps running the old code until it restarts. Re-run with --restart, or restart the huddle container.'));
    return;
  }
  const rt = resolveRuntime().name;
  console.log(dim(`Restarting the gateway process (${rt} restart ${CONTAINER}); the container itself is kept.`));
  execFileSync(rt, ['restart', CONTAINER], { stdio: 'ignore' });
  console.log(green('[OK] Gateway restarted with the new extension code.'));
}

export async function runExtensionRemove(id: string): Promise<void> {
  if (!isExtensionId(id)) throw new Error(`invalid extension id: ${id}`);
  await del(`/api/extensions/${id}`);
  console.log(green(`[OK] Removed ${id}`));
}
