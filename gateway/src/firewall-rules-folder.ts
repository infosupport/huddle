// The team-managed firewall-rules folder (#69): the only place that touches the
// filesystem for firewall groups.
//
// Reading (reload) treats the folder as the source of truth for the groups it
// manages; writing (sync) mirrors the portal's groups back out as files a team
// keeps in Git. Envelope shape/validation lives in ./firewall-group-envelope and
// all database work in ./firewall-group-store — this module only does file I/O and
// the bookkeeping that maps files to groups.

import fs from 'fs';
import path from 'path';
import { db, listGroups, logAudit } from './db';
import { notifyStateChanged } from './events';
import { runtimeEnv } from './runtime-env';
import { readHostConfig } from './host-config';
import {
  serializeGroupEnvelope,
  validateGroupEnvelope,
  type GroupEnvelope,
} from './firewall-group-envelope';
import {
  clearFolderManagedRules,
  exportGroup,
  importGroupEnvelope,
  retagGroupAsFolderManaged,
} from './firewall-group-store';

// Where the team firewall-rules folder actually is, for THIS process.
//
// It used to be a bind mount at a fixed path inside the gateway (#69), because
// the gateway could not see the host filesystem. Huddle Node runs ON the host,
// so it reads the folder where the operator put it and the CLI config is the
// source of truth. Read per call, and read from the config rather than from an
// environment variable captured at startup: that is what makes `firewall folder
// set` (CLI or portal) take effect on the very next reload instead of on the
// next restart — and a restart would not have helped either, since `huddle init`
// reuses an already-running Node and never re-applies its environment.
//
// Empty is a normal outcome (no folder configured); the callers report it as
// "not mounted". The environment variable stays as an override for tests and for
// container mode, where nothing calls this any more.
export function firewallRulesMount(): string {
  const override = process.env.HUDDLE_FIREWALL_RULES_MOUNT?.trim();
  if (override) return override;
  if (runtimeEnv.hostMode) return readHostConfig().firewallRulesFolder?.trim() || '';
  return runtimeEnv.firewallRulesMount;
}

// The *.json entries in the folder, or null when the folder is not mounted at all
// (the operator must set the folder + `huddle restart`) — not an error; both
// callers report it as a "not mounted" hint instead.
function listEnvelopeFiles(mount: string, sorted: boolean): string[] | null {
  try {
    const files = fs.readdirSync(mount).filter((f) => f.toLowerCase().endsWith('.json'));
    return sorted ? files.sort() : files;
  } catch {
    return null;
  }
}

// A group envelope is a handful of kilobytes; the largest realistic export is
// well under a megabyte. The cap exists so a single file cannot decide how much
// memory the gateway allocates during startup.
const MAX_ENVELOPE_BYTES = 5 * 1024 * 1024;

// The ONLY way this module turns a file name into a path. Every name reaching it
// is a bare basename by construction — either straight from readdirSync() on the
// mount, or minted by groupFileSlug(), which strips a group name down to
// [a-z0-9-]. That is exactly the kind of invariant that quietly stops holding
// when someone adds a caller, and a group name is attacker-influenceable through
// the import API, so it is asserted here instead of assumed. Nothing outside this
// function joins onto the mount.
function envelopePath(mount: string, file: string): string {
  if (!file || file !== path.basename(file) || file === '.' || file === '..') {
    throw new Error(`not a plain file name: "${file}"`);
  }
  return path.join(mount, file);
}

function readEnvelopeFile(mount: string, file: string): GroupEnvelope {
  const full = envelopePath(mount, file);
  // lstat, not stat: a symlink has to be rejected on its own terms, BEFORE it is
  // opened. Following one lets a file in the team folder decide what the gateway
  // reads — `evil.json -> /dev/zero` makes readFileSync consume memory until it
  // dies, and since reloadFirewallRulesFolder() runs during API startup that
  // hangs the gateway rather than one request. A symlink to somewhere outside the
  // folder would also read a file the operator never put there.
  const stat = fs.lstatSync(full);
  if (!stat.isFile()) throw new Error('not a regular file (symlinks and directories are not read)');
  if (stat.size > MAX_ENVELOPE_BYTES) {
    throw new Error(`is ${stat.size} bytes, over the ${MAX_ENVELOPE_BYTES}-byte limit for a group file`);
  }
  return validateGroupEnvelope(JSON.parse(fs.readFileSync(full, 'utf8')));
}

// ── Reload: folder → portal ─────────────────────────────────────────────────────
//
// Reads every *.json file in the configured folder as a group envelope and loads
// it with source='startup-folder'. Idempotent: startup-folder groups/rules that
// no longer appear in the folder are removed first, so the folder is the single
// source of truth for the rules it manages. Manual (UI/API) groups are untouched.

export interface FolderReloadSummary {
  folder: string | null;
  mounted: boolean;
  files: number;
  groups: number;
  imported: number;
  updated: number;
  errors: { file: string; message: string }[];
}

// Read + validate EVERY file before the caller touches the live policy. A single
// malformed/unreadable file must not wipe the last-good team rules, so the caller
// aborts when this reports any error — leaving the previous startup-folder state
// intact — and reports what to fix.
function parseEnvelopeFiles(mount: string, entries: string[], summary: FolderReloadSummary): { file: string; env: GroupEnvelope }[] {
  const parsed: { file: string; env: GroupEnvelope }[] = [];
  for (const file of entries) {
    summary.files++;
    try {
      parsed.push({ file, env: readEnvelopeFile(mount, file) });
    } catch (err) {
      summary.errors.push({ file, message: (err as Error).message });
    }
  }
  return parsed;
}

// Clear the previous startup-folder state and import the fresh set inside a
// SINGLE transaction. Import can still throw at runtime (e.g. a folder group name
// colliding with a manual/system group), so wrapping clear+import together means
// any such failure rolls the whole thing back and preserves the last-good policy
// instead of leaving it half-cleared. Throws on failure; the caller reports it.
function applyParsedEnvelopes(parsed: { file: string; env: GroupEnvelope }[], summary: FolderReloadSummary): void {
  const apply = db.transaction(() => {
    clearFolderManagedRules();
    for (const { file, env } of parsed) {
      try {
        const res = importGroupEnvelope(env, { mode: 'replace', source: 'startup-folder', addedBy: 'team-folder' });
        summary.groups++;
        summary.imported += res.imported;
        summary.updated += res.updated;
      } catch (err) {
        throw new Error(`${file}: ${(err as Error).message}`);
      }
    }
  });
  apply();
}

export function reloadFirewallRulesFolder(): FolderReloadSummary {
  const mount = firewallRulesMount();
  const summary: FolderReloadSummary = { folder: mount, mounted: false, files: 0, groups: 0, imported: 0, updated: 0, errors: [] };

  const entries = listEnvelopeFiles(mount, true);
  if (entries === null) return summary;
  summary.mounted = true;

  const parsed = parseEnvelopeFiles(mount, entries, summary);
  if (summary.errors.length > 0) {
    logAudit({
      containerId: null,
      domain: 'firewall',
      action: 'admin:folder-reload-aborted',
      path: `mount=${mount} files=${summary.files} errors=${summary.errors.length} (previous policy kept)`,
    });
    return summary;
  }

  try {
    applyParsedEnvelopes(parsed, summary);
  } catch (err) {
    // Rolled back — nothing was changed, the last-good policy is preserved.
    summary.groups = 0;
    summary.imported = 0;
    summary.updated = 0;
    summary.errors.push({ file: '(reload aborted)', message: (err as Error).message });
    logAudit({
      containerId: null,
      domain: 'firewall',
      action: 'admin:folder-reload-aborted',
      path: `mount=${mount} files=${summary.files} error=${(err as Error).message} (previous policy kept)`,
    });
    notifyStateChanged();
    return summary;
  }

  logAudit({
    containerId: null,
    domain: 'firewall',
    action: 'admin:folder-reload',
    path: `mount=${mount} files=${summary.files} groups=${summary.groups} imported=${summary.imported} errors=${summary.errors.length}`,
  });
  notifyStateChanged();
  return summary;
}

// ── Sync: portal → folder ───────────────────────────────────────────────────────
//
// The reverse of reloadFirewallRulesFolder: writes every current group to the
// folder as a `<slug>.json` envelope, so the folder mirrors what's in the portal.
// Requires the folder to be writable by the account Huddle Node runs as — a
// read-only folder is surfaced via the per-file errors / writable flag rather
// than thrown. A synced group becomes folder-managed
// (source='startup-folder') so the next reload updates it in place instead of
// aborting on the "don't overwrite a manual group from the folder" guard.

export interface FolderSyncSummary {
  folder: string | null;
  mounted: boolean;
  writable: boolean;
  written: number;
  pruned: number;
  files: { file: string; group: string }[];
  errors: { file: string; message: string }[];
}

// Derive a filesystem-safe basename from a group name (lowercase, only [a-z0-9-]).
function groupFileSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'group';
}

// Map each existing group-envelope file to the group name it holds, so a group's
// current file is overwritten in place even when its slug differs (e.g. an
// existing `nodejs.json` for the group "Node.js"). Files that don't parse as an
// envelope are left completely alone — never rewritten or pruned.
function mapFilesByGroupName(mount: string, files: string[]): Map<string, string> {
  const fileByGroupName = new Map<string, string>();
  for (const f of files) {
    try {
      fileByGroupName.set(readEnvelopeFile(mount, f).group.name.toLowerCase(), f);
    } catch {
      /* not a recognisable group envelope — leave it untouched */
    }
  }
  return fileByGroupName;
}

// The file a group should be written to: the one that already holds it, or a fresh
// name minted from its slug, avoiding a clash with any existing file or one
// already written this run.
function pickGroupFile(
  groupName: string,
  fileByGroupName: Map<string, string>,
  existing: string[],
  usedFiles: Set<string>,
): string {
  const held = fileByGroupName.get(groupName.toLowerCase());
  if (held) return held;
  const base = groupFileSlug(groupName);
  let file = `${base}.json`;
  let n = 2;
  while (existing.includes(file) || usedFiles.has(file)) file = `${base}-${n++}.json`;
  return file;
}

// Write one group out and re-tag it as folder-managed. Records the outcome on the
// summary — a read-only mount fails every write here, and the caller reports how
// to fix it rather than aborting the whole sync.
function writeGroupFile(mount: string, file: string, groupName: string, groupId: number, env: GroupEnvelope, summary: FolderSyncSummary): void {
  try {
    fs.writeFileSync(envelopePath(mount, file), serializeGroupEnvelope(env));
    summary.writable = true;
    summary.written++;
    summary.files.push({ file, group: groupName });
    retagGroupAsFolderManaged(groupId);
  } catch (err) {
    summary.errors.push({ file, message: (err as Error).message });
  }
}

// Prune envelope files whose group no longer exists so the folder mirrors the
// current set — otherwise a group deleted in the portal would resurrect on the
// next reload. Only recognised envelopes are ever removed; unrelated files stay.
function pruneOrphanEnvelopes(
  mount: string,
  fileByGroupName: Map<string, string>,
  currentNames: Set<string>,
  usedFiles: Set<string>,
  summary: FolderSyncSummary,
): void {
  for (const [lname, f] of fileByGroupName) {
    if (currentNames.has(lname) || usedFiles.has(f)) continue;
    try {
      fs.unlinkSync(envelopePath(mount, f));
      summary.pruned++;
    } catch (err) {
      summary.errors.push({ file: f, message: (err as Error).message });
    }
  }
}

export function syncGroupsToFolder(): FolderSyncSummary {
  const mount = firewallRulesMount();
  const summary: FolderSyncSummary = { folder: mount, mounted: false, writable: false, written: 0, pruned: 0, files: [], errors: [] };

  const existing = listEnvelopeFiles(mount, false);
  if (existing === null) return summary;
  summary.mounted = true;

  const fileByGroupName = mapFilesByGroupName(mount, existing);
  const allGroups = listGroups();
  const currentNames = new Set(allGroups.map((g) => g.name.toLowerCase()));
  const usedFiles = new Set<string>();

  for (const g of allGroups) {
    const env = exportGroup(g.id);
    if (!env) continue;
    const file = pickGroupFile(g.name, fileByGroupName, existing, usedFiles);
    usedFiles.add(file);
    writeGroupFile(mount, file, g.name, g.id, env, summary);
  }

  pruneOrphanEnvelopes(mount, fileByGroupName, currentNames, usedFiles, summary);

  logAudit({
    containerId: null,
    domain: 'firewall',
    action: 'admin:folder-sync',
    path: `mount=${mount} written=${summary.written} pruned=${summary.pruned} errors=${summary.errors.length}`,
  });
  notifyStateChanged();
  return summary;
}
