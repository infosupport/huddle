import { describe, it, expect } from 'vitest';

// VS Code Remote IDE-kanaal hardening (finding #15). buildVscodeMachineSettings
// leeft in docker.ts, dat bij import de native better-sqlite3-binding laadt
// (listFolderMappings); die ontbreekt in een verse DMZ-devcontainer. Probe en
// sla anders over — draait volledig in CI / de huddle-image.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[vscode-ide-hardening.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`);
}

const d = sqliteAvailable ? describe : describe.skip;
const { buildVscodeMachineSettings } = sqliteAvailable
  ? await import('../src/docker')
  : ({ buildVscodeMachineSettings: (() => ({})) as any });

d('buildVscodeMachineSettings (#15)', () => {
  const s = buildVscodeMachineSettings() as Record<string, any>;

  it('dwingt workspace trust af (blokkeert folderOpen auto-run)', () => {
    expect(s['security.workspace.trust.enabled']).toBe(true);
    expect(s['security.workspace.trust.emptyWindow']).toBe(false);
    expect(s['task.allowAutomaticTasks']).toBe('off');
  });

  it('blokkeert een host-terminal vanuit het remote-venster', () => {
    expect(s['terminal.integrated.allowLocalTerminal']).toBe(false);
  });

  it('leegt de doorgestuurde host-credential-env in terminals', () => {
    const env = s['terminal.integrated.env.linux'];
    for (const k of ['GIT_ASKPASS', 'VSCODE_GIT_ASKPASS_NODE', 'VSCODE_GIT_ASKPASS_MAIN',
                     'VSCODE_GIT_IPC_HANDLE', 'SSH_AUTH_SOCK', 'GPG_AGENT_INFO', 'GPG_TTY']) {
      expect(env[k]).toBeNull();
    }
  });
});
