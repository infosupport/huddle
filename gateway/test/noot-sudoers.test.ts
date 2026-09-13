import { describe, expect, it } from 'vitest';

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[noot-sudoers.test] SKIPPED - better-sqlite3 binding not usable: ${(e as Error).message}`);
}

const d = sqliteAvailable ? describe : describe.skip;
const docker = sqliteAvailable
  ? await import('../src/docker')
  : null;

d('noot sudoers proxy policy (#110)', () => {
  const expectedPolicy = [
    'Defaults logfile=/tmp/sudo-audit.log',
    'Defaults:noot env_keep += "HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy"',
  ].join('\n');

  it('preserves only the Huddle proxy variables and only for noot', () => {
    expect(docker!.NOOT_SUDOERS_POLICY).toBe(expectedPolicy);
    expect(docker!.NOOT_SUDOERS_POLICY).not.toContain('Defaults env_keep');
  });

  it.each([
    ['VS Code', docker!.buildVscodeConfigScript('/workspaces/test', 'test', 'ca', '')],
    ['JetBrains', docker!.buildJbConfigScript('/workspaces/test', 'test', 'intellij', 'ca', '')],
  ])('includes the shared policy in the %s setup script', (_ide, script) => {
    expect(script.match(/Defaults:noot env_keep/g)).toHaveLength(1);
    expect(script).toContain(expectedPolicy);
  });
});
