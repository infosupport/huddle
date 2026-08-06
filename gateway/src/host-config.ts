// Access to the host CLI config (`~/.huddle/config.json`), which the CLI binds
// into the gateway (read-write) at /huddle-home (#69). This makes the CLI config
// the single source of truth for the team-managed folders: the portal reads and
// writes the paths here (not the SQLite DB), and `huddle init`/`restart` reads
// the same file to mount those folders into the gateway. The gateway itself
// never needs to resolve the host paths — it reads the folders at the fixed
// mount points the CLI binds them to (see firewall-groups.ts / extensions).
import fs from 'fs';
import path from 'path';

const HOME_DIR = process.env.HUDDLE_HOME_DIR || '/huddle-home';
const CONFIG_FILE = path.join(HOME_DIR, 'config.json');

export interface HostConfig {
  firewallRulesFolder?: string;
  extensionsFolder?: string;
  [k: string]: unknown;
}

export function hostConfigAvailable(): boolean {
  try { return fs.existsSync(CONFIG_FILE); } catch { return false; }
}

export function readHostConfig(): HostConfig {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) as HostConfig;
  } catch {
    return {};
  }
}

// Merge-write a single folder key, preserving everything else in the file
// (operatorToken, channel, …). Returns false (not mounted, or write failed) so
// the caller can report the outcome — the API endpoint surfaces `persisted` to
// the operator, so no separate log line is needed here.
export function setHostFolder(key: 'firewallRulesFolder' | 'extensionsFolder', value: string): boolean {
  if (!hostConfigAvailable()) {
    return false; // config not mounted; run `huddle restart` from the host
  }
  try {
    const cfg = readHostConfig();
    const next = { ...cfg, [key]: value || undefined };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + '\n');
    return true;
  } catch {
    return false; // write failed; caller sees persisted=false
  }
}
