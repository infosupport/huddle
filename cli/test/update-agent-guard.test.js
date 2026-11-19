// Runs against the compiled output: `npm test` builds first (the CLI has no
// test framework dependency, only node:test).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const g = require('../dist/update-agent-guard.js');

test('guarded paths are blocked', () => {
  for (const p of [
    '.github/workflows/test.yml',
    '.github/renovate.json5',
    'renovate.json',
    'gateway/Dockerfile',
    'docker-demo/frontend/Dockerfile',
    'base-devimage/Dockerfile',
    'base-devimage-vscode/devcontainer.json',
    'gateway/src/auth.ts',
    'gateway/src/tls-ca.ts',
    'gateway/src/socket-proxy.ts',
    'gateway/src/proxy.ts',
    'gateway/src/rules.ts',
    'gateway/src/docker-actions.ts',
    'gateway/src/sudo-grant.ts',
    'gateway/src/token-exchange.ts',
    'gateway/src/token-exchange-api.ts',
    ['gateway', 'src', 'auth.ts'].join('\\'), // Windows separators
  ]) assert.equal(g.isGuardedPath(p), true, p);
});

test('ordinary source and test files are allowed', () => {
  for (const p of [
    'gateway/src/api.ts',
    'gateway/src/proxy-forward.ts',
    'gateway/src/rules-folder.ts',
    'gateway/test/proxy.test.ts',
    'gateway/frontend/src/app/app.ts',
    'cli/src/index.ts',
    'gateway/package-lock.json',
    'docs/github.md',
  ]) assert.equal(g.isGuardedPath(p), false, p);
  assert.deepEqual(g.guardViolations(['cli/src/a.ts', 'gateway/src/auth.ts']), ['gateway/src/auth.ts']);
});

test('parseNameStatus treats a rename as delete + add', () => {
  assert.deepEqual(g.parseNameStatus('M\tcli/src/a.ts\nR100\tgateway/test/a.test.ts\tgateway/test/b.ts\n'), [
    { status: 'M', path: 'cli/src/a.ts' },
    { status: 'D', path: 'gateway/test/a.test.ts' },
    { status: 'A', path: 'gateway/test/b.ts' },
  ]);
});

test('testWeakeningFlags spots deleted tests, skips and lost assertions', () => {
  const files = [{ status: 'D', path: 'gateway/test/rules.test.ts' }, { status: 'M', path: 'gateway/src/api.ts' }];
  const diff = [
    '--- a/gateway/test/x.test.ts',
    '+++ b/gateway/test/x.test.ts',
    '-    expect(a).toBe(1);',
    '-    expect(b).toBe(2);',
    '+    expect(a).toBe(1);',
    "+  it.skip('flaky', () => {});",
  ].join('\n');
  const flags = g.testWeakeningFlags(files, diff);
  assert.ok(flags.some((f) => f.includes('deleted test file gateway/test/rules.test.ts')));
  assert.ok(flags.some((f) => f.includes('it.skip')));
  assert.ok(flags.includes('1 fewer expect() assertions'));
  assert.deepEqual(g.testWeakeningFlags([{ status: 'M', path: 'gateway/src/api.ts' }], '+const x = 1;'), []);
});

function pr(over = {}) {
  return {
    number: 7,
    title: 'chore(deps): update vitest',
    headRefName: 'renovate/dev-tooling-(non-major)',
    headRefOid: 'abc',
    labels: [],
    statusCheckRollup: [{ conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/9' }],
    commits: [{ authors: [{ login: 'renovate[bot]' }] }],
    ...over,
  };
}

test('skipReason selects only failing, untouched Renovate PRs', () => {
  assert.equal(g.skipReason(pr()), null);
  assert.match(g.skipReason(pr({ statusCheckRollup: [{ conclusion: 'SUCCESS' }] })), /not failing/);
  assert.match(g.skipReason(pr({ labels: [{ name: 'agent-gave-up' }] })), /agent-gave-up/);
  assert.match(g.skipReason(pr({ headRefName: 'feature/x' })), /not a renovate/);
  assert.match(g.skipReason(pr({ headRefName: 'renovate/x;rm -rf' })), /not a renovate/);
  assert.match(
    g.skipReason(pr({ commits: [{ authors: [{ login: 'renovate[bot]' }] }, { authors: [{ login: 'someone' }] }] })),
    /someone other than Renovate/,
  );
  assert.equal(g.skipReason(pr({ commits: [{ authors: [{ email: '29139614+renovate[bot]@users.noreply.github.com' }] }] })), null);
});

test('failedJobs lists the failing Actions jobs, also while the run is in progress', () => {
  const p = pr({
    statusCheckRollup: [
      { conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/1' },
      { conclusion: 'FAILURE', detailsUrl: 'https://github.com/o/r/actions/runs/123/job/2' },
      { conclusion: '', state: null, detailsUrl: 'https://github.com/o/r/actions/runs/123/job/4' }, // still running
      { conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/456/job/3' },
      { state: 'ERROR', targetUrl: 'https://example.com/status' },
    ],
  });
  assert.deepEqual(g.failedJobs(p), [{ runId: '123', jobId: '1' }, { runId: '123', jobId: '2' }]);
});

test('affectedProjects verifies only what the change can break', () => {
  assert.deepEqual(g.affectedProjects(['cli/package.json', 'cli/tsconfig.json']), ['cli']);
  assert.deepEqual(g.affectedProjects(['gateway/package-lock.json']), ['gateway/frontend', 'gateway']);
  assert.deepEqual(g.affectedProjects(['gateway/frontend/package.json']), ['gateway/frontend', 'gateway']);
  assert.deepEqual(g.affectedProjects(['cli/a.ts', 'gateway/src/b.ts']), ['gateway/frontend', 'gateway', 'cli']);
  assert.deepEqual(g.affectedProjects(['package.json']), ['gateway/frontend', 'gateway', 'cli']);
  assert.deepEqual(g.affectedProjects(['.github/workflows/test.yml', 'cli/a.ts']), ['gateway/frontend', 'gateway', 'cli']);
});

test('isRenovateAuthor recognises the app, self-hosted bots and configured ids', () => {
  assert.equal(g.isRenovateAuthor({ login: '', name: 'renovate[bot]', email: '' }), true);
  assert.equal(g.isRenovateAuthor({ email: 'bot@renovateapp.com' }), true);
  assert.equal(g.isRenovateAuthor({ login: 'renovate-bot' }), true);
  assert.equal(g.isRenovateAuthor({ login: 'our-deps-bot' }), false);
  assert.equal(g.isRenovateAuthor({ login: 'our-deps-bot' }, ['our-deps-bot']), true);
  assert.equal(g.isRenovateAuthor({ login: 'renovate-fan', email: 'fan@example.com' }), false);
});

test('isRenovateBranch honours the configured prefix and rejects unsafe names', () => {
  assert.equal(g.isRenovateBranch('renovate/vitest-4.x', 'renovate/'), true);
  assert.equal(g.isRenovateBranch('deps/vitest-4.x', 'renovate/'), false);
  assert.equal(g.isRenovateBranch('deps/vitest-4.x', 'deps/'), true);
  assert.equal(g.isRenovateBranch('deps/', 'deps/'), false);
  assert.equal(g.isRenovateBranch('deps/x;rm -rf', 'deps/'), false);
});

test('sanitizeCommitMessage drops attribution trailers and falls back when empty', () => {
  const msg = 'fix(deps): adapt to fastify 6\n\nThe reply API changed.\nCo-authored-by: Someone <s@example.com>\nSigned-off-by: Other <o@example.com>\n';
  assert.equal(g.sanitizeCommitMessage(msg, 'fallback'), 'fix(deps): adapt to fastify 6\n\nThe reply API changed.\n');
  assert.equal(g.sanitizeCommitMessage('', 'fix(deps): fallback'), 'fix(deps): fallback\n');
  assert.equal(g.sanitizeCommitMessage('Co-authored-by: x <x@y>', 'fix(deps): fallback'), 'fix(deps): fallback\n');
  assert.equal(g.sanitizeCommitMessage('x'.repeat(300), 'f').length, 101);
});
