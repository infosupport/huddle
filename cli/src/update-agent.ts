import fs from 'fs';
import path from 'path';
import { spawnSync, SpawnSyncOptions } from 'child_process';
import { get, post, del } from './api';
import { CONFIG_DIR } from './config';
import { resolveRuntime } from './runtime';
import { bold, dim, green, red, yellow } from './utils';
import {
  GAVE_UP_LABEL,
  PrInfo,
  failedRunIds,
  guardViolations,
  parseNameStatus,
  skipReason,
  testWeakeningFlags,
} from './update-agent-guard';

// `huddle update-agent [PR]`: fixes Renovate PRs whose CI is red (design doc,
// Part 2, Agent 1). Split of power:
// - The CONTAINER only edits files. It has no GitHub credentials, reaches only
//   npm, the Anthropic API and huddle itself (airlock), and holds a placeholder
//   instead of the real Claude credential (token exchange).
// - The HOST (this CLI, with the developer's own gh/git login) does every
//   GitHub read and write, checks the result itself, and never runs git inside
//   the folder the agent wrote to: the agent's commit leaves as a git bundle and
//   is fetched into a separate clean clone.

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
const PR_FIELDS = 'number,title,headRefName,headRefOid,labels,statusCheckRollup,commits';
// Frontend first: the gateway build (`build:ui`) compiles it.
const PROJECTS = ['gateway/frontend', 'gateway', 'cli'];
const AGENT_RULES = [
  { domain: 'registry.npmjs.org', status: 'allow' },
  { domain: 'api.anthropic.com', status: 'allow' },
  { domain: 'huddle', status: 'allow' }, // huddle's own audit forwarder (global rules don't apply under airlock)
];
// The mounted repo is owned by another uid; without this git refuses it ("dubious ownership").
const GIT_SAFE_DIR_ENV = ['-e', 'GIT_CONFIG_COUNT=1', '-e', 'GIT_CONFIG_KEY_0=safe.directory', '-e', 'GIT_CONFIG_VALUE_0=/workspace/repo'];
const ALLOWED_TOOLS = [
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  'Bash(npm:*)', 'Bash(npx:*)', 'Bash(node:*)', 'Bash(ls:*)', 'Bash(cat:*)',
  'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
].join(',');

// ── process helpers (no shell: every argument is passed as-is) ──────────────

interface RunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function run(cmd: string, args: string[], opts: SpawnSyncOptions = {}): RunResult {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`${cmd} ${args[0] ?? ''}: ${r.error.message}`);
  return { status: r.status, stdout: (r.stdout as string) ?? '', stderr: (r.stderr as string) ?? '' };
}

function must(cmd: string, args: string[], opts: SpawnSyncOptions = {}): string {
  const r = run(cmd, args, opts);
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed: ${(r.stderr || r.stdout).trim().slice(-2000)}`);
  return r.stdout;
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
  for (const pr of prs) {
    const reason = skipReason(pr);
    if (reason) {
      if (opts.pr) console.log(yellow(`Skipping #${pr.number}: ${reason}`));
      results.push({ pr: pr.number, outcome: 'skipped', detail: reason });
      continue;
    }
    console.log(`\n${bold(`PR #${pr.number}`)} ${pr.title} ${dim(`(${pr.headRefName})`)}`);
    try {
      results.push(await processPr({ pr, repo, engine, imageName, credential, prompt, identity, opts }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(red(`  error: ${msg}`));
      results.push({ pr: pr.number, outcome: 'error', detail: msg });
    }
  }

  console.log(`\n${bold('Update agent summary')}`);
  for (const r of results) {
    const color = r.outcome === 'fixed' || r.outcome === 'dry-run' ? green : r.outcome === 'skipped' ? dim : red;
    console.log(`  #${r.pr}  ${color(r.outcome.padEnd(8))} ${r.detail}`);
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
    return r.status === 0 ? [JSON.parse(r.stdout) as PrInfo] : [];
  }
  const out = must('gh', ['pr', 'list', '--repo', repo, '--author', 'app/renovate', '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
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
  const { pr, repo, engine, opts } = ctx;
  const name = `update-agent-pr-${pr.number}`;
  const dir = path.join(CONFIG_DIR, 'update-agent', `pr-${pr.number}`);
  // Mounted at /workspace. Its root holds no .git, so the gateway mounts it as-is
  // instead of creating a worktree (gateway/src/worktree.ts).
  const ws = path.join(dir, 'workspace');
  const publish = path.join(dir, 'publish'); // trusted clone: never mounted
  fs.rmSync(dir, { recursive: true, force: true });
  for (const d of ['input', 'out']) fs.mkdirSync(path.join(ws, d), { recursive: true });

  const clone = (dest: string, depth: string) =>
    must('gh', ['repo', 'clone', repo, dest, '--', '--config', 'core.autocrlf=false', '--quiet', '--no-tags', '--single-branch', '--depth', depth, '--branch', pr.headRefName]);
  clone(path.join(ws, 'repo'), '50');
  clone(publish, '1');
  const head = must('git', ['-C', publish, 'rev-parse', 'HEAD']).trim();
  if (head !== pr.headRefOid) return { pr: pr.number, outcome: 'skipped', detail: 'branch moved while starting; run again' };

  writeInputs(ctx, path.join(ws, 'input'));

  try {
    console.log(dim(`  starting ${name} (airlocked: npm registry + Anthropic API only)`));
    await post(`/api/docker/containers/${name}/airlock`, { airlocked: true });
    await post(`/api/rules/import?container=${encodeURIComponent(name)}`, { mode: 'replace', rules: AGENT_RULES });
    await post('/api/docker/start', {
      imageName: ctx.imageName,
      containerName: name,
      ideName: 'vscode',
      mounts: [{ hostPath: ws.replace(/\\/g, '/'), containerPath: '/workspace' }],
      containerWorkspace: '/workspace/repo',
    });
    const { placeholder } = await post<{ placeholder: string }>(`/api/docker/containers/${name}/token`, { secret: ctx.credential.secret });

    const exec = (args: string[], workdir: string, extra: SpawnSyncOptions = {}) =>
      run(engine, ['exec', '-u', 'vscode', '-w', workdir, '-e', `${ctx.credential.env}=${placeholder}`, ...GIT_SAFE_DIR_ENV, name, ...args], extra);

    let lastFailure = '';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      console.log(dim(`  attempt ${attempt}/${MAX_ATTEMPTS}: running Claude Code`));
      const task = attempt === 1
        ? ctx.prompt
        : `${ctx.prompt}\n\nThis is attempt ${attempt}. Your previous change did not pass verification; ` +
          `the output is in /workspace/input/verify-${attempt - 1}.log. Fix that, keeping the earlier work where it is right.`;
      const claude = exec(['claude', '-p', task, '--max-turns', '40', '--allowedTools', ALLOWED_TOOLS], '/workspace/repo', {
        stdio: ['ignore', 'inherit', 'inherit'],
        timeout: CLAUDE_TIMEOUT_MS,
      });

      if (!exec(['git', 'status', '--porcelain'], '/workspace/repo').stdout.trim()) {
        if (claude.status !== 0) {
          throw new Error(`Claude Code exited with ${claude.status ?? 'a timeout'} without changes. Check the credential and the requested rules for ${name} in the portal.`);
        }
        lastFailure = 'the agent made no changes';
        continue;
      }
      console.log(dim('  verifying: npm ci, build and test in every project'));
      lastFailure = verify(exec);
      if (!lastFailure) break;
      fs.writeFileSync(path.join(ws, 'input', `verify-${attempt}.log`), tail(lastFailure, 30_000));
      console.log(yellow(`  verification failed`));
    }
    if (lastFailure) return await giveUp(ctx, `failed after ${MAX_ATTEMPTS} attempts`, lastFailure);

    // Commit inside the container under the developer's name, then hand it out as a bundle.
    const msgFile = path.join(ws, 'out', 'commit-msg.txt');
    if (!fs.existsSync(msgFile) || !fs.readFileSync(msgFile, 'utf8').trim()) {
      fs.writeFileSync(msgFile, `fix(deps): adapt code for ${pr.title}\n`);
    }
    const git = (args: string[]) => exec(['git', '-c', `user.name=${ctx.identity.name}`, '-c', `user.email=${ctx.identity.email}`, ...args], '/workspace/repo');
    for (const args of [['add', '-A'], ['commit', '-q', '-F', '/workspace/out/commit-msg.txt'], ['bundle', 'create', '/workspace/out/agent.bundle', 'HEAD', `^${pr.headRefOid}`]]) {
      const r = git(args);
      if (r.status !== 0) throw new Error(`git ${args[0]} in the container failed: ${(r.stderr || r.stdout).trim()}`);
    }

    // From here on only the trusted clone is used.
    must('git', ['-C', publish, 'fetch', '--quiet', path.join(ws, 'out', 'agent.bundle'), 'HEAD']);
    const fixed = must('git', ['-C', publish, 'rev-parse', 'FETCH_HEAD']).trim();
    if (run('git', ['-C', publish, 'merge-base', '--is-ancestor', pr.headRefOid, fixed]).status !== 0) {
      return await giveUp(ctx, 'the result does not build on the PR head', '');
    }
    const files = parseNameStatus(must('git', ['-C', publish, 'diff', '--name-status', pr.headRefOid, fixed]));
    const blocked = guardViolations(files.map((f) => f.path));
    if (blocked.length) {
      return await giveUp(ctx, 'blocked by the path guard', `The agent changed files only a person may change:\n${blocked.join('\n')}`);
    }
    const flags = testWeakeningFlags(files, must('git', ['-C', publish, 'diff', '-U0', pr.headRefOid, fixed]));
    const summaryFile = path.join(ws, 'out', 'summary.md');
    const summary = fs.existsSync(summaryFile) ? fs.readFileSync(summaryFile, 'utf8').trim() : '_The agent wrote no summary._';
    const comment = [
      `### Update agent: fixed the build`,
      '',
      tail(summary, 20_000),
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
  } finally {
    await cleanup(name, opts.keep);
    if (!opts.keep) fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeInputs(ctx: Ctx, input: string): void {
  const { pr, repo } = ctx;
  const view = JSON.parse(must('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'title,body'])) as { title: string; body: string };
  fs.writeFileSync(path.join(input, 'pr.md'), `# ${view.title}\n\n${view.body ?? ''}\n`);
  const logs = failedRunIds(pr).map((id) => {
    const r = run('gh', ['run', 'view', id, '--repo', repo, '--log-failed']);
    return `===== run ${id} =====\n${r.status === 0 ? r.stdout : `(could not read log: ${r.stderr.trim()})`}`;
  });
  fs.writeFileSync(path.join(input, 'failure.log'), tail(logs.join('\n') || 'No GitHub Actions log found for the failing checks.', 60_000));
}

/** Runs what CI runs. Returns '' when everything passes, otherwise the failing output. */
function verify(exec: (args: string[], workdir: string, extra?: SpawnSyncOptions) => RunResult): string {
  for (const project of PROJECTS) {
    const r = exec(
      ['bash', '-lc', 'npm ci --no-audit --no-fund && npm run build --if-present && CI=true npm test --if-present'],
      `/workspace/repo/${project}`,
      { timeout: VERIFY_TIMEOUT_MS },
    );
    if (r.status !== 0) return `### ${project} failed (exit ${r.status ?? 'timeout'})\n${r.stdout}\n${r.stderr}`;
  }
  return '';
}

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
