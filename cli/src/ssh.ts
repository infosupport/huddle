import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_DIR } from './config';
import { dim } from './utils';

/**
 * Writes an SSH private key fetched from the gateway to ~/.huddle/ssh/<slug>
 * with 0600 permissions. The private key never lands anywhere else — the
 * gateway hands it over once, here, and does not keep its own copy on disk
 * (see ssh-keys.ts). Pure: no console output, so callers doing a silent
 * multi-sandbox sync (syncManagedSshConfig's caller) don't get per-key noise.
 */
export function writeSshKeyFile(slug: string, key: { privateKey: string }): string {
  const dir = path.join(CONFIG_DIR, 'ssh');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, slug);
  const pem = key.privateKey.endsWith('\n') ? key.privateKey : `${key.privateKey}\n`;
  fs.writeFileSync(keyPath, pem, { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  return keyPath;
}

/**
 * Writes the key (writeSshKeyFile) and prints a ready `ssh` connection
 * string — the single-target, interactive path (`huddle container ssh-setup
 * <name>`). Sandboxes go through syncSbxSshConfig/syncManagedSshConfig
 * instead, which manages a named Host alias rather than a raw -p/-i command.
 */
export function installSshKey(slug: string, key: { privateKey: string; port: number }, user: string): void {
  const keyPath = writeSshKeyFile(slug, key);
  console.log('✓ SSH key ready. Connect with:');
  console.log(`    ssh -p ${key.port} -i ${keyPath} ${user}@localhost`);
  console.log(dim(`  (or add it as a VS Code / JetBrains remote host)`));
}

export interface SbxSshEntry {
  name: string;
  port: number;
  keyPath: string;
  /**
   * The login user inside the sandbox. NOT root: `sbx exec` runs as `agent`
   * (uid 1000), which is also where the bootstrap script put authorized_keys —
   * this line used to say `User root`, so every generated Host block pointed at
   * a user that has no key and, on a stock image, no shell either. Huddle Node
   * discovers the real value on every start and hands it over with the key.
   */
  user: string;
}

const SSH_CONFIG_BEGIN = '# BEGIN HUDDLE SBX SSH CONFIG — managed by huddle, do not edit by hand';
const SSH_CONFIG_END = '# END HUDDLE SBX SSH CONFIG';

/** Escapes a literal string for use inside a RegExp — the markers are fixed text, not a pattern. */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The `~/.ssh/config` Host alias for a sandbox. Sandbox names commonly
 * already start with `huddle-sbx-` (the default auto-generated pattern from
 * `api.ts`'s create route, `huddle-sbx-${Date.now().toString(36)}`, and
 * apparently the create modal's own default too) — prefixing unconditionally
 * produced `huddle-sbx-huddle-sbx-<x>`, an alias that resolves to nothing
 * sbx itself recognises (confirmed live: `sbx` reported that double-prefixed
 * name as not existing, while the single-prefixed real name connected fine).
 * Only add the prefix when the name doesn't already carry it.
 */
export function sbxHostAlias(name: string): string {
  return name.startsWith('huddle-sbx-') ? name : `huddle-sbx-${name}`;
}

function renderHost(entry: SbxSshEntry, knownHostsPath: string): string {
  return [
    `Host ${sbxHostAlias(entry.name)}`,
    `  HostName localhost`,
    `  Port ${entry.port}`,
    `  User ${entry.user}`,
    `  IdentityFile ${entry.keyPath}`,
    `  IdentitiesOnly yes`,
    // sbx recycles a small host-port pool (24850-24899) across many different
    // sandboxes' lifetimes, and each fresh sandbox gets a fresh sshd host key —
    // normal host-key pinning would flag the next sandbox that lands on a given
    // port as a changed/spoofed host. A Huddle-owned known_hosts file (not the
    // user's real one, not /dev/null — that isn't a valid path on Windows)
    // keeps host-key churn contained to sandboxes only.
    `  StrictHostKeyChecking no`,
    `  UserKnownHostsFile ${knownHostsPath}`,
  ].join('\n');
}

/**
 * Replaces the Huddle-managed section of ~/.ssh/config (the real OpenSSH /
 * VS Code Remote-SSH location, not ~/.huddle/...) with one Host block per
 * entry, or removes the section entirely when entries is empty. Everything
 * outside the BEGIN/END markers is preserved byte-for-byte. Idempotent: the
 * same entries produce byte-identical file content, and the file is only
 * actually written when the computed content differs from what's on disk.
 */
export function syncManagedSshConfig(entries: SbxSshEntry[]): { path: string; count: number } {
  const sshDir = path.join(os.homedir(), '.ssh');
  const configPath = path.join(sshDir, 'config');
  fs.mkdirSync(sshDir, { recursive: true, mode: 0o700 });

  let existing = '';
  try {
    existing = fs.readFileSync(configPath, 'utf8');
  } catch {
    // No config yet — starting from an empty file is fine.
  }

  const sectionRe = new RegExp(
    `\\n?${escapeRegExp(SSH_CONFIG_BEGIN)}[\\s\\S]*?${escapeRegExp(SSH_CONFIG_END)}\\n?`,
  );
  // Collapse the blank-line seam the removed section leaves behind (its own
  // leading \n plus the blank line that used to separate it from whatever
  // came before) down to at most a single trailing newline, both at the very
  // start of the file and right where the section used to sit.
  let withoutSection = existing.replace(sectionRe, '\n').replace(/^\n+/, '').replace(/\n+$/, '\n');
  if (withoutSection === '\n') withoutSection = '';

  const knownHostsPath = path.join(CONFIG_DIR, 'ssh', 'known_hosts');
  let next = withoutSection;
  if (entries.length > 0) {
    const section = [
      SSH_CONFIG_BEGIN,
      ...entries.map((e) => renderHost(e, knownHostsPath)),
      SSH_CONFIG_END,
    ].join('\n\n');
    next = withoutSection.length > 0
      ? `${withoutSection.replace(/\n$/, '')}\n\n${section}\n`
      : `${section}\n`;
  }

  if (next !== existing) {
    fs.writeFileSync(configPath, next, { mode: 0o600 });
    try { fs.chmodSync(configPath, 0o600); } catch { /* best effort, e.g. unsupported on this platform */ }
  }

  return { path: configPath, count: entries.length };
}
