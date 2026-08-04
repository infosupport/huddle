import fs from 'fs';
import { get, post } from './api';
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

export interface FirewallImportOptions {
  file: string;
  replace?: boolean;
  container?: string;
}

export async function runFirewallImport(opts: FirewallImportOptions): Promise<void> {
  let raw: string;
  try {
    raw = fs.readFileSync(opts.file, 'utf8');
  } catch {
    throw new Error(`Cannot read ${opts.file}`);
  }
  let doc: { rules?: unknown };
  try {
    doc = JSON.parse(raw) as { rules?: unknown };
  } catch {
    throw new Error(`${opts.file} is not valid JSON`);
  }

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
    let raw: string;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`Cannot read ${file}`); }
    let envelope: unknown;
    try { envelope = JSON.parse(raw); } catch { throw new Error(`${file} is not valid JSON`); }
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
    const s = await get<{ firewallRulesFolder?: string }>('/api/settings');
    console.log(s.firewallRulesFolder ? s.firewallRulesFolder : dim('(no firewall rules folder configured)'));
    return;
  }

  if (action === 'set') {
    const path = (opts.path ?? '').trim();
    if (!path) throw new Error('Usage: huddle firewall folder set <path>');
    await post('/api/settings', { firewallRulesFolder: path });
    console.log(green(`[OK] Firewall rules folder set to ${cyan(path)} (re-read now and on startup)`));
    return;
  }

  if (action === 'reload') {
    const res = await post<{ folder: string | null; files: number; groups: number; imported: number; updated: number; errors: { file: string; message: string }[] }>(
      '/api/firewall-rules-folder/reload',
      {},
    );
    if (!res.folder) { console.log(dim('No firewall rules folder configured. Use `huddle firewall folder set <path>`.')); return; }
    console.log(green(`[OK] Reloaded ${res.folder}: ${res.groups} group(s), ${res.imported} rule(s), ${res.errors.length} error(s)`));
    for (const e of res.errors) console.error(red(`  [!] ${e.file}: ${e.message}`));
    return;
  }

  throw new Error(`Unknown folder action: ${action}. Use show | set | reload.`);
}
