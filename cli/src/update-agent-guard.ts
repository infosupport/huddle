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
  headRefName: string;
  headRefOid: string;
  labels: { name: string }[];
  statusCheckRollup: { conclusion?: string | null; state?: string | null; detailsUrl?: string | null; targetUrl?: string | null }[];
  commits: { authors: CommitAuthor[] }[];
}

export interface CommitAuthor {
  login?: string | null;
  name?: string | null;
  email?: string | null;
}

export const GAVE_UP_LABEL = 'agent-gave-up';
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const SAFE_REF_CHARS = /^[A-Za-z0-9._\/()+-]+$/;

/** Renovate's branchPrefix: 'renovate/' unless HUDDLE_RENOVATE_BRANCH_PREFIX says otherwise. */
export function renovateBranchPrefix(): string {
  return process.env.HUDDLE_RENOVATE_BRANCH_PREFIX?.trim() || 'renovate/';
}

/** A branch Renovate made, with only characters that are safe to pass to git. */
export function isRenovateBranch(branch: string, prefix = renovateBranchPrefix()): boolean {
  return branch.startsWith(prefix) && branch.length > prefix.length && SAFE_REF_CHARS.test(branch);
}

const TRAILER = /^(co-authored-by|signed-off-by|reviewed-by|acked-by|approved-by|tested-by|reported-by)\s*:/i;

/**
 * The agent writes its own commit message after reading untrusted input. Keep
 * it, but drop attribution trailers (they would credit or implicate other
 * people) and cap its size. Falls back when nothing usable is left.
 */
export function sanitizeCommitMessage(message: string, fallback: string): string {
  const lines = message.replace(/\r\n/g, '\n').split('\n').filter((l) => !TRAILER.test(l.trim()));
  const subject = (lines.shift() ?? '').trim().slice(0, 100);
  if (!subject) return `${fallback}\n`;
  const body = lines.join('\n').trim().slice(0, 4000);
  return body ? `${subject}\n\n${body}\n` : `${subject}\n`;
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

export function hasFailingChecks(pr: PrInfo): boolean {
  return pr.statusCheckRollup.some((c) => FAILED.has((c.conclusion ?? '').toUpperCase()) || FAILED.has((c.state ?? '').toUpperCase()));
}

/**
 * The failing GitHub Actions jobs, for `gh run view --job <id> --log`. Job logs
 * are readable as soon as the job finishes, even while other jobs of the same
 * run are still going (`--log-failed` waits for the whole run).
 */
export function failedJobs(pr: PrInfo): { runId: string; jobId: string }[] {
  const jobs = new Map<string, { runId: string; jobId: string }>();
  for (const c of pr.statusCheckRollup) {
    if (!FAILED.has((c.conclusion || c.state || '').toUpperCase())) continue;
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

/** Why the agent should not touch this PR, or null when it should. */
export function skipReason(pr: PrInfo): string | null {
  const prefix = renovateBranchPrefix();
  if (!isRenovateBranch(pr.headRefName, prefix)) return `branch ${pr.headRefName} is not a ${prefix}* branch`;
  if (pr.labels.some((l) => l.name === GAVE_UP_LABEL)) return `labelled ${GAVE_UP_LABEL}`;
  if (pr.commits.some((c) => !c.authors.every((a) => isRenovateAuthor(a)))) {
    return 'has commits from someone other than Renovate (already being worked on)';
  }
  if (!hasFailingChecks(pr)) return 'CI is not failing';
  return null;
}
