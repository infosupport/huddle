import fs from 'fs';
import path from 'path';
import { get } from './api';
import {
  AgentRule,
  Credential,
  RunResult,
  actionsRunUrl,
  claudeCredential,
  cleanup,
  containerExists,
  fetchPrompt,
  inActions,
  isInterrupted,
  must,
  parseClaudeOutput,
  printUntrusted,
  removeDir,
  run,
  runFacts,
  saveNetworkLog,
  startAgent,
  wipeWorkspace,
  withInterruptHandler,
} from './agent-container';
import { CONFIG_DIR } from './config';
import { GithubApp, appConfigFromEnv } from './github-app';
import { resolveRuntime } from './runtime';
import {
  Bump,
  TRIAGE_MARKER,
  TriagePrInfo,
  TriageReport,
  advisoryIds,
  decideTriage,
  lockfileBumps,
  ownCommentId,
  parseTriage,
  renderComment,
  renderPrivate,
} from './triage-agent-guard';
import { bold, dim, green, red, yellow } from './utils';

// `huddle triage-agent [PR]`: reads the advisory behind a `security` PR and
// writes an impact analysis for the reviewer (design doc, Part 2, Agent 3).
// Split of power, as for the update agent (agent-container.ts):
// - The CONTAINER reads the PR's code, the advisory and the upstream fix. It
//   has no GitHub credentials, reaches only the hosts in TRIAGE_RULES, and
//   holds a placeholder instead of the real Claude credential.
// - The HOST (this CLI) does every GitHub read and write. It checks the
//   agent's triage.json and writes the comment itself, in a fixed format: the
//   agent read untrusted advisory text and commit messages, so nothing it
//   wrote renders as a link, mention or markup. It only comments: it never
//   approves, labels, pushes or merges.

export interface TriageAgentOptions {
  pr?: number;
  dryRun: boolean;
  keep: boolean;
  /** Folder for each run's network log (pr-<n>-network.json) and a withheld analysis (pr-<n>-private.md). */
  out?: string;
  runtime?: string;
}

type Outcome = 'commented' | 'dry-run' | 'skipped' | 'error';

interface Result {
  pr: number;
  outcome: Outcome;
  detail: string;
}

const MAX_TURNS = 60;
const CLAUDE_TIMEOUT_MS = 20 * 60 * 1000;
const PROMPT_PATH = '.github/agent/triage-agent.md';
const PR_FIELDS = 'number,title,author,isCrossRepository,headRefName,headRefOid,labels';
/** The design doc's allowlist for the triage agent (airlock mode, so no global rules apply). */
const TRIAGE_RULES: AgentRule[] = [
  { domain: 'registry.npmjs.org', status: 'allow' }, // npm view, npm pack of the old and new version
  { domain: 'github.com', status: 'allow' },
  { domain: 'api.github.com', status: 'allow' }, // advisories and the upstream fix commit, unauthenticated
  { domain: 'api.osv.dev', status: 'allow' },
  { domain: 'api.anthropic.com', status: 'allow' },
  { domain: 'huddle', status: 'allow' }, // huddle's own audit forwarder
];
/**
 * What reading needs. The file tools write only in /workspace/out, but these
 * shell commands can write files and run code inside the container (`tar
 * --to-command`, `npm pack` of a local folder runs its prepack script): the
 * airlocked, credential-free container is the boundary, not this list. The
 * prompt asks for `npm pack <name>@<version> --ignore-scripts` and never
 * `npm install`, so the bumped package's install scripts are not run on purpose.
 */
const ALLOWED_TOOLS = [
  'Read', 'Glob', 'Grep', 'Write(//workspace/out/**)', 'Edit(//workspace/out/**)',
  'Bash(curl:*)', 'Bash(npm view:*)', 'Bash(npm pack:*)', 'Bash(tar:*)', 'Bash(diff:*)', 'Bash(mkdir:*)',
  'Bash(ls:*)', 'Bash(cat:*)', 'Bash(head:*)',
  'Bash(git log:*)', 'Bash(git show:*)', 'Bash(git diff:*)', 'Bash(git grep:*)',
].join(',');
/** A token for comments only, when the CLI runs as a GitHub App. */
const APP_PERMISSIONS = { contents: 'read', pull_requests: 'write' } as const;

// ── entry point ──────────────────────────────────────────────────────────────

export async function runTriageAgent(opts: TriageAgentOptions): Promise<void> {
  const engine = resolveRuntime(opts.runtime).name;
  // With a GitHub App, or the token in GH_TOKEN (the CI job's own), or the developer's `gh` login.
  const appConfig = appConfigFromEnv();
  const app = appConfig ? new GithubApp(appConfig, APP_PERMISSIONS) : null;
  delete process.env.HUDDLE_GITHUB_APP_PRIVATE_KEY;
  if (app) await app.refresh();
  else if (!process.env.GH_TOKEN && !process.env.GITHUB_TOKEN && run('gh', ['auth', 'status']).status !== 0) {
    throw new Error('GitHub CLI is not logged in. Run `gh auth login` first.');
  }
  const repo = app?.repo ?? (process.env.GH_REPO?.trim() || must('gh', ['repo', 'view', '--json', 'nameWithOwner', '-q', '.nameWithOwner']).trim());
  const credential = claudeCredential();
  // Doubles as the "is Huddle running and are we authenticated" check.
  const { imageName } = await get<{ imageName: string }>('/api/docker/base-image?ide=vscode');
  const prompt = fetchPrompt(repo, PROMPT_PATH, 'HUDDLE_TRIAGE_AGENT_PROMPT_REF', 'triage agent');
  const login = app ? (await app.identity()).name : githubLogin();
  const refreshGithub = async () => { await app?.refresh(); };

  const prs = listPrs(repo, opts.pr);
  if (prs.length === 0) {
    console.log(opts.pr ? `PR #${opts.pr} not found.` : 'No open PRs labelled security.');
    return;
  }

  const results: Result[] = [];
  await withInterruptHandler(() => processAll(prs, { repo, engine, imageName, credential, prompt, login, opts, refreshGithub }, results));

  console.log(`\n${bold('Triage agent summary')}`);
  for (const r of results) {
    const color = r.outcome === 'commented' || r.outcome === 'dry-run' ? green : r.outcome === 'skipped' ? dim : red;
    console.log(`  #${r.pr}  ${color(r.outcome.padEnd(9))} ${r.detail}`);
  }
  if (results.some((r) => r.outcome === 'error')) process.exitCode = 1;
}

/** Who posts the comment, to find its own earlier one: the developer, or the CI job's token. */
function githubLogin(): string {
  const r = run('gh', ['api', 'user', '-q', '.login']);
  if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  // The job's GITHUB_TOKEN cannot read /user; its comments are github-actions[bot]'s.
  if (inActions()) return 'github-actions[bot]';
  throw new Error(`Could not read your GitHub login: ${r.stderr.trim()}`);
}

function listPrs(repo: string, only?: number): TriagePrInfo[] {
  if (only) {
    const r = run('gh', ['pr', 'view', String(only), '--repo', repo, '--json', PR_FIELDS]);
    if (r.status === 0) return [JSON.parse(r.stdout) as TriagePrInfo];
    if (/could not resolve|not found/i.test(r.stderr)) return [];
    throw new Error(`gh pr view ${only} failed: ${r.stderr.trim()}`);
  }
  const out = must('gh', ['pr', 'list', '--repo', repo, '--label', 'security', '--state', 'open', '--limit', '100', '--json', PR_FIELDS]);
  return JSON.parse(out) as TriagePrInfo[];
}

interface Ctx {
  pr: TriagePrInfo;
  repo: string;
  engine: string;
  imageName: string;
  credential: Credential;
  prompt: string;
  login: string;
  opts: TriageAgentOptions;
  refreshGithub: () => Promise<void>;
  usage: { costUsd: number; turns: number };
  container?: string;
}

async function processAll(prs: TriagePrInfo[], base: Omit<Ctx, 'pr' | 'usage'>, results: Result[]): Promise<void> {
  const { opts } = base;
  for (const pr of prs) {
    if (isInterrupted()) break;
    const decision = decideTriage(pr);
    if (decision.action === 'skip') {
      if (opts.pr) console.log(yellow(`Skipping #${pr.number}: ${decision.reason}`));
      results.push({ pr: pr.number, outcome: 'skipped', detail: decision.reason });
      continue;
    }
    console.log(`\n${bold(`PR #${pr.number}`)} ${pr.title} ${dim(`(${pr.headRefName})`)}`);
    const ctx: Ctx = { ...base, pr, usage: { costUsd: 0, turns: 0 } };
    try {
      await ctx.refreshGithub();
      results.push(await processPr(ctx));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      printUntrusted(`  error: ${msg}`, red, 20_000, true);
      results.push({ pr: pr.number, outcome: 'error', detail: msg });
    }
  }
}

// ── one PR ───────────────────────────────────────────────────────────────────

async function processPr(ctx: Ctx): Promise<Result> {
  const { pr, opts } = ctx;
  const name = `triage-agent-pr-${pr.number}`;
  const dir = path.join(CONFIG_DIR, 'triage-agent', `pr-${pr.number}`);
  // A container from an earlier --keep run is someone's debugging session.
  if (await containerExists(name)) {
    return { pr: pr.number, outcome: 'skipped', detail: `container ${name} from an earlier --keep run still exists; remove it first` };
  }
  fs.rmSync(dir, { recursive: true, force: true });
  try {
    return await triagePr(ctx, name, path.join(dir, 'workspace'));
  } finally {
    if (opts.out && ctx.container) {
      try {
        await saveNetworkLog(ctx.container, path.join(opts.out, `pr-${pr.number}-network.json`), { pr: pr.number });
      } catch (err) {
        console.log(yellow(`  could not write the network log: ${err instanceof Error ? err.message : String(err)}`));
      }
    }
    if (!opts.keep && ctx.container) wipeWorkspace(ctx.engine, name);
    await cleanup(name, opts.keep);
    if (!opts.keep) removeDir(dir);
  }
}

/** dir/workspace is mounted at /workspace: repo/ (the PR head), input/ and out/. */
async function triagePr(ctx: Ctx, name: string, ws: string): Promise<Result> {
  const { pr, repo } = ctx;
  for (const d of ['input', 'out']) fs.mkdirSync(path.join(ws, d), { recursive: true });
  const repoDir = path.join(ws, 'repo');
  must('gh', ['repo', 'clone', repo, repoDir, '--', '--config', 'core.autocrlf=false', '--quiet', '--no-tags', '--single-branch', '--depth', '1', '--branch', pr.headRefName]);
  if (must('git', ['-C', repoDir, 'rev-parse', 'HEAD']).trim() !== pr.headRefOid) {
    return { pr: pr.number, outcome: 'skipped', detail: 'branch moved while starting; run again' };
  }
  // Listed before the container exists: afterwards the host never reads the mounted folder.
  const knownFiles = new Set(must('git', ['-C', repoDir, 'ls-tree', '-r', '-z', '--name-only', 'HEAD']).split('\0').filter(Boolean));
  const { bumps, advisories } = writeInputs(ctx, path.join(ws, 'input'));

  ctx.container = name;
  const agent = await startAgent({
    name, engine: ctx.engine, imageName: ctx.imageName, credential: ctx.credential, rules: TRIAGE_RULES, workspace: ws,
    description: 'airlocked: npm registry, GitHub, OSV and Anthropic API only',
  });
  console.log(dim('  running Claude Code'));
  const model = process.env.HUDDLE_TRIAGE_AGENT_MODEL?.trim();
  const claude = await agent.exec([
    'claude', '-p', ctx.prompt, '--output-format', 'json', '--max-turns', String(MAX_TURNS),
    ...(model ? ['--model', model] : []), '--allowedTools', ALLOWED_TOOLS,
  ], '/workspace/repo', { timeout: CLAUDE_TIMEOUT_MS, liveStderr: !inActions() });
  reportClaude(ctx, claude);
  agent.stopAll();

  const raw = (await agent.readFile('/workspace/out/triage.json')).trim();
  if (!raw && claude.status !== 0) {
    // Not the PR's fault: credential, firewall or Claude Code itself.
    throw new Error(`Claude Code ${claude.timedOut ? 'timed out' : `exited with ${claude.status}`} without an analysis. ` +
      `Check the credential and the requested rules for ${name} in the portal.`);
  }
  const parsed = raw ? parseTriage(raw, knownFiles) : { ok: false as const, errors: ['the agent wrote no triage.json'] };
  let report: TriageReport | null = null;
  let problem: string | undefined;
  if (parsed.ok) {
    report = parsed.report;
  } else {
    problem = 'the agent wrote no valid analysis';
    console.log(yellow(`  ${problem}:\n${parsed.errors.map((e) => `    ${e}`).join('\n')}`));
    // An unchecked file can still hold an analysis that must stay private: keep it as is.
    if (claimsBeyondAdvisory(raw)) keepPrivate(ctx, `# Triage agent: ${repo} PR #${pr.number} (triage.json failed the check)\n\n\`\`\`json\n${raw}\n\`\`\`\n`);
  }
  if (report?.beyondAdvisory) keepPrivate(ctx, renderPrivate(report, { number: pr.number, title: pr.title, repo }));

  const url = actionsRunUrl();
  const body = renderComment({
    report, problem, bumps, advisories, repo, headSha: pr.headRefOid,
    facts: await runFacts(ctx.container, ctx.usage),
    runner: url ? `Run by [GitHub Actions](${url})` : `Run by ${ctx.login}`,
  });
  const verdict = report ? (report.beyondAdvisory ? 'withheld, deep-dive' : `affected: ${report.affected}`) : 'no valid analysis';
  if (ctx.opts.dryRun) {
    console.log(dim('\n--- PR comment that would be posted ---'));
    printUntrusted(body, (s) => s, 40_000);
    return { pr: pr.number, outcome: 'dry-run', detail: `${verdict}; nothing posted` };
  }
  await ctx.refreshGithub();
  postComment(ctx, body);
  return { pr: pr.number, outcome: 'commented', detail: verdict };
}

/**
 * The PR's title and body, what its lockfiles bump, and the GitHub advisories
 * it names, read with the host's GitHub access (the container has none).
 */
function writeInputs(ctx: Ctx, input: string): { bumps: Bump[]; advisories: string[] } {
  const { pr, repo } = ctx;
  const view = JSON.parse(must('gh', ['pr', 'view', String(pr.number), '--repo', repo, '--json', 'title,body,baseRefName,files'])) as {
    title: string;
    body: string;
    baseRefName: string;
    files?: { path: string }[];
  };
  fs.writeFileSync(path.join(input, 'pr.md'), `# ${view.title}\n\n${view.body ?? ''}\n`);

  // Versions at the merge base, as the PR's diff shows them.
  const mergeBase = must('gh', ['api', `repos/${repo}/compare/${encodeURIComponent(view.baseRefName)}...${pr.headRefOid}`, '-q', '.merge_base_commit.sha']).trim();
  const readAt = (file: string, ref: string): string | null => {
    const r = run('gh', ['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${file.split('/').map(encodeURIComponent).join('/')}?ref=${ref}`]);
    if (r.status === 0) return r.stdout;
    if (/HTTP 404/.test(r.stderr)) return null;
    throw new Error(`could not read ${file} at ${ref}: ${r.stderr.trim()}`);
  };
  const bumps: Bump[] = [];
  for (const f of view.files ?? []) {
    if (!/(^|\/)package-lock\.json$/.test(f.path)) continue;
    bumps.push(...lockfileBumps(f.path, readAt(f.path, mergeBase), readAt(f.path, pr.headRefOid)));
  }
  fs.writeFileSync(path.join(input, 'bumps.json'), `${JSON.stringify(bumps, null, 2)}\n`);

  const advisories = advisoryIds(`${view.title}\n${view.body ?? ''}`);
  fs.mkdirSync(path.join(input, 'advisories'));
  for (const id of advisories.slice(0, 10)) {
    const r = id.startsWith('GHSA-')
      ? run('gh', ['api', `advisories/${id}`])
      : run('gh', ['api', `advisories?cve_id=${id}`]);
    // A CVE search answers with a list, empty when GitHub has no advisory for it.
    const found = r.status === 0 && r.stdout.trim() !== '[]';
    fs.writeFileSync(path.join(input, 'advisories', `${id}.json`), found ? r.stdout : `{"error": "not found on GitHub; look it up on OSV"}\n`);
  }
  console.log(dim(`  ${bumps.length} package version change(s), advisories: ${advisories.join(', ') || 'none named in the PR'}`));
  return { bumps, advisories };
}

function claimsBeyondAdvisory(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { beyondAdvisory?: unknown } | null)?.beyondAdvisory === true;
  } catch {
    return false;
  }
}

/** Prints the agent's final answer (not in Actions: the log is public) and adds its cost and turns to ctx.usage. */
function reportClaude(ctx: Ctx, r: RunResult): void {
  const out = parseClaudeOutput(r.stdout);
  if (out) {
    ctx.usage.costUsd += out.costUsd;
    ctx.usage.turns += out.turns;
  }
  // Its answer may hold an analysis that must stay private (beyondAdvisory).
  if (!inActions()) {
    if (out?.result) printUntrusted(out.result.replace(/^/gm, '    '));
    else if (!out && r.stdout.trim()) printUntrusted(r.stdout.trim());
  }
  if (r.status !== 0 && r.stderr.trim()) printUntrusted(r.stderr.trim());
}

/**
 * An analysis that goes beyond the advisory is not posted (design doc,
 * "Keeping vulnerabilities private"). With --out it is written next to the
 * network log, for the workflow to encrypt; locally it is printed.
 */
function keepPrivate(ctx: Ctx, markdown: string): void {
  const { pr, opts } = ctx;
  if (opts.out) {
    fs.mkdirSync(opts.out, { recursive: true });
    const file = path.join(opts.out, `pr-${pr.number}-private.md`);
    fs.writeFileSync(file, markdown, { mode: 0o600 });
    console.log(yellow(`  the analysis goes beyond the advisory: written to ${file}, not posted`));
  } else if (!inActions()) {
    console.log(yellow('  the analysis goes beyond the advisory, so it is not posted. Share it with maintainers privately:'));
    printUntrusted(markdown, (s) => s, 40_000);
  } else {
    console.log(yellow('  the analysis goes beyond the advisory; without --out it is not kept anywhere'));
  }
}

/** Updates this login's earlier triage comment on the PR, or adds one. */
function postComment(ctx: Ctx, body: string): void {
  const { pr, repo, login } = ctx;
  const lines = must('gh', [
    'api', '--paginate', `repos/${repo}/issues/${pr.number}/comments`,
    '--jq', `.[] | select(.body | startswith(${JSON.stringify(TRIAGE_MARKER)})) | "\\(.id)\\t\\(.user.login)"`,
  ]);
  const id = ownCommentId(lines, login);
  if (id) {
    must('gh', ['api', '-X', 'PATCH', `repos/${repo}/issues/comments/${id}`, '--input', '-'], { input: JSON.stringify({ body }) });
    console.log(green(`  updated the triage comment on #${pr.number}`));
  } else {
    must('gh', ['pr', 'comment', String(pr.number), '--repo', repo, '--body-file', '-'], { input: body });
    console.log(green(`  commented on #${pr.number}`));
  }
}
