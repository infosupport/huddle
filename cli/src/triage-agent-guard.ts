// Pure logic for `huddle triage-agent`: which PRs to triage, what the PR
// bumps, and turning the agent's analysis into the one PR comment. The agent
// read untrusted advisory text and upstream commits, so the CLI checks every
// field and writes the comment itself; nothing the agent wrote can add a
// link, a mention or markup. No I/O here, so it is unit-tested in cli/test/.

import { PrAuthor, isRenovateBranch, isRenovatePrAuthor, renovateBranchPrefix, renovatePrAuthor } from './update-agent-guard';

export const SECURITY_LABEL = 'security';
/** Branches made by scripts/security-bump.sh. */
export const SECURITY_BRANCH_PREFIX = 'security/';
/** First line of every triage comment, so a re-run updates it instead of adding another. */
export const TRIAGE_MARKER = '<!-- huddle-triage-agent -->';

// ── PR selection ─────────────────────────────────────────────────────────────

export interface TriagePrInfo {
  number: number;
  title: string;
  author?: PrAuthor | null;
  isCrossRepository?: boolean;
  headRefName: string;
  headRefOid: string;
  labels: { name: string }[];
}

export type TriageDecision = { action: 'triage' } | { action: 'skip'; reason: string };

/**
 * A PR labelled `security`, on a branch in this repository, that either
 * Renovate opened (its vulnerability alerts) or that comes from a
 * `security/*` branch (security-bump.sh, opened by a person).
 */
export function decideTriage(pr: TriagePrInfo): TriageDecision {
  const skip = (reason: string): TriageDecision => ({ action: 'skip', reason });
  if (!pr.labels.some((l) => l.name === SECURITY_LABEL)) return skip(`not labelled ${SECURITY_LABEL}`);
  if (pr.isCrossRepository !== false) return skip('not a branch in this repository');
  const prefix = renovateBranchPrefix();
  const fromRenovate = isRenovatePrAuthor(pr.author) && isRenovateBranch(pr.headRefName, prefix);
  const fromBump = isRenovateBranch(pr.headRefName, SECURITY_BRANCH_PREFIX);
  if (!fromRenovate && !fromBump) {
    return skip(`neither a ${prefix}* PR opened by ${renovatePrAuthor()} nor a ${SECURITY_BRANCH_PREFIX}* branch`);
  }
  return { action: 'triage' };
}

// ── what the PR bumps ────────────────────────────────────────────────────────

const NPM_NAME = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const VERSION = /^[0-9A-Za-z.+-]{1,64}$/;
const isNpmName = (s: unknown): s is string => typeof s === 'string' && s.length <= 214 && NPM_NAME.test(s);
const isVersion = (s: unknown): s is string => typeof s === 'string' && VERSION.test(s);

export interface Bump {
  lockfile: string;
  name: string;
  /** Every version of the package in the lockfile, nested copies included. */
  before: string[];
  after: string[];
}

function lockVersions(lockfile: string, text: string | null): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (text === null) return out;
  let json: { packages?: Record<string, { version?: unknown }> };
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${lockfile} is not a valid package-lock.json`);
  }
  for (const [key, entry] of Object.entries(json.packages ?? {})) {
    const i = key.lastIndexOf('node_modules/');
    if (i === -1) continue;
    const name = key.slice(i + 'node_modules/'.length);
    if (!isNpmName(name) || !isVersion(entry?.version)) continue;
    const set = out.get(name) ?? new Set<string>();
    set.add(entry.version);
    out.set(name, set);
  }
  return out;
}

/** Packages whose versions differ between two versions of a package-lock.json (null: the file did not exist). */
export function lockfileBumps(lockfile: string, before: string | null, after: string | null): Bump[] {
  const a = lockVersions(lockfile, before);
  const b = lockVersions(lockfile, after);
  const sorted = (s?: Set<string>) => [...(s ?? [])].sort();
  const bumps: Bump[] = [];
  for (const name of [...new Set([...a.keys(), ...b.keys()])].sort()) {
    const was = sorted(a.get(name));
    const now = sorted(b.get(name));
    if (was.join('\n') !== now.join('\n')) bumps.push({ lockfile, name, before: was, after: now });
  }
  return bumps;
}

const GHSA = /\bGHSA(-[23456789cfghjmpqrvwx]{4}){3}\b/gi;
const CVE = /\bCVE-\d{4}-\d{4,7}\b/gi;
const GHSA_EXACT = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVE_EXACT = /^CVE-\d{4}-\d{4,7}$/;

/** GHSA and CVE ids in a text (the PR title and body), normalised: `GHSA-` + lower case, `CVE-` upper case. */
export function advisoryIds(text: string): string[] {
  const ids = [
    ...[...text.matchAll(GHSA)].map((m) => `GHSA-${m[0].slice(5).toLowerCase()}`),
    ...[...text.matchAll(CVE)].map((m) => m[0].toUpperCase()),
  ];
  return [...new Set(ids)].slice(0, 20);
}

// ── the agent's analysis ─────────────────────────────────────────────────────

export type YesNoUnclear = 'yes' | 'no' | 'unclear';
export type Recommendation = 'merge-low-urgency' | 'merge-now' | 'deep-dive';

export interface Usage {
  file: string;
  startLine: number;
  endLine: number;
  note: string;
}

/** What the agent writes to /workspace/out/triage.json (see .github/agent/triage-agent.md). */
export interface TriageReport {
  packages: { name: string; from: string; to: string }[];
  advisories: string[];
  affected: YesNoUnclear;
  usage: Usage[];
  reachable: YesNoUnclear;
  reachableReason: string;
  breakingChanges: string;
  recommendation: Recommendation;
  /** The agent found a way the issue reaches Huddle that the advisory does not mention: keep it private. */
  beyondAdvisory: boolean;
  /** Only for maintainers, when beyondAdvisory. */
  privateDetails: string;
}

const YNU = ['yes', 'no', 'unclear'];
const RECOMMENDATIONS = ['merge-low-urgency', 'merge-now', 'deep-dive'];
// No `@`: a file name in the link text must not become a mention.
const REPO_PATH = /^[A-Za-z0-9._+-]+(\/[A-Za-z0-9._+-]+)*$/;
const TEXT_MAX = 500;

/**
 * Checks the agent's triage.json. Files must exist in the PR (knownFiles,
 * listed by the CLI before the agent ran). Error messages never quote the
 * agent's values, so they are safe to show.
 */
export function parseTriage(text: string, knownFiles: Set<string>): { ok: true; report: TriageReport } | { ok: false; errors: string[] } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, errors: ['triage.json is not valid JSON'] };
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, errors: ['triage.json is not a JSON object'] };
  const o = raw as Record<string, unknown>;
  const errors: string[] = [];
  const str = (key: string, max = TEXT_MAX, value: unknown = o[key]): string => {
    if (typeof value !== 'string' || value.length > max) {
      errors.push(`${key} must be a string of at most ${max} characters`);
      return '';
    }
    return value;
  };
  const oneOf = <T extends string>(key: string, allowed: string[]): T => {
    if (typeof o[key] !== 'string' || !allowed.includes(o[key] as string)) errors.push(`${key} must be one of ${allowed.join(', ')}`);
    return o[key] as T;
  };
  const list = (key: string, max: number, min = 0): unknown[] => {
    const v = o[key];
    if (!Array.isArray(v) || v.length < min || v.length > max) {
      errors.push(`${key} must be an array of ${min}-${max} entries`);
      return [];
    }
    return v;
  };

  const packages = list('packages', 10, 1).map((p, i) => {
    const e = (p ?? {}) as Record<string, unknown>;
    if (!isNpmName(e.name) || !isVersion(e.from) || !isVersion(e.to)) errors.push(`packages[${i}] needs an npm name and plain from/to versions`);
    return { name: String(e.name), from: String(e.from), to: String(e.to) };
  });
  const advisories = list('advisories', 20).map((a, i) => {
    if (typeof a !== 'string' || !(GHSA_EXACT.test(a) || CVE_EXACT.test(a))) errors.push(`advisories[${i}] must be a GHSA-… or CVE-… id`);
    return String(a);
  });
  const usage = list('usage', 30).map((u, i) => {
    const e = (u ?? {}) as Record<string, unknown>;
    const file = typeof e.file === 'string' ? e.file : '';
    if (!REPO_PATH.test(file) || file.split('/').some((s) => s === '.' || s === '..') || file.length > 300) {
      errors.push(`usage[${i}].file must be a path relative to the repository root`);
    } else if (!knownFiles.has(file)) {
      errors.push(`usage[${i}].file is not a file in the PR`);
    }
    const okLine = (n: unknown) => Number.isInteger(n) && (n as number) >= 1 && (n as number) <= 1_000_000;
    if (!okLine(e.startLine) || !okLine(e.endLine) || (e.startLine as number) > (e.endLine as number)) {
      errors.push(`usage[${i}] needs lines with 1 <= startLine <= endLine`);
    }
    return { file, startLine: Number(e.startLine), endLine: Number(e.endLine), note: str(`usage[${i}].note`, 200, e.note) };
  });
  const affected = oneOf<YesNoUnclear>('affected', YNU);
  const reachable = oneOf<YesNoUnclear>('reachable', YNU);
  const recommendation = oneOf<Recommendation>('recommendation', RECOMMENDATIONS);
  const reachableReason = str('reachableReason');
  const breakingChanges = str('breakingChanges');
  if (typeof o.beyondAdvisory !== 'boolean') errors.push('beyondAdvisory must be true or false');
  const beyondAdvisory = o.beyondAdvisory === true;
  const privateDetails = o.privateDetails === undefined ? '' : str('privateDetails', 20_000);

  if (errors.length) return { ok: false, errors };
  return { ok: true, report: { packages, advisories, affected, usage, reachable, reachableReason, breakingChanges, recommendation, beyondAdvisory, privateDetails } };
}

// ── the comment ──────────────────────────────────────────────────────────────

/** Agent text as an inline code span: one line, capped, no backticks, so nothing in it renders. */
function inert(text: string, max = TEXT_MAX): string {
  const flat = text.replace(/\s+/g, ' ').trim().replace(/`/g, "'").slice(0, max);
  return flat ? `\`${flat}\`` : '';
}

/**
 * A package name or version as an inline code span. Valid npm names and
 * versions can still render as text: `@scope/x` as a mention, `www.x.com` as
 * a link, `GH-1` as an issue reference.
 */
const code = (s: string) => `\`${s.replace(/`/g, "'")}\``;

function advisoryLink(id: string): string {
  return GHSA_EXACT.test(id) ? `[${id}](https://github.com/advisories/${id})` : id;
}

function headline(packages: { name: string; from: string; to: string }[], advisories: string[]): string {
  const pkgs = packages.length ? packages.slice(0, 3).map((p) => `${code(p.name)} ${code(p.from)} → ${code(p.to)}`).join(', ') : 'this PR';
  const more = packages.length > 3 ? ` and ${packages.length - 3} more` : '';
  const ids = advisories.length ? ` (${advisories.slice(0, 5).map(advisoryLink).join(', ')})` : '';
  return `### Security triage: ${pkgs}${more}${ids}`;
}

/** The packages the PR changed, as the headline shows them when the agent gave no valid report. */
function bumpPackages(bumps: Bump[]): { name: string; from: string; to: string }[] {
  const seen = new Map<string, { name: string; from: string; to: string }>();
  for (const b of bumps) {
    if (!b.before.length || !b.after.length || seen.has(b.name)) continue;
    seen.set(b.name, { name: b.name, from: b.before.join('/'), to: b.after.join('/') });
  }
  return [...seen.values()];
}

const RECOMMENDATION_TEXT: Record<Recommendation, string> = {
  'merge-low-urgency': 'merge (low urgency)',
  'merge-now': 'merge now',
  'deep-dive': 'needs a human deep-dive',
};

export interface CommentInput {
  report: TriageReport | null;
  /** Why there is no report (host text only), when report is null. */
  problem?: string;
  bumps: Bump[];
  advisories?: string[];
  repo: string;
  headSha: string;
  /** Usage and network lines (runFacts). */
  facts: string[];
  /** "Run by …" for the footer. */
  runner: string;
}

/** The PR comment, in the fixed format of the design doc. `  ` ends a line without starting a paragraph. */
export function renderComment(c: CommentInput): string {
  const footer = [
    ...c.facts,
    '',
    `<sub>${c.runner} with \`huddle triage-agent\` inside an airlocked Huddle devcontainer. ` +
      'It read untrusted advisory text and upstream commits. It recommends; it never approves or merges, and a person decides.</sub>',
  ];
  const deepDive = `**Recommendation:** ${RECOMMENDATION_TEXT['deep-dive']}`;
  const r = c.report;
  if (!r) {
    return [
      TRIAGE_MARKER,
      headline(bumpPackages(c.bumps), c.advisories ?? []),
      '',
      `**Affected:** unclear (${c.problem ?? 'no analysis'})  `,
      `${deepDive}: do the full manual review from the security fast lane.`,
      ...footer,
    ].join('\n');
  }
  if (r.beyondAdvisory) {
    return [
      TRIAGE_MARKER,
      headline(r.packages, r.advisories),
      '',
      `${deepDive}. The analysis goes beyond what the advisory says: details sent to maintainers, not posted here.`,
      ...footer,
    ].join('\n');
  }
  const blobUrl = (u: Usage) => `https://github.com/${c.repo}/blob/${c.headSha}/${u.file}#L${u.startLine}-L${u.endLine}`;
  const usage = r.usage.length
    ? r.usage.map((u) => `[${u.file}:L${u.startLine}-L${u.endLine}](${blobUrl(u)})${u.note.trim() ? ` ${inert(u.note, 200)}` : ''}`).join('; ')
    : 'none found';
  const unclear = r.affected === 'unclear' || r.reachable === 'unclear';
  const recommendation = unclear
    ? `${deepDive}: the agent could not settle this, so do the full manual review from the security fast lane.`
    : `**Recommendation:** ${RECOMMENDATION_TEXT[r.recommendation]}`;
  return [
    TRIAGE_MARKER,
    headline(r.packages, r.advisories),
    `**Affected:** ${r.affected}  `,
    `**Our usage:** ${usage}  `,
    `**Reachable from a devcontainer:** ${r.reachable}${r.reachableReason.trim() ? `, ${inert(r.reachableReason)}` : ''}  `,
    `**Breaking changes in the bump:** ${inert(r.breakingChanges) || 'not reported'}  `,
    recommendation,
    ...footer,
  ].join('\n');
}

/** The full analysis for maintainers (never posted publicly). */
export function renderPrivate(r: TriageReport, pr: { number: number; title: string; repo: string }): string {
  return [
    `# Triage agent: ${pr.repo} PR #${pr.number}`,
    '',
    `PR title: ${pr.title}`,
    `Packages: ${r.packages.map((p) => `${p.name} ${p.from} -> ${p.to}`).join(', ')}`,
    `Advisories: ${r.advisories.join(', ') || 'none given'}`,
    `Affected: ${r.affected}`,
    `Usage: ${r.usage.map((u) => `${u.file}:L${u.startLine}-L${u.endLine} ${u.note}`).join('; ') || 'none found'}`,
    `Reachable: ${r.reachable}, ${r.reachableReason}`,
    `Breaking changes: ${r.breakingChanges}`,
    `Recommendation: ${r.recommendation}`,
    '',
    '## Beyond the advisory',
    '',
    r.privateDetails || '(no details given)',
    '',
  ].join('\n');
}

/**
 * The id of the newest marked comment by `login`, from lines of
 * "<id>\t<login>" (the CLI lists comments that start with TRIAGE_MARKER).
 */
export function ownCommentId(lines: string, login: string): string | null {
  let id: string | null = null;
  for (const line of lines.split('\n')) {
    const [cid, who] = line.split('\t');
    if (/^\d+$/.test(cid ?? '') && who === login) id = cid;
  }
  return id;
}
