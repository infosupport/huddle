// Pure decision logic for `huddle update-agent`: which PRs to work on, which
// files the agent may never change, and which changes a reviewer should look at
// twice. No I/O here, so it is unit-tested in cli/test/.

/** Files only a person may change (design doc, Part 2 "Agents never"). */
const GUARDED: RegExp[] = [
  /^\.github\//,
  /(^|\/)renovate\.json5?$/,
  /(^|\/)Dockerfile[^/]*$/,
  /^base-devimage[^/]*\//,
  /^gateway\/src\/(auth|tls-ca|socket-proxy|proxy)\.ts$/,
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
  commits: { authors: { login?: string | null; email?: string | null }[] }[];
}

export const GAVE_UP_LABEL = 'agent-gave-up';
const FAILED = new Set(['FAILURE', 'TIMED_OUT', 'CANCELLED', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'ERROR']);
const SAFE_BRANCH = /^renovate\/[A-Za-z0-9._\/()+-]+$/;

export function isRenovateAuthor(a: { login?: string | null; email?: string | null }): boolean {
  return /^renovate(\[bot\])?$/i.test(a.login ?? '') || /\brenovate\[bot\]@users\.noreply\.github\.com$/i.test(a.email ?? '');
}

export function hasFailingChecks(pr: PrInfo): boolean {
  return pr.statusCheckRollup.some((c) => FAILED.has((c.conclusion ?? '').toUpperCase()) || FAILED.has((c.state ?? '').toUpperCase()));
}

/** GitHub Actions run ids of the failing checks, for `gh run view --log-failed`. */
export function failedRunIds(pr: PrInfo): string[] {
  const ids = new Set<string>();
  for (const c of pr.statusCheckRollup) {
    if (!FAILED.has((c.conclusion ?? c.state ?? '').toUpperCase())) continue;
    const m = /\/actions\/runs\/(\d+)/.exec(c.detailsUrl ?? c.targetUrl ?? '');
    if (m) ids.add(m[1]);
  }
  return [...ids];
}

/** Why the agent should not touch this PR, or null when it should. */
export function skipReason(pr: PrInfo): string | null {
  if (!SAFE_BRANCH.test(pr.headRefName)) return `branch ${pr.headRefName} is not a renovate/* branch`;
  if (pr.labels.some((l) => l.name === GAVE_UP_LABEL)) return `labelled ${GAVE_UP_LABEL}`;
  if (pr.commits.some((c) => !c.authors.every(isRenovateAuthor))) {
    return 'has commits from someone other than Renovate (already being worked on)';
  }
  if (!hasFailingChecks(pr)) return 'CI is not failing';
  return null;
}
