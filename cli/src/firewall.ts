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

// Maakt een eigen firewall-regel aan. Ondersteunt wildcards: `*.` in het domein
// (bv. `*.pkgs.dev.azure.com`) en `*` in het padpatroon (bv.
// `/_packaging/*/nuget/v3/*` voor een Azure-DevOps-feed met een wisselende
// GUID). Standaard 'allow'; met --deny een block-regel. Zonder --container is
// de regel globaal.
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
