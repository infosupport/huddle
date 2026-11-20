import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { spawn, spawnSync, SpawnSyncOptions } from 'child_process';
import { ApiError, get, post, del } from './api';
import { CONFIG_DIR } from './config';
import { resolveRuntime } from './runtime';
import { bold, dim, green, red, yellow } from './utils';
import {
  GAVE_UP_LABEL,
  PrInfo,
  affectedProjects,
  failedJobs,
  guardViolations,
  parseNameStatus,
  renovatePrAuthor,
  sanitizeCommitMessage,
  skipReason,
  testWeakeningFlags,
} from './update-agent-guard';

// `huddle update-agent [PR]`: fixes Renovate PRs whose CI is red (design doc,
// Part 2, Agent 1). Split of power:
// - The CONTAINER only edits files. It has no GitHub credentials, reaches only
//   npm, the Anthropic API and huddle itself (airlock), and holds a placeholder
//   instead of the real Claude credential (token exchange).
// - The HOST (this CLI, with the developer's own gh/git login) does every
//   GitHub read and write and checks the result itself. Once the container
//   runs, the host never touches the mounted folder by path: anything in it can
//   be a symlink to a host file. Files the agent can write are read and written
//   through the container, and the agent's commit leaves as a git bundle that
//   is copied out with `docker cp` and fetched into a separate clean clone.

export interface UpdateAgentOptions {
  pr?: number;
  dryRun: boolean;
  keep: boolean;
  runtime?: string;
}

type Outcome = 'fixed' | 'dry-run' | 'gave-up' | 'skipped' | 'error';

interface Result {
  pr: number;
  outcome: Outcome;
  detail: string;
}

const MAX_ATTEMPTS = 3;
const CLAUDE_TIMEOUT_MS = 30 * 60 * 1000;
const VERIFY_TIMEOUT_MS = 20 * 60 * 1000;
const PROMPT_PATH = '.github/agent/update-agent.md';
const PR_FIELDS = 'number,title,author,isCrossRepository,headRefName,headRefOid,labels,statusCheckRollup,commits';
const AGENT_RULES = [
  { domain: 'registry.npmjs.org', status: 'allow' },
  { domain: 'api.anthropic.com', status: 'allow' },
  { domain: 'huddle', status: 'allow' }, // huddle's own audit forwarder (global rules don't apply under airlock)
  // better-sqlite3 (gateway) downloads its prebuilt native binary from its own
  // GitHub releases during `npm ci`; GitHub redirects that to its asset hosts.
  // Only that path on github.com, nothing else there.
  { domain: 'github.com', status: 'allow', path_pattern: '/WiseLibs/better-sqlite3/releases/download/*' },
  { domain: 'release-assets.githubusercontent.com', status: 'allow' },
  { domain: 'objects.githubusercontent.com', status: 'allow' },
];
const CONTAINER_ENV = [
  // The mounted repo is owned by another uid; without this git refuses it ("dubious ownership").
  '-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/workspace/repo',
  // No telemetry or other non-essential calls from Claude Code; the airlock would block them anyway.
  '-e', 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
];
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
].join(',');

// ── process helpers (no shell: every argument is passed as-is) ──────────────

interface RunResult {
  status: number | null;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
  if (r.error && !timedOut) throw new Error(`${cmd} ${args[0] ?? ''}: ${r.error.message}`);
  return { status: timedOut ? null : r.status, timedOut, stdout: (r.stdout as string) ?? '', stderr: (r.stderr as string) ?? '' };
}

function must(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
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

interface AsyncOpts {
  timeout?: number;
  inherit?: boolean;
  input?: string;
}

function runAsync(cmd: string, args: string[], opts: AsyncOpts = {}): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const out = opts.inherit ? 'inherit' : 'pipe';
    const child = spawn(cmd, args, { stdio: [opts.input === undefined ? 'ignore' : 'pipe', out, out] });
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

/**
 * Agent-written text for a public comment, inside a code fence: no links,
 * images, HTML or @mentions are rendered from it.
 */
function quoteUntrusted(text: string): string {
  return ['````text', text.replace(/`{3,}/g, (m) => "'".repeat(m.length)), '````'].join('\n');
}

const tail = (s: string, n: number) => (s.length > n ? `[…truncated…]\n${s.slice(-n)}` : s);

// ── entry point ──────────────────────────────────────────────────────────────

export async function runUpdateAgent(opts: UpdateAgentOptions): Promise<void> {
  const engine = resolveRuntime(opts.runtime).name;
  if (run('gh', ['auth', 'status']).status !== 0) throw new Error('GitHub CLI is not logged in. Run `gh auth login` first.');
  const repo = must('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim();
  const credential = claudeCredential();
  // Doubles as the "is Huddle running and are we authenticated" check.
  const { imageName } = await get<{ imageName: string }>('/api/docker/base-image?ide=vscode');
  const prompt = fetchPrompt(repo);
  const identity = gitIdentity();

  const prs = listPrs(repo, opts.pr);
  if (prs.length === 0) {
    console.log(opts.pr ? `PR #${opts.pr} not found.` : 'No open Renovate PRs.');
    return;
  }

  const results: Result[] = [];
  process.on('SIGINT', onSigint);
  try {
    await processAll(prs, { repo, engine, imageName, credential, prompt, identity, opts }, results);
  } finally {
    process.off('SIGINT', onSigint);
  }

  console.log(`\n${bold('Update agent summary')}`);
  for (const r of results) {
    const color = r.outcome === 'fixed' || r.outcome === 'dry-run' ? green : r.outcome === 'skipped' ? dim : red;
    console.log(`  #${r.pr}  ${color(r.outcome.padEnd(8))} ${r.detail}`);
  }
}

async function processAll(prs: PrInfo[], base: Omit<Ctx, 'pr'>, results: Result[]): Promise<void> {
  const { opts } = base;
  for (const pr of prs) {
    if (interrupted) break;
    const reason = skipReason(pr);
    if (reason) {
      if (opts.pr) console.log(yellow(`Skipping #${pr.number}: ${reason}`));
      results.push({ pr: pr.number, outcome: 'skipped', detail: reason });
      continue;
    }
    console.log(`\n${bold(`PR #${pr.number}`)} ${pr.title} ${dim(`(${pr.headRefName})`)}`);
    try {
      results.push(await processPr({ ...base, pr }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`  error: ${msg}`));
      results.push({ pr: pr.number, outcome: 'error', detail: msg });
    }
  }
}

// ── setup ────────────────────────────────────────────────────────────────────

interface Credential {
  env: 'CLAUDE_CODE_OAUTH_TOKEN' | 'ANTHROPIC_API_KEY';
  secret: string;
}

function claudeCredential(): Credential {
  const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { env: 'CLAUDE_CODE_OAUTH_TOKEN', secret: oauth };
  const key = process.env.ANTHROPIC_API_KEY?.trim();
  if (key) return { env: 'ANTHROPIC_API_KEY', secret: key };
  throw new Error(
    'No Claude credential found. Set CLAUDE_CODE_OAUTH_TOKEN (create one with `claude setup-token`) ' +
    'or ANTHROPIC_API_KEY in this shell. It is handed to the Huddle gateway, never to the container.',
  );
}

/** The prompt always comes from the default branch, so a PR branch cannot rewrite its own instructions. */
function fetchPrompt(repo: string): string {
  // HUDDLE_UPDATE_AGENT_PROMPT_REF is for trying out prompt changes before they are merged.
  const branch = process.env.HUDDLE_UPDATE_AGENT_PROMPT_REF?.trim() ||
    must('gh', ['repo', 'view', repo, '--json', 'defaultBranchRef', '-q', '.defaultBranchRef.name']).trim();
  const r = run('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${PROMPT_PATH}?ref=${encodeURIComponent(branch)}`]);
  if (r.status !== 0 || !r.stdout.trim()) {
    throw new Error(`Could not read ${PROMPT_PATH} from ${repo}@${branch}. Is the update agent merged there?`);
  }
  return r.stdout;
}

function gitIdentity(): { name: string; email: string } {
  const name = run('git', ['config', 'user.name']).stdout.trim();
  const email = run('git', ['config', 'user.email']).stdout.trim();
  if (!name || !email) throw new Error('Set git user.name and user.email: the agent commits under your name.');
  return { name, email };
}

function listPrs(repo: string, only?: number): PrInfo[] {
  if (only) {
    const r = run('gh', ['pr', 'view', String(only), '--repo', repo, '--json', PR_FIELDS]);
    if (r.status === 0) return [JSON.parse(r.stdout) as PrInfo];
    if (/could not resolve|not found/i.test(r.stderr)) return [];
    throw new Error(`gh pr view ${only} failed: ${r.stderr.trim()}`);
  }
  const out = must('gh', ['pr', 'list', '--repo', repo, '--author', renovatePrAuthor(), '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
  return JSON.parse(out) as PrInfo[];
}

// ── one PR ───────────────────────────────────────────────────────────────────

interface Ctx {
  pr: PrInfo;
  repo: string;
  engine: string;
  imageName: string;
  credential: Credential;
  prompt: string;
  identity: { name: string; email: string };
  opts: UpdateAgentOptions;
}

async function processPr(ctx: Ctx): Promise<Result> {
  const { pr, opts } = ctx;
  const name = `update-agent-pr-${pr.number}`;
  const dir = path.join(CONFIG_DIR, 'update-agent', `pr-${pr.number}`);
  // A container from an earlier --keep run is someone's debugging session:
  // never delete it (or its folder) implicitly.
  if (await containerExists(name)) {
    return { pr: pr.number, outcome: 'skipped', detail: `container ${name} from an earlier --keep run still exists; remove it first` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    return await fixPr(ctx, name, dir);
  } finally {
    await cleanup(name, opts.keep);
    if (!opts.keep) removeDir(dir);
  }
}

/**
 * dir/workspace is mounted at /workspace (repo, input, out). Its root holds no
 * .git, so the gateway mounts it as-is instead of creating a worktree.
 * dir/publish is the trusted clone and dir/agent.bundle the copied-out commit;
 * neither is ever mounted.
 */
async function fixPr(ctx: Ctx, name: string, dir: string): Promise<Result> {
  const { pr } = ctx;
  const ws = path.join(dir, 'workspace');
  const publish = path.join(dir, 'publish');
  const prFiles = prepareWorkspace(ctx, ws, publish);
  if (!prFiles) return { pr: pr.number, outcome: 'skipped', detail: 'branch moved while starting; run again' };

  const agent = await startAgent(ctx, name, ws);
  // Git metadata the agent could use to run code on commit (hooks, filters).
  const gitBaseline = gitMetadata(agent);

  const failure = await runAttempts(ctx, agent, prFiles);
  if (failure) return giveUp(ctx, `failed after ${MAX_ATTEMPTS} attempts`, failure);

  // Nothing the agent or a package's install script left running may change
  // the tree between the checks below and the commit.
  agent.stopAll();
  if (gitMetadata(agent) !== gitBaseline) {
    return giveUp(ctx, 'the git configuration or hooks were changed during the run', 'Something in the container changed .git/config, .git/hooks or .git/info/attributes.');
  }
  const bundle = await commitAndBundle(ctx, agent, dir);
  return publishResult(ctx, agent, publish, bundle);
}

/** Clones the PR twice and writes the agent's inputs. Returns the PR's files, or null if the branch moved. */
function prepareWorkspace(ctx: Ctx, ws: string, publish: string): string[] | null {
  const { pr, repo } = ctx;
  for (const d of ['input', 'out']) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const clone = (dest: string, depth: string) =>
    must('gh', ['repo', 'clone', repo, dest, '--', '--config', 'core.autocrlf=false', '--quiet', '--no-tags', '--single-branch', '--depth', depth, '--branch', pr.headRefName]);
  clone(path.join(ws, 'repo'), '50');
  clone(publish, '1');
  if (must('git', ['-C', publish, 'rev-parse', 'HEAD']).trim() !== pr.headRefOid) return null;
  return writeInputs(ctx, path.join(ws, 'input'));
}

/** Writes the agent's inputs (before the container exists) and returns the files the PR itself changes. */
function writeInputs(ctx: Ctx, input: string): string[] {
  const { pr, repo } = ctx;
  const view = JSON.parse(must('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'title,body,files'])) as {
    title: string;
    body: string;
    files?: { path: string }[];
  };
  fs.writeFileSync(path.join(input, 'pr.md'), `# ${view.title}\n\n${view.body ?? ''}\n`);
  const logs = failedJobs(pr).map(({ runId, jobId }) => {
    const r = run('gh', ['run', 'view', '--job', jobId, '--repo', repo, '--log']);
    return `===== run ${runId}, job ${jobId} =====\n${r.status === 0 ? tail(r.stdout, 20_000) : `(could not read log: ${r.stderr.trim()})`}`;
  });
  fs.writeFileSync(path.join(input, 'failure.log'), tail(logs.join('\n') || 'No GitHub Actions log found for the failing checks.', 60_000));
  return (view.files ?? []).map((f) => f.path);
}

// ── the container ────────────────────────────────────────────────────────────

type Exec = (args: string[], workdir: string, extra?: AsyncOpts) => Promise<RunResult>;

interface Agent {
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

async function startAgent(ctx: Ctx, name: string, ws: string): Promise<Agent> {
  const { engine, credential } = ctx;
  console.log(dim(`  starting ${name} (airlocked: npm registry, Anthropic API and better-sqlite3 releases only)`));
  await post(`/api/docker/containers/${name}/airlock`, { airlocked: true });
  await post(`/api/rules/import?container=${encodeURIComponent(name)}`, { mode: 'replace', rules: AGENT_RULES });
  await post('/api/docker/start', {
    imageName: ctx.imageName,
    containerName: name,
    ideName: 'vscode',
    mounts: [{ hostPath: ws.replace(/\\/g, '/'), containerPath: '/workspace' }],
    containerWorkspace: '/workspace/repo',
    // No folder mappings from the portal, and no Docker or sudo rights left
    // over from an earlier container with this name.
    isolated: true,
  });
  const { placeholder } = await post<{ placeholder: string }>(`/api/docker/containers/${name}/token`, { secret: credential.secret });

  const root = (script: string) => run(engine, ['exec', '-u', 'root', name, 'sh', '-c', script]);
  const stopAll = () => {
    // pkill exits 1 when nothing was left to kill; anything else means it failed.
    const kill = root('pkill -KILL -u vscode');
    if (kill.status !== 0 && kill.status !== 1) throw new Error(`Could not stop the agent's processes in ${name}.`);
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

/** Snapshot of the git files that can make git run code, read as root and never through git. */
function gitMetadata(agent: Agent): string {
  const r = agent.root([
    'cd /workspace/repo',
    '[ -L .git ] && echo "symlinked .git"',
    'cd .git 2>/dev/null || { echo "no .git directory"; exit 0; }',
    'cat config 2>&1; echo "-- attributes"; cat info/attributes 2>&1',
    'echo "-- hooks"; ls -A hooks 2>&1 | grep -v "[.]sample$"',
    'exit 0',
  ].join('\n'));
  if (r.status !== 0) throw new Error(`could not read the git metadata in ${agent.name}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** Runs Claude Code and verifies its work, up to MAX_ATTEMPTS. Returns '' on success, otherwise the last failure. */
async function runAttempts(ctx: Ctx, agent: Agent, prFiles: string[]): Promise<string> {
  const { exec, name } = agent;
  // Hash of the whole working tree, untracked files included, via a throwaway
  // index so the real index stays untouched.
  const treeState = async () => {
    const r = await exec(['sh', '-c', 'cp .git/index "$1" && GIT_INDEX_FILE="$1" git add -A && GIT_INDEX_FILE="$1" git write-tree', 'sh', '/tmp/huddle-tree.idx'], '/workspace/repo');
    if (r.status !== 0) throw new Error(`could not read the working tree in ${name}: ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  // Files the agent changed relative to the PR head, untracked ones included.
  const changedFiles = async () => {
    const r = await exec(['sh', '-c', 'cp .git/index "$1" && GIT_INDEX_FILE="$1" git add -A && GIT_INDEX_FILE="$1" git diff --cached --name-only HEAD', 'sh', '/tmp/huddle-changed.idx'], '/workspace/repo');
    if (r.status !== 0) throw new Error(`could not list the changed files in ${name}: ${r.stderr.trim()}`);
    return r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  };

  let lastFailure = '';
  let feedback = '';
  let verifyLog = '';
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    console.log(dim(`  attempt ${attempt}/${MAX_ATTEMPTS}: running Claude Code`));
    const task = feedback ? `${ctx.prompt}\n\nThis is attempt ${attempt}. ${feedback}` : ctx.prompt;
    const before = await treeState();
    const claude = await exec(['claude', '-p', task, '--max-turns', '40', '--allowedTools', ALLOWED_TOOLS], '/workspace/repo', {
      inherit: true,
      timeout: CLAUDE_TIMEOUT_MS,
    });
    if ((await treeState()) === before) {
      if (claude.status !== 0) {
        // Not the PR's fault: credential, firewall or Claude Code itself.
        throw new Error(`Claude Code ${claude.timedOut ? 'timed out' : `exited with ${claude.status}`} without changing anything. ` +
          `Check the credential and the requested rules for ${name} in the portal.`);
      }
      // After a failed verification, an attempt that changes nothing means the
      // agent sees no code fix (often an environment problem). Another
      // attempt would re-verify the same tree, so stop with that output.
      if (verifyLog) break;
      lastFailure = 'the agent made no changes';
      feedback = 'Your previous attempt changed nothing.';
      continue;
    }
    const projects = affectedProjects([...prFiles, ...(await changedFiles())]);
    console.log(dim(`  verifying: npm ci, build and test in ${projects.join(', ')}`));
    lastFailure = await verify(exec, projects);
    if (!lastFailure) break;
    verifyLog = `/workspace/input/verify-${attempt}.log`;
    await agent.writeFile(verifyLog, tail(lastFailure, 30_000));
    feedback = `Your previous change did not pass verification; the output is in ${verifyLog}. ` +
      'Fix that, keeping the earlier work where it is right.';
    console.log(yellow('  verification failed'));
  }
  return lastFailure;
}

/** Runs what CI runs, for the given projects. Returns '' when everything passes, otherwise the failing output. */
async function verify(exec: Exec, projects: string[]): Promise<string> {
  for (const project of projects) {
    const r = await exec(
      ['bash', '-lc', 'npm ci --no-audit --no-fund && npm run build --if-present && CI=true npm test --if-present'],
      `/workspace/repo/${project}`,
      { timeout: VERIFY_TIMEOUT_MS },
    );
    if (r.status !== 0) return `### ${project} failed (exit ${r.status ?? 'timeout'})\n${r.stdout}\n${r.stderr}`;
  }
  return '';
}

/** Commits in the container under the developer's name and copies the commit out as a bundle. */
async function commitAndBundle(ctx: Ctx, agent: Agent, dir: string): Promise<string> {
  const { pr, identity, engine } = ctx;
  const message = sanitizeCommitMessage(await agent.readFile('/workspace/out/commit-msg.txt'), `fix(deps): adapt code for ${pr.title}`);
  // A fresh name, so nothing the agent prepared in /tmp can stand in for it.
  const inContainer = `/tmp/huddle-${crypto.randomBytes(8).toString('hex')}.bundle`;
  const steps: { args: string[]; input?: string }[] = [
    { args: ['add', '-A'] },
    { args: ['commit', '-q', '--no-verify', '-F', '-'], input: message },
    { args: ['bundle', 'create', inContainer, 'HEAD', `^${pr.headRefOid}`] },
  ];
  for (const { args, input } of steps) {
    const r = await agent.exec([
      'git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false',
      '-c', `user.name=${identity.name}`, '-c', `user.email=${identity.email}`, ...args,
    ], '/workspace/repo', { input });
    if (r.status !== 0) throw new Error(`git ${args[0]} in the container failed: ${(r.stderr || r.stdout).trim()}`);
  }
  const bundle = path.join(dir, 'agent.bundle');
  must(engine, ['cp', `${agent.name}:${inContainer}`, bundle]);
  if (!fs.lstatSync(bundle).isFile()) throw new Error('the bundle copied out of the container is not a regular file');
  return bundle;
}

/** Checks the agent's commit in the trusted clone, then pushes and comments (or prints it for --dry-run). */
async function publishResult(ctx: Ctx, agent: Agent, publish: string, bundle: string): Promise<Result> {
  const { pr, repo, opts } = ctx;
  must('git', ['-C', publish, 'fetch', '--quiet', bundle, 'HEAD']);
  const fixed = must('git', ['-C', publish, 'rev-parse', 'FETCH_HEAD']).trim();
  if (run('git', ['-C', publish, 'merge-base', '--is-ancestor', pr.headRefOid, fixed]).status !== 0) {
    return giveUp(ctx, 'the result does not build on the PR head', '');
  }
  const files = parseNameStatus(must('git', ['-C', publish, 'diff', '--name-status', pr.headRefOid, fixed]));
  const blocked = guardViolations(files.map((f) => f.path));
  if (blocked.length) {
    return giveUp(ctx, 'blocked by the path guard', `The agent changed files only a person may change:\n${blocked.join('\n')}`);
  }
  const flags = testWeakeningFlags(files, must('git', ['-C', publish, 'diff', '-U0', pr.headRefOid, fixed]));
  const summary = (await agent.readFile('/workspace/out/summary.md')).trim();
  const comment = [
    '### Update agent: fixed the build',
    '',
    'The agent\'s own summary, written after reading untrusted release notes and logs:',
    '',
    summary ? quoteUntrusted(tail(summary, 20_000)) : '> _The agent wrote no summary._',
    '',
    `**Files changed:** ${files.filter((f) => f.status !== 'D').length} changed, ${files.filter((f) => f.status === 'D').length} deleted`,
    flags.length ? `**Check these (possible weakened tests):**\n${flags.map((f) => `- ${f}`).join('\n')}` : '**Test changes:** nothing suspicious found',
    '',
    `<sub>Run by ${ctx.identity.name} with \`huddle update-agent\` inside an airlocked Huddle devcontainer. A person still reviews and merges.</sub>`,
  ].join('\n');

  if (opts.dryRun) {
    console.log(must('git', ['-C', publish, '--no-pager', 'show', '--stat', '--patch', fixed]));
    console.log(dim('\n--- PR comment that would be posted ---\n') + comment);
    return { pr: pr.number, outcome: 'dry-run', detail: `${files.length} file(s) changed; nothing pushed` };
  }
  // A plain push: it fails instead of overwriting if the branch moved meanwhile.
  must('git', ['-C', publish, '-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', 'push', '--quiet', 'origin', `${fixed}:refs/heads/${pr.headRefName}`]);
  must('gh', ['pr', 'comment', String(pr.number), '--repo', repo, '--body-file', '-'], { input: comment });
  console.log(green(`  pushed ${fixed.slice(0, 7)} to ${pr.headRefName}`));
  return { pr: pr.number, outcome: 'fixed', detail: `pushed ${fixed.slice(0, 7)}${flags.length ? `, ${flags.length} flag(s) for review` : ''}` };
}

// ── outcome and cleanup ──────────────────────────────────────────────────────

async function giveUp(ctx: Ctx, reason: string, details: string): Promise<Result> {
  const { pr, repo, opts } = ctx;
  console.log(red(`  giving up: ${reason}`));
  if (!opts.dryRun) {
    const body = [
      `### Update agent: gave up`,
      '',
      `**Reason:** ${reason}. Nothing was pushed; this PR needs a person.`,
      details ? `\n<details><summary>Last output</summary>\n\n\`\`\`\n${tail(details, 6_000).replace(/```/g, "'''")}\n\`\`\`\n</details>` : '',
      '',
      `<sub>Run by ${ctx.identity.name} with \`huddle update-agent\`. Remove the \`${GAVE_UP_LABEL}\` label to let the agent try again.</sub>`,
    ].join('\n');
    if (run('gh', ['pr', 'edit', String(pr.number), '--repo', repo, '--add-label', GAVE_UP_LABEL]).status !== 0) {
      console.log(yellow(`  could not add the ${GAVE_UP_LABEL} label (does it exist in ${repo}?)`));
    }
    must('gh', ['pr', 'comment', String(pr.number), '--repo', repo, '--body-file', '-'], { input: body });
  }
  return { pr: pr.number, outcome: 'gave-up', detail: reason };
}

async function containerExists(name: string): Promise<boolean> {
  try {
    await get(`/api/docker/containers/${encodeURIComponent(name)}`);
    return true;
  } catch (err) {
    if (err instanceof ApiError && err.status === 404) return false;
    throw err;
  }
}

/** rmSync removes symlinks themselves and never follows them. */
function removeDir(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
  } catch (err) {
    console.log(yellow(`  could not remove ${dir}: ${err instanceof Error ? err.message : String(err)}`));
  }
}

async function cleanup(name: string, keep: boolean): Promise<void> {
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
