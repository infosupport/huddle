// Runs against the compiled output: `npm test` builds first.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const t = require('../dist/triage-agent-guard.js');

function pr(over = {}) {
  return {
    number: 12,
    title: 'fix(deps): update dependency node-forge to v1.3.2 [security]',
    author: { login: 'app/renovate', is_bot: true },
    isCrossRepository: false,
    headRefName: 'renovate/npm-node-forge-vulnerability',
    headRefOid: 'abc',
    labels: [{ name: 'dependencies' }, { name: 'security' }],
    ...over,
  };
}

test('decideTriage takes security PRs from Renovate or security/* branches in this repository', () => {
  const reason = (p) => {
    const d = t.decideTriage(p);
    return d.action === 'skip' ? d.reason : null;
  };
  assert.equal(reason(pr()), null);
  // security-bump.sh: a person opens it from a security/* branch.
  assert.equal(reason(pr({ author: { login: 'some-maintainer' }, headRefName: 'security/node-forge-1.3.2' })), null);
  assert.match(reason(pr({ labels: [{ name: 'dependencies' }] })), /not labelled security/);
  assert.match(reason(pr({ isCrossRepository: true })), /not a branch in this repository/);
  assert.match(reason(pr({ isCrossRepository: undefined })), /not a branch in this repository/);
  // Someone else's branch, even when it looks like Renovate's.
  assert.match(reason(pr({ author: { login: 'renovate', is_bot: false } })), /neither/);
  assert.match(reason(pr({ author: { login: 'someone' }, headRefName: 'feature/x' })), /neither/);
  // Unsafe characters in a security branch.
  assert.match(reason(pr({ author: { login: 'someone' }, headRefName: 'security/x;rm -rf' })), /neither/);
  assert.match(reason(pr({ author: { login: 'someone' }, headRefName: 'security/' })), /neither/);
});

const lock = (packages) => JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'x' }, ...packages } });

test('lockfileBumps lists packages whose versions changed, nested copies included', () => {
  const before = lock({
    'node_modules/node-forge': { version: '1.3.1' },
    'node_modules/fastify': { version: '5.0.0' },
    'node_modules/a/node_modules/node-forge': { version: '0.10.0' },
    'node_modules/gone': { version: '1.0.0' },
  });
  const after = lock({
    'node_modules/node-forge': { version: '1.3.2' },
    'node_modules/fastify': { version: '5.0.0' },
    'node_modules/a/node_modules/node-forge': { version: '1.3.2' },
    'node_modules/@scope/new': { version: '2.0.0' },
  });
  assert.deepEqual(t.lockfileBumps('gateway/package-lock.json', before, after), [
    { lockfile: 'gateway/package-lock.json', name: '@scope/new', before: [], after: ['2.0.0'] },
    { lockfile: 'gateway/package-lock.json', name: 'gone', before: ['1.0.0'], after: [] },
    { lockfile: 'gateway/package-lock.json', name: 'node-forge', before: ['0.10.0', '1.3.1'], after: ['1.3.2'] },
  ]);
  // A lockfile added or removed in the PR.
  assert.deepEqual(t.lockfileBumps('cli/package-lock.json', null, lock({ 'node_modules/ws': { version: '8.0.0' } })), [
    { lockfile: 'cli/package-lock.json', name: 'ws', before: [], after: ['8.0.0'] },
  ]);
});

test('lockfileBumps leaves out names and versions that are not plain npm ones', () => {
  const after = lock({
    'node_modules/ok': { version: '1.0.0' },
    'node_modules/Bad`name': { version: '1.0.0' },
    'node_modules/linked': { link: true },
    'node_modules/weird': { version: '1.0.0 [x](https://evil)' },
  });
  assert.deepEqual(t.lockfileBumps('cli/package-lock.json', null, after).map((b) => b.name), ['ok']);
  assert.throws(() => t.lockfileBumps('cli/package-lock.json', 'not json', null), /package-lock/);
});

test('advisoryIds finds GHSA and CVE ids, normalised and unique', () => {
  const text = 'Fixes GHSA-5RRQ-pxf6-6jx5 and ghsa-5rrq-pxf6-6jx5, see CVE-2025-12345 and https://osv.dev/GHSA-aaaa-bbbb-cccc (not valid: GHSA-1111-2222-3333)';
  assert.deepEqual(t.advisoryIds(text), ['GHSA-5rrq-pxf6-6jx5', 'CVE-2025-12345']);
  assert.deepEqual(t.advisoryIds('nothing here'), []);
});

function report(over = {}) {
  return {
    packages: [{ name: 'node-forge', from: '1.3.1', to: '1.3.2' }],
    advisories: ['GHSA-5rrq-pxf6-6jx5'],
    affected: 'no',
    usage: [{ file: 'gateway/src/tls-ca.ts', startLine: 40, endLine: 125, note: 'CA + leaf signing only; we never verify certificates with forge' }],
    reachable: 'no',
    reachableReason: 'the cert parsing path is not used',
    breakingChanges: 'none found in the diff',
    recommendation: 'merge-low-urgency',
    beyondAdvisory: false,
    ...over,
  };
}

const files = new Set(['gateway/src/tls-ca.ts', 'gateway/src/proxy.ts']);

test('parseTriage accepts a well-formed report', () => {
  const r = t.parseTriage(JSON.stringify(report()), files);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(r.report.affected, 'no');
  assert.equal(r.report.usage[0].file, 'gateway/src/tls-ca.ts');
});

test('parseTriage rejects reports the host cannot render safely', () => {
  const errors = (over, text) => {
    const r = t.parseTriage(text ?? JSON.stringify(report(over)), files);
    assert.equal(r.ok, false);
    return r.errors.join('\n');
  };
  assert.match(errors({}, 'not json'), /not valid JSON/);
  assert.match(errors({}, '[]'), /object/);
  assert.match(errors({ affected: 'maybe' }), /affected/);
  assert.match(errors({ reachable: undefined }), /reachable/);
  assert.match(errors({ recommendation: 'approve' }), /recommendation/);
  assert.match(errors({ packages: [] }), /packages/);
  assert.match(errors({ packages: [{ name: 'x](https://evil', from: '1', to: '2' }] }), /packages\[0\]/);
  assert.match(errors({ advisories: ['GHSA-xxxx'] }), /advisories\[0\]/);
  assert.match(errors({ usage: [{ file: '../etc/passwd', startLine: 1, endLine: 1, note: '' }] }), /usage\[0\]\.file/);
  assert.match(errors({ usage: [{ file: '/etc/passwd', startLine: 1, endLine: 1, note: '' }] }), /usage\[0\]\.file/);
  assert.match(errors({ usage: [{ file: 'docs/@maintainer', startLine: 1, endLine: 1, note: '' }] }), /usage\[0\]\.file/);
  assert.match(errors({ usage: [{ file: 'gateway/src/nope.ts', startLine: 1, endLine: 1, note: '' }] }), /not a file in the PR/);
  assert.match(errors({ usage: [{ file: 'gateway/src/proxy.ts', startLine: 9, endLine: 3, note: '' }] }), /lines/);
  assert.match(errors({ usage: [{ file: 'gateway/src/proxy.ts', startLine: 0, endLine: 3, note: '' }] }), /lines/);
  assert.match(errors({ beyondAdvisory: 'no' }), /beyondAdvisory/);
  assert.match(errors({ breakingChanges: 'x'.repeat(2000) }), /breakingChanges/);
});

const ctx = { repo: 'infosupport/huddle', headSha: '0123456789abcdef0123456789abcdef01234567', facts: ['', '**Claude Code:** 5 turns, $0.10'], runner: 'Run by GitHub Actions' };

test('renderComment writes the fixed format with links to the PR head', () => {
  const body = t.renderComment({ ...ctx, report: report(), bumps: [] });
  assert.ok(body.startsWith(t.TRIAGE_MARKER));
  assert.match(body, /^### Security triage: node-forge 1\.3\.1 → 1\.3\.2 \(\[GHSA-5rrq-pxf6-6jx5\]\(https:\/\/github\.com\/advisories\/GHSA-5rrq-pxf6-6jx5\)\)$/m);
  assert.match(body, /^\*\*Affected:\*\* no {2}$/m);
  assert.match(body, /\[gateway\/src\/tls-ca\.ts:L40-L125\]\(https:\/\/github\.com\/infosupport\/huddle\/blob\/0123456789abcdef0123456789abcdef01234567\/gateway\/src\/tls-ca\.ts#L40-L125\) `CA \+ leaf signing only; we never verify certificates with forge`/);
  assert.match(body, /^\*\*Reachable from a devcontainer:\*\* no, `the cert parsing path is not used` {2}$/m);
  assert.match(body, /^\*\*Breaking changes in the bump:\*\* `none found in the diff` {2}$/m);
  assert.match(body, /^\*\*Recommendation:\*\* merge \(low urgency\)$/m);
  assert.match(body, /5 turns/);
  assert.match(body, /never approves or merges/);
});

test('renderComment keeps agent text inert: no links, mentions, HTML or broken code spans', () => {
  const body = t.renderComment({
    ...ctx,
    report: report({ reachableReason: 'see [this](https://evil.example) @maintainer <img src=x> `x`\nnext line' }),
    bumps: [],
  });
  const line = body.split('\n').find((l) => l.startsWith('**Reachable'));
  assert.equal(line, "**Reachable from a devcontainer:** no, `see [this](https://evil.example) @maintainer <img src=x> 'x' next line`  ");
});

test('renderComment sends unclear answers to a person', () => {
  const body = t.renderComment({ ...ctx, report: report({ affected: 'unclear', recommendation: 'merge-now' }), bumps: [] });
  assert.match(body, /^\*\*Recommendation:\*\* needs a human deep-dive/m);
  assert.match(body, /full manual review/);
  const reach = t.renderComment({ ...ctx, report: report({ reachable: 'unclear' }), bumps: [] });
  assert.match(reach, /^\*\*Recommendation:\*\* needs a human deep-dive/m);
});

test('renderComment withholds an analysis that goes beyond the advisory', () => {
  const body = t.renderComment({
    ...ctx,
    report: report({ affected: 'yes', beyondAdvisory: true, privateDetails: 'secret path via proxy.ts', usage: [{ file: 'gateway/src/proxy.ts', startLine: 1, endLine: 2, note: 'secret' }] }),
    bumps: [],
  });
  assert.doesNotMatch(body, /secret|proxy\.ts|Affected/);
  assert.match(body, /^### Security triage: node-forge 1\.3\.1 → 1\.3\.2/m);
  assert.match(body, /details sent to maintainers/);
  assert.match(body, /^\*\*Recommendation:\*\* needs a human deep-dive/m);
});

test('renderComment without a valid report falls back to the bumps and a manual review', () => {
  const bumps = [{ lockfile: 'gateway/package-lock.json', name: 'node-forge', before: ['1.3.1'], after: ['1.3.2'] }];
  const body = t.renderComment({ ...ctx, report: null, bumps, problem: 'the agent wrote no valid analysis' });
  assert.match(body, /^### Security triage: node-forge 1\.3\.1 → 1\.3\.2$/m);
  assert.match(body, /^\*\*Affected:\*\* unclear/m);
  assert.match(body, /the agent wrote no valid analysis/);
  assert.match(body, /^\*\*Recommendation:\*\* needs a human deep-dive/m);
  const none = t.renderComment({ ...ctx, report: null, bumps: [], problem: 'x' });
  assert.match(none, /^### Security triage: this PR$/m);
});

test('renderPrivate holds the whole analysis for maintainers', () => {
  const md = t.renderPrivate(report({ beyondAdvisory: true, privateDetails: 'reachable through proxy.ts:L10' }), { number: 12, title: 'x', repo: 'o/r' });
  assert.match(md, /reachable through proxy\.ts:L10/);
  assert.match(md, /gateway\/src\/tls-ca\.ts:L40-L125/);
  assert.match(md, /PR #12/);
});

test('ownCommentId picks the newest marked comment by the given login', () => {
  const lines = ['11\tgithub-actions[bot]', '12\tsomeone', '13\tgithub-actions[bot]', ''].join('\n');
  assert.equal(t.ownCommentId(lines, 'github-actions[bot]'), '13');
  assert.equal(t.ownCommentId(lines, 'nobody'), null);
  assert.equal(t.ownCommentId('x;y\tgithub-actions[bot]', 'github-actions[bot]'), null);
});
