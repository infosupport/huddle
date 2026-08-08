import fs from 'fs';
import { get, post, del } from './api';
import { readConfig, writeConfig } from './config';
import { bold, dim, green, red, cyan, promptKey, formatTime, printTable } from './utils';

interface Rule {
  id: number;
  domain: string;
  container_id: string | null;
  status: 'requested' | 'allow' | 'deny';
  expires_at: number | null;
  path_pattern: string | null;
  path_mode: number;
  request_count: number;
  last_seen: number;
  last_path?: string | null;
}

export interface FirewallListOptions {
  interactive: boolean;
  container?: string;
  status?: string;
}

export async function runFirewallList(opts: FirewallListOptions): Promise<void> {
  const qs = new URLSearchParams({ status: opts.status ?? 'requested' });
  if (opts.container) qs.set('container', opts.container);

  const rules = await get<Rule[]>(`/api/rules?${qs}`);

  if (rules.length === 0) {
    console.log(dim('No pending firewall requests.'));
    return;
  }

  if (!opts.interactive) {
    printRulesTable(rules);
    return;
  }

  console.log(`${bold(String(rules.length))} pending request(s). Review each:\n`);

  for (let i = 0; i < rules.length; i++) {
    await reviewRule(rules[i], i + 1, rules.length);
    console.log();
  }
}

async function reviewRule(rule: Rule, idx: number, total: number): Promise<void> {
  const target = formatTarget(rule);
  const scope = rule.container_id ? `container: ${rule.container_id}` : 'global';
  const example = rule.last_path ? `, example: ${rule.last_path}` : '';

  console.log(
    `[${idx}/${total}] ${bold(cyan(target))}  ${dim(`(${scope}, ${rule.request_count} req, ${formatTime(rule.last_seen)}${example})`)}`
  );

  const key = await promptKey(
    `  ${bold('[a]')}llow  ${bold('[d]')}eny  ${bold('[A]')}llow global  ${bold('[D]')}eny global  ${bold('[s]')}kip > `
  );

  switch (key) {
    case 'a':
      await resolveRule(rule, 'allow', 'rule');
      console.log(green(`  [OK] Allowed for ${rule.container_id ?? 'global'}`));
      break;

    case 'd':
      await resolveRule(rule, 'deny', 'rule');
      console.log(red(`  [OK] Blocked for ${rule.container_id ?? 'global'}`));
      break;

    case 'A':
      await resolveRule(rule, 'allow', 'global');
      console.log(green(`  [OK] Allowed globally: ${target}`));
      break;

    case 'D':
      await resolveRule(rule, 'deny', 'global');
      console.log(red(`  [OK] Blocked globally: ${target}`));
      break;

    default:
      console.log(dim('  Skipped'));
  }
}

async function resolveRule(rule: Rule, status: 'allow' | 'deny', scope: 'rule' | 'global'): Promise<void> {
  await post<Rule>(`/api/rules/${rule.id}/resolve`, { status, scope });
}

export interface FirewallAddOptions {
  domain?: string;
  path?: string;
  deny: boolean;
  container?: string;
}

// Creates a custom firewall rule. Supports wildcards: `*.` in the domain
// (e.g. `*.pkgs.dev.azure.com`) and `*` in the path pattern (e.g.
// `/_packaging/*/nuget/v3/*` for an Azure DevOps feed with a changing
// GUID). Defaults to 'allow'; --deny creates a block rule. Without --container
// the rule is global.
export async function runFirewallAdd(opts: FirewallAddOptions): Promise<void> {
  const domain = (opts.domain ?? '').trim();
  if (!domain) {
    throw new Error(
      'Usage: huddle firewall add <domain> [--path <pattern>] [--deny] [--container <id>]'
    );
  }
  const status: 'allow' | 'deny' = opts.deny ? 'deny' : 'allow';
  const path = opts.path?.trim();

  const body: Record<string, unknown> = {
    domain,
    container_id: opts.container ?? null,
    status,
  };
  if (path) body.path_pattern = path;

  const rule = await post<Rule>('/api/rules', body);
  const target = formatTarget(rule);
  const scope = rule.container_id ? `container: ${rule.container_id}` : 'global';
  const verb = status === 'deny' ? red('Denied') : green('Allowed');
  console.log(`${verb} ${bold(cyan(target))} ${dim(`(${scope})`)}`);
}

export interface FirewallDeleteOptions {
  target?: string; // numeric rule id OR a domain
  container?: string; // disambiguates when target is a domain
}

// Deletes a firewall rule. Accepts the numeric id shown by `firewall list`
// (deleted directly) or a domain, which is resolved to a single rule id via a
// lookup. `--container` narrows a domain match to one scope; an ambiguous
// domain (multiple matching rules) is refused with the candidate ids so the
// caller can re-run with an exact id.
export async function runFirewallDelete(opts: FirewallDeleteOptions): Promise<void> {
  const target = (opts.target ?? '').trim();
  if (!target) {
    throw new Error('Usage: huddle firewall delete <id-or-domain> [--container <id>]');
  }

  let id: number;
  if (/^\d+$/.test(target)) {
    id = Number(target);
  } else {
    // Domain form: list all rules (optionally scoped) and resolve to one id.
    const qs = new URLSearchParams();
    if (opts.container) qs.set('container', opts.container);
    const query = qs.toString();
    const rules = await get<Rule[]>(`/api/rules${query ? `?${query}` : ''}`);
    // Hostnames are case-insensitive everywhere else in the firewall stack, so
    // match the domain case-insensitively — a rule stored as `GitHub.com` must be
    // deletable by typing `github.com`.
    const needle = target.toLowerCase();
    const matches = rules.filter((r) => r.domain.toLowerCase() === needle);
    if (matches.length === 0) {
      const scope = opts.container ? ` for container ${opts.container}` : '';
      throw new Error(`No firewall rule found for "${target}"${scope}.`);
    }
    if (matches.length > 1) {
      const ids = matches
        .map((r) => `  ${r.id}  ${r.status.padEnd(9)} ${formatTarget(r)}  ${r.container_id ?? '(global)'}`)
        .join('\n');
      throw new Error(
        `"${target}" matches ${matches.length} rules — delete by id (or narrow with --container):\n${ids}`
      );
    }
    id = matches[0].id;
  }

  await del<{ ok: true }>(`/api/rules/${id}`);
  console.log(`${green('Deleted')} rule ${bold(cyan(String(id)))}`);
}

function printRulesTable(rules: Rule[]): void {
  const headers = ['ID', 'Status', 'Domain/path', 'Container', 'Requests', 'Seen'];
  const rows = rules.map((r) => [
    String(r.id),
    r.status,
    formatTarget(r),
    r.container_id ?? '(global)',
    String(r.request_count),
    formatTime(r.last_seen),
  ]);
  printTable(headers, rows);
}

function formatTarget(rule: Rule): string {
  return rule.path_pattern ? `${rule.domain}${rule.path_pattern}` : rule.domain;
}

// ── Export / import (sharing rulesets, #69) ──────────────────────────────────

interface RulesEnvelope {
  version: number;
  exported_at: number;
  rules: unknown[];
}

interface ImportSummary {
  imported: number;
  updated: number;
  skipped: number;
}

export interface FirewallExportOptions {
  container?: string;
  out?: string;
}

export async function runFirewallExport(opts: FirewallExportOptions): Promise<void> {
  const qs = new URLSearchParams();
  if (opts.container) qs.set('container', opts.container);
  const suffix = qs.toString() ? `?${qs}` : '';
  const doc = await get<RulesEnvelope>(`/api/rules/export${suffix}`);
  const json = JSON.stringify(doc, null, 2);
  if (opts.out) {
    fs.writeFileSync(opts.out, `${json}\n`);
    // Progress to stderr so a pure `--out` run leaks nothing to stdout.
    console.error(green(`[OK] Exported ${doc.rules.length} rule(s) to ${opts.out}`));
  } else {
    console.log(json);
  }
}

// Read + JSON-parse a file with uniform, actionable errors. Shared by both
// import paths (flat rules and groups).
function readJsonFile<T = unknown>(file: string): T {
  let raw: string;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`Cannot read ${file}`); }
  try { return JSON.parse(raw) as T; } catch { throw new Error(`${file} is not valid JSON`); }
}

export interface FirewallImportOptions {
  file: string;
  replace?: boolean;
  container?: string;
}

export async function runFirewallImport(opts: FirewallImportOptions): Promise<void> {
  const doc = readJsonFile<{ rules?: unknown }>(opts.file);

  const mode = opts.replace ? 'replace' : 'merge';
  const qs = new URLSearchParams();
  if (opts.container) qs.set('container', opts.container);
  const suffix = qs.toString() ? `?${qs}` : '';

  const res = await post<ImportSummary>(`/api/rules/import${suffix}`, { mode, rules: doc.rules });
  console.error(
    green(`[OK] Imported (${mode}): ${res.imported} added, ${res.updated} updated, ${res.skipped} skipped`)
  );
}

// ── Firewall groups + team folder (#69) ──────────────────────────────────────

interface FirewallGroup {
  id: number;
  name: string;
  description: string;
  shared: number;
  source: string;
  rule_count: number;
}

async function resolveGroupByName(name: string): Promise<FirewallGroup> {
  const groups = await get<FirewallGroup[]>('/api/groups');
  const match = groups.filter((g) => g.name.toLowerCase() === name.toLowerCase());
  if (match.length === 0) throw new Error(`No group named "${name}". Run \`huddle firewall group list\`.`);
  return match[0];
}

export interface FirewallGroupOptions {
  action?: string; // list | export | import | apply
  arg?: string; // group name (export/apply) or file (import)
  out?: string;
  replace?: boolean;
  container?: string;
}

export async function runFirewallGroup(opts: FirewallGroupOptions): Promise<void> {
  const action = opts.action ?? 'list';

  if (action === 'list') {
    const groups = await get<FirewallGroup[]>('/api/groups');
    if (groups.length === 0) { console.log(dim('No firewall groups yet.')); return; }
    const headers = ['ID', 'Name', 'Rules', 'Shared', 'Source'];
    const rows = groups.map((g) => [String(g.id), g.name, String(g.rule_count), g.shared ? 'yes' : 'no', g.source]);
    printTable(headers, rows);
    return;
  }

  if (action === 'export') {
    const name = (opts.arg ?? '').trim();
    if (!name) throw new Error('Usage: huddle firewall group export <name> [--out <file>]');
    const g = await resolveGroupByName(name);
    const env = await get<unknown>(`/api/groups/${g.id}/export`);
    const json = JSON.stringify(env, null, 2);
    if (opts.out) {
      fs.writeFileSync(opts.out, `${json}\n`);
      console.error(green(`[OK] Exported group "${g.name}" to ${opts.out}`));
    } else {
      console.log(json);
    }
    return;
  }

  if (action === 'import') {
    const file = (opts.arg ?? '').trim();
    if (!file) throw new Error('Usage: huddle firewall group import <file> [--replace]');
    const envelope = readJsonFile(file);
    const mode = opts.replace ? 'replace' : 'merge';
    const res = await post<{ group: FirewallGroup; imported: number; updated: number; skipped: number }>(
      '/api/groups/import',
      { mode, envelope },
    );
    console.error(
      green(`[OK] Imported group "${res.group.name}" (${mode}): ${res.imported} added, ${res.updated} updated, ${res.skipped} skipped`),
    );
    return;
  }

  if (action === 'apply') {
    const name = (opts.arg ?? '').trim();
    if (!name) throw new Error('Usage: huddle firewall group apply <name> [--container <id>]');
    const g = await resolveGroupByName(name);
    const container = opts.container ?? null;
    const res = await post<{ applied: number; updated: number }>(`/api/groups/${g.id}/apply`, { container });
    const scope = container ? `container ${container}` : 'global';
    console.log(green(`[OK] Applied "${g.name}" to ${scope}: ${res.applied} added, ${res.updated} updated`));
    return;
  }

  throw new Error(`Unknown group action: ${action}. Use list | export | import | apply.`);
}

export interface FirewallFolderOptions {
  action?: string; // show | set | reload
  path?: string;
}

export async function runFirewallFolder(opts: FirewallFolderOptions): Promise<void> {
  const action = opts.action ?? 'show';

  if (action === 'show') {
    // The CLI config is the source of truth for the path.
    const folder = readConfig().firewallRulesFolder;
    console.log(folder ? folder : dim('(no firewall rules folder configured)'));
    return;
  }

  if (action === 'set') {
    const path = (opts.path ?? '').trim();
    if (!path) throw new Error('Usage: huddle firewall folder set <path>');
    // Config-only: the gateway reads the folder at the fixed mount point the CLI
    // binds it to; there is no DB setting. Persist here and mount on restart.
    writeConfig({ ...readConfig(), firewallRulesFolder: path });
    console.log(green(`[OK] Firewall rules folder set to ${cyan(path)}`));
    console.log(dim('  Run `huddle restart` to mount it into the gateway; it is then read on start & reload.'));
    return;
  }

  if (action === 'reload') {
    const res = await post<{ folder: string | null; mounted: boolean; files: number; groups: number; imported: number; updated: number; errors: { file: string; message: string }[] }>(
      '/api/firewall-rules-folder/reload',
      {},
    );
    if (!res.mounted) {
      console.log(dim('No firewall rules folder mounted. Set one with `huddle firewall folder set <path>` and run `huddle restart`.'));
      return;
    }
    console.log(green(`[OK] Reloaded: ${res.groups} group(s), ${res.imported} rule(s), ${res.errors.length} error(s)`));
    for (const e of res.errors) console.error(red(`  [!] ${e.file}: ${e.message}`));
    return;
  }

  throw new Error(`Unknown folder action: ${action}. Use show | set | reload.`);
}
