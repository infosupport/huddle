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

d('noot proxy environment (#110)', () => {
  const expectedProfile = [
    'export http_proxy=http://huddle:80',
    'export https_proxy=http://huddle:80',
    'export HTTP_PROXY=http://huddle:80',
    'export HTTPS_PROXY=http://huddle:80',
    "export no_proxy='localhost,127.0.0.1,::1,[::1]'",
    "export NO_PROXY='localhost,127.0.0.1,::1,[::1]'",
  ].join('\n');
  const expectedPolicy = [
    'Defaults logfile=/tmp/sudo-audit.log',
    'Defaults:noot env_keep += "HTTP_PROXY HTTPS_PROXY http_proxy https_proxy NO_PROXY no_proxy"',
  ].join('\n');

  it('preserves only the Huddle proxy variables and only for noot', () => {
    expect(docker!.NOOT_SUDOERS_POLICY).toBe(expectedPolicy);
    expect(docker!.NOOT_SUDOERS_POLICY).not.toContain('Defaults env_keep');
  });

  it('restores the proxy variables discarded by a noot login shell', () => {
    expect(docker!.HUDDLE_PROXY_PROFILE).toBe(expectedProfile);
  });

  it.each([
    ['VS Code', docker!.buildVscodeConfigScript('/workspaces/test', 'test', 'ca', '')],
    ['JetBrains', docker!.buildJbConfigScript('/workspaces/test', 'test', 'intellij', 'ca', '')],
  ])('includes the shared policy in the %s setup script', (_ide, script) => {
    expect(script.match(/Defaults:noot env_keep/g)).toHaveLength(1);
    expect(script).toContain(expectedPolicy);
    expect(script.match(/99-huddle-proxy\.sh/g)).toHaveLength(2);
    expect(script).toContain(expectedProfile);
  });
});
