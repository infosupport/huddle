// Pure decision logic for `huddle update-agent`: which PRs to work on, which
// files the agent may never change, and which changes a reviewer should look at
// twice. No I/O here, so it is unit-tested in cli/test/.

/** Files only a person may change (design doc, Part 2 "Agents never"). */
const GUARDED: RegExp[] = [
  /^\.github\//,
  /(^|\/)renovate\.json5?$/,
  /(^|\/)Dockerfile[^/]*$/,
  /^base-devimage[^/]*\//,
  // The security boundary: auth, TLS interception, firewall decisions, the
  // Docker socket filter, sudo grants and the credential exchange.
  /^gateway\/src\/(auth|tls-ca|proxy|rules|socket-proxy|docker-actions|sudo-grant|token-exchange|token-exchange-api)\.ts$/,
];

export function isGuardedPath(file: string): boolean {
  const p = file.replace(/\\/g, '/');
  return GUARDED.some((re) => re.test(p));
}

/** Changed files the agent was not allowed to touch (empty = OK). */
export function guardViolations(changedFiles: string[]): string[] {
  return changedFiles.filter(isGuardedPath);
}

export interface NameStatus {
  status: string; // git --name-status letter: A, M, D, R100, ...
  path: string;
}

/** Parses `git diff --name-status` output. For renames, the old path counts as deleted. */
export function parseNameStatus(output: string): NameStatus[] {
  const out: NameStatus[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const [status, ...paths] = line.split('\t');
    if (status.startsWith('R') && paths.length === 2) {
      out.push({ status: 'D', path: paths[0] }, { status: 'A', path: paths[1] });
    } else if (paths[0]) {
      out.push({ status: status[0], path: paths[0] });
    }
  }
  return out;
}

const TEST_FILE = /(^|\/)(test|tests|__tests__|e2e)\/|\.(test|spec|e2e)\.[cm]?[jt]sx?$/;

/**
 * Signs that a test was weakened instead of the code being fixed. These are
 * flags for the reviewer, not a hard block: removing an assertion can be the
 * right fix for an API that changed.
 */
export function testWeakeningFlags(files: NameStatus[], unifiedDiff: string): string[] {
  const flags: string[] = [];
  for (const f of files) {
    if (f.status === 'D' && TEST_FILE.test(f.path)) flags.push(`deleted test file ${f.path}`);
  }
  let added = 0;
  let removed = 0;
  for (const line of unifiedDiff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue;
    if (line.startsWith('+') && /\b(it|test|describe)\.(skip|only|todo)\b|\bx(it|describe)\(/.test(line)) {
      flags.push(`added ${line.slice(1).trim().slice(0, 80)}`);
    }
    if (/\bexpect\(/.test(line)) {
      if (line.startsWith('+')) added++;
      else if (line.startsWith('-')) removed++;
    }
  }
  if (removed > added) flags.push(`${removed - added} fewer expect() assertions`);
  return flags;
}

// ── PR selection ─────────────────────────────────────────────────────────────

export interface PrInfo {
  number: number;
  title: string;
  author?: PrAuthor | null;
  isCrossRepository?: boolean;
  headRefName: string;
  headRefOid: string;
  labels: { name: string }[];
  statusCheckRollup: CheckInfo[];
  commits: { authors: CommitAuthor[]; messageBody?: string | null }[];
}

/** One entry of `gh --json statusCheckRollup`: a check run has a `conclusion`, a commit status a `state`. */
export interface CheckInfo {
  conclusion?: string | null;
  state?: string | null;
  workflowName?: string | null;
  detailsUrl?: string | null;
  targetUrl?: string | null;
}

/** The PR author as `gh --json author` gives it: GitHub-verified, unlike commit metadata. */
export interface PrAuthor {
  login?: string | null;
  is_bot?: boolean | null;
}

export interface CommitAuthor {
  login?: string | null;
  name?: string | null;
  email?: string | null;
}

export const GAVE_UP_LABEL = 'agent-gave-up';
/** Renovate adds it to major updates (`addLabels` on the majors rule in renovate.json5); see --skip-majors. */
export const MAJOR_LABEL = 'major';
/** Trailer the CLI adds to every commit the agent pushes, so a later run recognises it. */
export const AGENT_TRAILER = 'Huddle-Update-Agent';
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const SAFE_REF_CHARS = /^[A-Za-z0-9._\/()+-]+$/;

/** Renovate's GitHub account, as `gh --author` takes it: the Mend app unless HUDDLE_RENOVATE_AUTHOR says otherwise. */
export function renovatePrAuthor(): string {
  return process.env.HUDDLE_RENOVATE_AUTHOR?.trim() || 'app/renovate';
}

/**
 * Whether GitHub says Renovate opened the PR. An `app/<name>` author must be
 * that app's bot account, so a user who happens to be called "renovate" does
 * not pass.
 */
export function isRenovatePrAuthor(author: PrAuthor | null | undefined, expected = renovatePrAuthor()): boolean {
  const login = (author?.login ?? '').trim().toLowerCase();
  const want = expected.trim().toLowerCase();
  if (!login) return false;
  if (want.startsWith('app/')) {
    return author?.is_bot === true && (login === want || login === `${want.slice(4)}[bot]`);
  }
  return login === want;
}

/** Renovate's branchPrefix: 'renovate/' unless HUDDLE_RENOVATE_BRANCH_PREFIX says otherwise. */
export function renovateBranchPrefix(): string {
  return process.env.HUDDLE_RENOVATE_BRANCH_PREFIX?.trim() || 'renovate/';
}

/** A branch Renovate made, with only characters that are safe to pass to git. */
export function isRenovateBranch(branch: string, prefix = renovateBranchPrefix()): boolean {
  return branch.startsWith(prefix) && branch.length > prefix.length && SAFE_REF_CHARS.test(branch);
}

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|approved-by|tested-by|reported-by|huddle-update-agent)\s*:/i;

/**
 * The agent writes its own commit message after reading untrusted input. Keep
 * it, but drop attribution trailers (they would credit or implicate other
 * people) and cap its size. Falls back when nothing usable is left. Ends with
 * the AGENT_TRAILER, so a later run knows this commit is the agent's.
 */
export function sanitizeCommitMessage(message: string, fallback: string, source = 'huddle update-agent'): string {
  const lines = message.replace(/\r\n/g, '\n').split('\n').filter((l) => !TRAILER.test(l.trim()));
  const subject = (lines.shift() ?? '').trim().slice(0, 100) || fallback;
  const body = lines.join('\n').trim().slice(0, 4000);
  const trailer = `${AGENT_TRAILER}: ${source.replace(/\s+/g, ' ').trim()}`;
  return body ? `${subject}\n\n${body}\n\n${trailer}\n` : `${subject}\n\n${trailer}\n`;
}

/** A commit the update agent pushed: its message carries the AGENT_TRAILER. */
export function isAgentCommit(commit: PrInfo['commits'][number]): boolean {
  return new RegExp(`^${AGENT_TRAILER}:`, 'im').test(commit.messageBody ?? '');
}

/**
 * Renovate as the Mend app (`renovate[bot]`), as a self-hosted bot account
 * (`renovate-bot`, Renovate's default `bot@renovateapp.com` git author), or as
 * extra logins/emails listed in HUDDLE_RENOVATE_AUTHORS (comma-separated).
 */
export function isRenovateAuthor(a: CommitAuthor, extra: string[] = renovateAuthorsFromEnv()): boolean {
  const ids = [a.login, a.name, a.email].map((v) => (v ?? '').trim().toLowerCase()).filter(Boolean);
  return ids.some((id) =>
    /^renovate(\[bot\]|-bot)?$/.test(id) ||
    /^(\d+\+)?renovate\[bot\]@users\.noreply\.github\.com$/.test(id) ||
    id === 'bot@renovateapp.com' ||
    extra.includes(id));
}

function renovateAuthorsFromEnv(): string[] {
  return (process.env.HUDDLE_RENOVATE_AUTHORS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/**
 * The GitHub Actions workflows whose result is "CI" for the agent: 'Test'
 * unless HUDDLE_UPDATE_AGENT_CI_WORKFLOWS (comma-separated) says otherwise.
 * Other red checks are not a build the agent can fix: the security review gate
 * waits for a person, a scanner reports a vulnerability, the test agent
 * reports a security finding.
 */
export function ciWorkflows(): string[] {
  const list = (process.env.HUDDLE_UPDATE_AGENT_CI_WORKFLOWS ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.length ? list : ['Test'];
}

function isFailedCheck(c: CheckInfo, workflows: string[]): boolean {
  if (!workflows.includes((c.workflowName ?? '').trim())) return false;
  return FAILED.has((c.conclusion ?? '').toUpperCase()) || FAILED.has((c.state ?? '').toUpperCase());
}

export function hasFailingChecks(pr: PrInfo, workflows = ciWorkflows()): boolean {
  return pr.statusCheckRollup.some((c) => isFailedCheck(c, workflows));
}

/**
 * The failing GitHub Actions jobs, for `gh run view --job <id> --log`. Job logs
 * are readable as soon as the job finishes, even while other jobs of the same
 * run are still going (`--log-failed` waits for the whole run).
 */
export function failedJobs(pr: PrInfo, workflows = ciWorkflows()): { runId: string; jobId: string }[] {
  const jobs = new Map<string, { runId: string; jobId: string }>();
  for (const c of pr.statusCheckRollup) {
    if (!isFailedCheck(c, workflows)) continue;
    const m = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? '');
    if (m) jobs.set(m[2], { runId: m[1], jobId: m[2] });
  }
  return [...jobs.values()];
}

/** The npm projects CI builds, in build order: the gateway build compiles the frontend. */
export const PROJECTS = ['gateway/frontend', 'gateway', 'cli'] as const;

/**
 * Which projects to verify for a set of changed files. CI checks everything
 * after the push; locally only what the change can break, so a `cli` update
 * does not depend on installing the gateway's native modules. A gateway
 * change needs the frontend too (`build:ui`). A file outside the projects
 * (root config, workflows, ...) could affect any of them, so it means all.
 */
export function affectedProjects(changedFiles: string[]): string[] {
  const hit = new Set<string>();
  for (const raw of changedFiles) {
    const f = raw.replace(/\\/g, '/');
    if (f.startsWith('gateway/')) {
      hit.add('gateway/frontend');
      hit.add('gateway');
    } else if (f.startsWith('cli/')) {
      hit.add('cli');
    } else {
      return [...PROJECTS];
    }
  }
  return PROJECTS.filter((p) => hit.has(p));
}

export type PrDecision =
  | { action: 'fix' }
  | { action: 'skip'; reason: string }
  /** The agent's own fix is on the branch and CI is still red: label the PR for a person. */
  | { action: 'give-up'; reason: string };

/** What the agent should do with this PR. */
export function decide(pr: PrInfo, opts: { skipMajors?: boolean } = {}): PrDecision {
  const skip = (reason: string): PrDecision => ({ action: 'skip', reason });
  // Listing filters on the author already; a PR named on the command line
  // gets the same check here, so a Renovate-looking branch is not enough.
  if (!isRenovatePrAuthor(pr.author)) return skip(`not opened by ${renovatePrAuthor()}`);
  if (pr.isCrossRepository !== false) return skip('not a branch in this repository');
  const prefix = renovateBranchPrefix();
  if (!isRenovateBranch(pr.headRefName, prefix)) return skip(`branch ${pr.headRefName} is not a ${prefix}* branch`);
  if (pr.labels.some((l) => l.name === GAVE_UP_LABEL)) return skip(`labelled ${GAVE_UP_LABEL}`);
  if (opts.skipMajors && pr.labels.some((l) => l.name === MAJOR_LABEL)) return skip(`a major update (labelled ${MAJOR_LABEL})`);
  const others = pr.commits.filter((c) => !c.authors.every((a) => isRenovateAuthor(a)));
  if (others.some((c) => !isAgentCommit(c))) return skip('has commits from someone other than Renovate (already being worked on)');
  const failing = hasFailingChecks(pr);
  // The agent never builds on its own pushed fix: that would lift the limit of
  // MAX_ATTEMPTS. Renovate's rebase checkbox drops the fix to start over.
  if (others.length) {
    return failing
      ? { action: 'give-up', reason: 'CI still fails after the agent\'s fix' }
      : skip('the agent already pushed a fix');
  }
  if (!failing) return skip('CI is not failing');
  return { action: 'fix' };
}
