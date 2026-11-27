import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, SpawnSyncOptions } from 'child_process';
import { ApiError, get, post, del } from './api';
import { requestsByHost } from './update-agent-guard';
import { dim, yellow } from './utils';

// What the AI agents (`huddle update-agent`, `huddle triage-agent`) share: an
// airlocked, isolated Huddle devcontainer that holds a placeholder instead of
// the real Claude credential, the helpers to run commands in it, and its
// network log. The host (the CLI) does every GitHub read and write itself.

// ── process helpers (no shell: every argument is passed as-is) ──────────────

export interface RunResult {
  status: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

export function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (r.error && !timedOut) throw new Error(`${cmd} ${args[0] ?? ''}: ${r.error.message}`);
  return { status: timedOut ? null : r.status, timedOut, stdout: (r.stdout as string) ?? '', stderr: (r.stderr as string) ?? '' };
}

export function must(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout;
}

// The long-running container commands (Claude, verification) run async, so a
// Ctrl+C reaches the SIGINT handler while they run: it stops them, and the
// normal `finally` cleanup removes the container, rules and placeholder.
let interrupted = false;
const interruptHooks = new Set<() => void>();
const OUTPUT_CAP = 1024 * 1024;

export const isInterrupted = () => interrupted;

export interface AsyncOpts {
  timeout?: number;
  input?: string;
  /** Show stderr on the terminal as it comes, instead of capturing it. */
  liveStderr?: boolean;
}

export function runAsync(cmd: string, args: string[], opts: AsyncOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', opts.liveStderr ? 'inherit' : 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (d: string) => { stdout = (stdout + d).slice(-OUTPUT_CAP); });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => { stderr = (stderr + d).slice(-OUTPUT_CAP); });
    child.stdin?.on('error', () => { /* the process exited early; its status says why */ });
    child.stdin?.end(opts.input);
    const timer = opts.timeout ? setTimeout(() => { timedOut = true; child.kill(); }, opts.timeout) : undefined;
    const stop = () => child.kill();
    interruptHooks.add(stop);
    const done = () => { if (timer) clearTimeout(timer); interruptHooks.delete(stop); };
    child.on('error', (err) => { done(); reject(new Error(`${cmd} ${args[0] ?? ''}: ${err.message}`)); });
    child.on('close', (status) => { done(); resolve({ status: timedOut ? null : status, timedOut, stdout, stderr }); });
  });
}

function onSigint(): void {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log(yellow('\nInterrupted: stopping the agent and cleaning up. Press Ctrl+C again to quit right away.'));
  for (const stop of interruptHooks) stop();
}

/** Runs fn with the Ctrl+C handler installed: the first Ctrl+C stops the agent and lets cleanup run. */
export async function withInterruptHandler<T>(fn: () => Promise<T>): Promise<T> {
  process.on('SIGINT', onSigint);
  try {
    return await fn();
  } finally {
    process.off('SIGINT', onSigint);
  }
}

// ── untrusted text ───────────────────────────────────────────────────────────

/**
 * Agent-written text for a public comment, inside a code fence: no links,
 * images, HTML or @mentions are rendered from it.
 */
export function quoteUntrusted(text: string): string {
  return ['````text', text.replace(/`{3,}/g, (m) => "'".repeat(m.length)), '````'].join('\n');
}

export const tail = (s: string, n: number) => (s.length > n ? `[…truncated…]\n${s.slice(-n)}` : s);

export const inActions = () => process.env.GITHUB_ACTIONS === 'true';

/**
 * Prints text the agent may have shaped (its answers, its diff and commit
 * message, errors carrying container output). In GitHub Actions, workflow
 * commands are switched off around it, so a line like `::add-mask::` or
 * `::error::` in it does nothing in the public log.
 */
export function printUntrusted(text: string, color: (s: string) => string = dim, max = 4_000, toStderr = false): void {
  const stop = crypto.randomBytes(16).toString('hex');
  if (inActions()) console.log(`::stop-commands::${stop}`);
  (toStderr ? console.error : console.log)(color(tail(text, max)));
  if (inActions()) console.log(`::${stop}::`);
}

/** The link to this GitHub Actions run, or null outside Actions. */
export function actionsRunUrl(): string | null {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env;
  if (GITHUB_ACTIONS === 'true' && GITHUB_SERVER_URL && GITHUB_REPOSITORY && /^\d+$/.test(GITHUB_RUN_ID ?? '')) {
    return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`;
  }
  return null;
}

// ── setup ────────────────────────────────────────────────────────────────────

export interface Credential {
  env: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  secret: string;
}

export function claudeCredential(): Credential {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  // Only the gateway gets it; no child process of this CLI inherits it.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  delete process.env.ANTHROPIC_API_KEY;
  if (oauth) return { env: 'CLAUDE_CODE_OAUTH_TOKEN', secret: oauth };
  if (key) return { env: 'ANTHROPIC_API_KEY', secret: key };
  throw new Error(
    'No Claude credential found. Set CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`) ' +
    'or ANTHROPIC_API_KEY in this shell. It is handed to the Huddle gateway, never to the container.',
  );
}

/**
 * The prompt always comes from the default branch, so a PR branch cannot
 * rewrite its own instructions. The variable named by refEnv (for example
 * HUDDLE_UPDATE_AGENT_PROMPT_REF) is for trying out prompt changes before
 * they are merged.
 */
export function fetchPrompt(repo: string, promptPath: string, refEnv: string, agentName: string): string {
  const branch = process.env[refEnv]?.trim() ||
    must('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']).trim();
  const r = run('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${promptPath}?ref=${encodeURIComponent(branch)}`]);
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`Could not read ${promptPath} from ${repo}@${branch}. Is the ${agentName} merged there?`);
  }
  return r.stdout;
}

// ── the container ────────────────────────────────────────────────────────────

/** A per-container firewall rule, as `/api/rules/import` takes it. */
export interface AgentRule {
  domain: string;
  status: 'allow' | 'deny';
  path_pattern?: string;
}

const CONTAINER_ENV = [
  // The mounted repo is owned by another uid; without this git refuses it ("dubious ownership").
  '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/workspace/repo',
  // No telemetry or other non-essential calls from Claude Code; the airlock would block them anyway.
  '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
];

export type Exec = (args: string[], workdir: string, extra?: AsyncOpts) => Promise<RunResult>;

export interface Agent {
  name: string;
  /** Runs as the agent's user (vscode) with the placeholder credential. */
  exec: Exec;
  /** Runs a shell script as root, for checks the agent's processes cannot interfere with. */
  root(script: string): RunResult;
  /** Kills every process of the agent's user. */
  stopAll(): void;
  /** Reads a file the agent may have written; symlinks resolve inside the container. */
  readFile(file: string): Promise<string>;
  writeFile(file: string, content: string): Promise<void>;
}

export interface AgentSpec {
  name: string;
  engine: string;
  imageName: string;
  credential: Credential;
  /** The only hosts the container may reach: airlock mode, so no global rules apply. */
  rules: AgentRule[];
  /** Host folder mounted at /workspace, holding repo/, input/ and out/. */
  workspace: string;
  /** Shown while starting, e.g. "airlocked: npm registry and Anthropic API only". */
  description: string;
}

/**
 * Starts an airlocked, isolated devcontainer with /workspace mounted and the
 * Claude credential behind the token exchange. The caller removes it with
 * cleanup(), also when this throws halfway.
 */
export async function startAgent(spec: AgentSpec): Promise<Agent> {
  const { name, engine, credential } = spec;
  console.log(dim(`  starting ${name} (${spec.description})`));
  await post(`/api/docker/containers/${name}/airlock`, { airlocked: true });
  await post(`/api/rules/import?container=${encodeURIComponent(name)}`, { mode: 'replace', rules: spec.rules });
  await post('/api/docker/start', {
    imageName: spec.imageName,
    containerName: name,
    ideName: 'vscode',
    mounts: [{ hostPath: spec.workspace.replace(/\\/g, '/'), containerPath: '/workspace' }],
    containerWorkspace: '/workspace/repo',
    // No folder mappings from the portal, and no Docker or sudo rights left
    // over from an earlier container with this name.
    isolated: true,
  });
  const { placeholder } = await post<{ placeholder: string }>(`/api/docker/containers/${name}/token`, { secret: credential.secret });

  const root = (script: string) => run(engine, ['exec', '-u', 'root', name, 'sh', '-c', script]);
  // The gateway hands the repo to vscode; input and out are siblings the agent
  // writes to as well (summary, commit message, verification logs). Without
  // this they stay owned by the host user, which is not vscode on every host.
  const own = root('chown -R vscode:vscode /workspace/input /workspace/out');
  if (own.status !== 0) throw new Error(`could not prepare /workspace for the agent in ${name}: ${own.stderr.trim()}`);
  const stopAll = () => {
    // pkill exits 1 when nothing was left to kill; anything else means it failed.
    const kill = root('pkill -KILL -u vscode');
    if (kill.status !== 0 && kill.status !== 1) throw new Error(`Could not stop the agent's processes in ${name}.`);
    // The container's keep-alive runs as vscode too. A Huddle from before the
    // fix in its keep-alive loop stops the container here.
    if (root('true').status !== 0) {
      throw new Error(`${name} stopped when the agent's processes were stopped. Update Huddle (\`huddle init\`) and run again.`);
    }
  };
  // A timeout only kills the local `docker exec` client, not the process in the
  // container, so every exec that timed out or was interrupted stops them all.
  const exec: Exec = async (args, workdir, extra = {}) => {
    const stdin = extra.input === undefined ? [] : ['-i'];
    const r = await runAsync(engine, ['exec', ...stdin, '-u', 'vscode', '-w', workdir, '-e', `${credential.env}=${placeholder}`, ...CONTAINER_ENV, name, ...args], extra);
    if (r.timedOut || interrupted) stopAll();
    if (interrupted) throw new Error('interrupted');
    return r;
  };
  const readFile = async (file: string) => {
    const r = await exec(['sh', '-c', 'if [ -f "$1" ]; then head -c 200000 "$1"; fi', 'sh', file], '/workspace');
    if (r.status !== 0) throw new Error(`could not read ${file} in ${name}: ${r.stderr.trim()}`);
    return r.stdout;
  };
  const writeFile = async (file: string, content: string) => {
    const r = await exec(['sh', '-c', 'cat > "$1"', 'sh', file], '/workspace', { input: content });
    if (r.status !== 0) throw new Error(`could not write ${file} in ${name}: ${r.stderr.trim()}`);
  };
  return { name, exec, root, stopAll, readFile, writeFile };
}

/** Claude Code's `--output-format json` answer: its final text, cost and turns (null when it failed before answering). */
export function parseClaudeOutput(stdout: string): { result: string; costUsd: number; turns: number } | null {
  let out: { result?: unknown; total_cost_usd?: unknown; num_turns?: unknown } | null = null;
  try {
    out = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!out || typeof out !== 'object') return null;
  return {
    result: typeof out.result === 'string' ? out.result.trim() : '',
    costUsd: typeof out.total_cost_usd === 'number' ? out.total_cost_usd : 0,
    turns: typeof out.num_turns === 'number' ? out.num_turns : 0,
  };
}

// ── network log and usage ────────────────────────────────────────────────────

export interface AuditRow {
  ts: number;
  domain: string;
  port: number | null;
  method: string | null;
  path: string | null;
  action: string;
  res_status: number | null;
}

const AUDIT_PAGE = 1000;
const AUDIT_MAX = 20_000;

/** The container's traffic from Huddle's audit log: no headers or bodies, only what went where. */
export async function networkLog(name: string | undefined): Promise<{ requests: AuditRow[]; requested: string[] } | null> {
  if (!name) return null;
  try {
    const requests: AuditRow[] = [];
    for (let offset = 0; offset < AUDIT_MAX; offset += AUDIT_PAGE) {
      const page = await get<AuditRow[]>(`/api/audit?container=${encodeURIComponent(name)}&limit=${AUDIT_PAGE}&offset=${offset}`);
      requests.push(...page.map(({ ts, domain, port, method, path: p, action, res_status }) => ({ ts, domain, port, method, path: p, action, res_status })));
      if (page.length < AUDIT_PAGE) break;
    }
    const rules = await get<{ domain: string }[]>(`/api/rules?container=${encodeURIComponent(name)}&status=requested`);
    return { requests: requests.reverse(), requested: [...new Set(rules.map((r) => r.domain))] };
  } catch (err) {
    console.log(yellow(`  could not read the network log of ${name}: ${err instanceof Error ? err.message : String(err)}`));
    return null;
  }
}

/** Writes the container's network log as JSON to file, with `header` fields first. */
export async function saveNetworkLog(name: string | undefined, file: string, header: Record<string, unknown>): Promise<void> {
  const log = await networkLog(name);
  if (!log) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ ...header, container: name, ...log }, null, 2)}\n`);
  console.log(dim(`  network log: ${file}`));
}

/** A host name as text for a public comment; anything else is not shown as-is. */
export const hostText = (d: string) => (/^[A-Za-z0-9.-]{1,253}$/.test(d) ? `\`${d}\`` : '_(invalid host name)_');

/** Usage and network lines for a PR comment. */
export async function runFacts(name: string | undefined, usage: { costUsd: number; turns: number }): Promise<string[]> {
  const lines: string[] = [];
  if (usage.turns) lines.push(`**Claude Code:** ${usage.turns} turns, $${usage.costUsd.toFixed(2)}`);
  const log = await networkLog(name);
  if (log) {
    const hosts = requestsByHost(log.requests).slice(0, 15);
    lines.push(`**Network:** ${hosts.length ? hosts.map(([d, h]) => `${hostText(d)} ${h.allowed}${h.denied ? ` (+${h.denied} blocked)` : ''}`).join(', ') : 'no requests logged'}`);
    if (log.requested.length) {
      lines.push(`**Blocked hosts it asked for:** ${log.requested.slice(0, 15).map(hostText).join(', ')}. A dependency that suddenly needs a new host deserves a look.`);
    }
  }
  return lines.length ? ['', ...lines] : [];
}

// ── cleanup ──────────────────────────────────────────────────────────────────

export async function containerExists(name: string): Promise<boolean> {
  try {
    await get(`/api/docker/containers/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}

/**
 * Empties the mounted /workspace from inside the container, as root. On Linux
 * the files the agent wrote belong to the container's vscode user, which the
 * host user cannot delete. rm never follows symlinks, and only the container's
 * view of the mount is touched. Best effort: removeDir reports what is left.
 */
export function wipeWorkspace(engine: string, name: string): void {
  run(engine, ['exec', '-u', 'root', name, 'sh', '-c',
    'pkill -KILL -u vscode; find /workspace -mindepth 1 -maxdepth 1 -exec rm -rf {} +']);
}

/** rmSync removes symlinks themselves and never follows them. */
export function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (err) {
    console.log(yellow(`  could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

/** Revokes the placeholder and, unless keep, removes the container, its rules and its airlock. */
export async function cleanup(name: string, keep: boolean): Promise<void> {
  const quiet = async (fn: () => Promise<unknown>) => { try { await fn(); } catch { /* best effort */ } };
  await quiet(() => del(`/api/docker/containers/${name}/token`)); // always: no redeemable placeholder left behind
  if (keep) {
    console.log(dim(`  kept container ${name} and its folder for inspection`));
    return;
  }
  await quiet(() => del(`/api/docker/containers/${name}`)); // also after a half-finished start
  await quiet(() => post(`/api/rules/import?container=${encodeURIComponent(name)}`, { mode: 'replace', rules: [] }));
  await quiet(() => post(`/api/docker/containers/${name}/airlock`, { airlocked: false }));
}
