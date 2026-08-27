// ── `huddle sbx` — Docker Sandboxes command group ─────────────────────────────
// Thin client: every subcommand just calls the gateway's /api/sbx/* endpoints
// (same role the rest of the CLI plays). The gateway talks to the native
// host-agent over the volume-mapped socket; nothing sbx-related runs here.

import { get, post, del } from './api';
import { dim } from './utils';

interface SbxStatus {
  available: boolean;
  version: string;
  error?: string;
  socket: string | null;
  upstreamUrl: string;
  proxyPort: number;
}
interface SbxStep { label: string; command: string; code: number; stdout: string; stderr: string }
interface SbxStartResult { name: string; ok: boolean; upstreamUrl: string; proxyPort: number; steps: SbxStep[] }
interface SandboxInfo { name: string; status?: string; raw?: string }
interface ReconcileAction { op: 'create' | 'delete'; action: 'allow' | 'deny'; target: string; scope: { kind: string; name?: string }; ok: boolean; error?: string }
interface SkippedRule { domain: string; container_id: string | null; reason: string }
interface ReconcileReport {
  ok: boolean; dryRun: boolean; desired: number; created: number; deleted: number; failed: number;
  actions: ReconcileAction[]; notProjected: SkippedRule[]; skipped: SkippedRule[]; sandboxes: string[]; error?: string;
}

function scopeLabel(scope: { kind: string; name?: string }): string {
  return scope.kind === 'sandbox' && scope.name ? `sandbox:${scope.name}` : 'global';
}

export async function runSbxStatus(): Promise<void> {
  const s = await get<SbxStatus>('/api/sbx/status');
  console.log(`Sandbox (sbx) mode`);
  console.log(`  host-agent socket:  ${s.socket ?? dim('(not reachable)')}`);
  console.log(`  upstream proxy:     ${s.upstreamUrl}  ${dim(`(port ${s.proxyPort})`)}`);
  if (s.available) {
    console.log(`  sbx:                ready — ${s.version}`);
  } else {
    console.log(`  sbx:                unavailable`);
    if (s.error) console.log(dim(`  reason:             ${s.error}`));
  }
}

export async function runSbxList(): Promise<void> {
  const { sandboxes } = await get<{ sandboxes: SandboxInfo[] }>('/api/sbx/sandboxes');
  if (!sandboxes.length) {
    console.log(dim('No sandboxes.'));
    return;
  }
  const nameW = Math.max(4, ...sandboxes.map((s) => s.name.length));
  console.log(`${'NAME'.padEnd(nameW)}  STATUS`);
  for (const s of sandboxes) console.log(`${s.name.padEnd(nameW)}  ${s.status ?? ''}`);
}

export async function runSbxStart(opts: { name?: string; agent?: string; workspace?: string }): Promise<void> {
  const body: Record<string, string> = {};
  if (opts.name) body.name = opts.name;
  if (opts.agent) body.agent = opts.agent;
  if (opts.workspace) body.workspace = opts.workspace;
  const r = await post<SbxStartResult>('/api/sbx/start', body);
  console.log(`${r.ok ? '✓ sandbox created' : '✗ stopped at a wall'}: ${r.name}`);
  console.log(dim(`  upstream ${r.upstreamUrl}`));
  for (const step of r.steps) {
    console.log(`  ${step.code === 0 ? '✓' : '✗'} ${step.label}  ${dim(`(exit ${step.code})`)}`);
    console.log(dim(`    ${step.command}`));
    if (step.stderr.trim()) console.log(dim(`    ${step.stderr.trim().split('\n').join('\n    ')}`));
  }
  if (!r.ok) process.exitCode = 1;
}

export async function runSbxRemove(opts: { name?: string; force?: boolean }): Promise<void> {
  if (!opts.name) {
    console.error('Usage: huddle sbx rm <name> [--force]');
    process.exit(1);
  }
  const q = opts.force ? '?force=1' : '';
  const r = await del<{ name: string; exitCode: number; ok: boolean }>(`/api/sbx/sandboxes/${encodeURIComponent(opts.name)}${q}`);
  console.log(`${r.ok ? '✓ removed' : '✗ failed'}: ${r.name}  ${dim(`(exit ${r.exitCode})`)}`);
  if (!r.ok) process.exitCode = 1;
}

export async function runSbxLog(opts: { name?: string }): Promise<void> {
  if (!opts.name) {
    console.error('Usage: huddle sbx log <name>');
    process.exit(1);
  }
  const r = await get<{ raw: string; denied: Array<{ domain: string; sandbox?: string }> }>(
    `/api/sbx/sandboxes/${encodeURIComponent(opts.name)}/log`
  );
  console.log(dim('── raw `sbx policy log --json` ──'));
  console.log(r.raw.trim() || dim('(empty)'));
  console.log(dim(`── parsed denied (${r.denied.length}) ──`));
  for (const d of r.denied) console.log(`  ✗ ${d.domain}${d.sandbox ? dim(' @ ' + d.sandbox) : ''}`);
  if (r.denied.length === 0) console.log(dim('  (parser matched nothing — paste the raw JSON above so the parser can be tuned)'));
}

export async function runSbxIngest(): Promise<void> {
  const r = await post<{ added: number }>('/api/sbx/ingest', {});
  console.log(`Ingested ${r.added} blocked request(s) from sbx → pending in Huddle.`);
}

export async function runSbxTrustCa(opts: { name?: string }): Promise<void> {
  if (!opts.name) {
    console.error('Usage: huddle sbx trust-ca <name>');
    process.exit(1);
  }
  const r = await post<{ name: string; code: number; ok: boolean; stdout: string; stderr: string }>(
    `/api/sbx/sandboxes/${encodeURIComponent(opts.name)}/trust-ca`,
    {}
  );
  const marker = (r.stdout || '').match(/HUDDLE_CA_INSTALLED_\w+/)?.[0];
  console.log(`${r.ok ? '✓ Huddle CA installed' : '✗ CA install failed'}: ${r.name}  ${dim(`(exit ${r.code}${marker ? ', ' + marker.toLowerCase() : ''})`)}`);
  if (r.stderr?.trim()) console.log(dim(`  ${r.stderr.trim().split('\n').join('\n  ')}`));
  if (r.ok) console.log(dim('  HTTPS from inside the sandbox now trusts Huddle — reconnect your editor.'));
  else process.exitCode = 1;
}

/**
 * Trust Huddle's CA on the HOST (where the sbx daemon runs), not inside a
 * sandbox. Needed because sbx terminates TLS itself for some hosts (measured:
 * platform.claude.com gets a `Docker Sandboxes Proxy CA` leaf) and then
 * validates Huddle's certificate against the host trust store. Without it those
 * requests die as "Empty reply from server" / ECONNRESET — see sbx-host-ca.ts.
 */
export async function runSbxTrustHost(opts: { runtime?: string } = {}): Promise<void> {
  const { installHostCa, printHostCaResult } = await import('./sbx-host-ca');
  console.log('Trusting Huddle’s CA on the host (for the sbx daemon)');
  const r = installHostCa({ restartDaemon: 'always' });
  printHostCaResult(r);
  if (!r.ok) process.exitCode = 1;
}

export async function runSbxSshSetup(): Promise<void> {
  const r = await post<{ exitCode: number; ok: boolean }>('/api/sbx/ssh-setup', {});
  if (r.ok) {
    console.log('✓ SSH bridge ready. Connect an editor with:');
    console.log(dim('    ssh <sandbox-name>.sbx        # or add it as a VS Code / JetBrains remote host'));
  } else {
    console.log(`✗ ssh setup failed (exit ${r.exitCode})`);
    process.exitCode = 1;
  }
}

export async function runSbxReconcile(opts: { dryRun?: boolean }): Promise<void> {
  const q = opts.dryRun ? '?dryRun=1' : '';
  const r = await post<ReconcileReport>(`/api/sbx/reconcile${q}`, {});
  const mode = r.dryRun ? 'DRY RUN — ' : '';
  if (r.error) {
    console.error(`✗ ${mode}reconcile could not run: ${r.error}`);
    process.exit(1);
  }
  console.log(`${mode}Reconcile Huddle → sbx policy (Huddle is the source of truth)`);
  console.log(`  desired rules: ${r.desired}   created: ${r.created}   deleted (drift): ${r.deleted}   failed: ${r.failed}`);
  if (r.sandboxes.length) console.log(dim(`  scopes: global, ${r.sandboxes.map((n) => 'sandbox:' + n).join(', ')}`));
  for (const a of r.actions) {
    const sym = a.ok ? (a.op === 'create' ? '+' : '-') : '✗';
    console.log(`  ${sym} ${a.op} ${a.action} ${a.target} @ ${scopeLabel(a.scope)}${a.error ? dim('  — ' + a.error) : ''}`);
  }
  if (r.notProjected.length) {
    console.log(dim(`  ${r.notProjected.length} path rule(s) NOT projected to sbx (domain-level only) —`));
    console.log(dim(`    these are enforced fleet-wide at Huddle's proxy, never per-sandbox in sbx mode.`));
  }
  if (r.failed > 0) process.exitCode = 1;
}
