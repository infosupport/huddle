import { describe, it, expect } from 'vitest';

// VS Code Remote IDE-kanaal hardening (finding #15). buildVscodeMachineSettings
// leeft in docker.ts, dat via listFolderMappings db.ts meetrekt — en db.ts opent
// bij import een database (in tests de in-memory variant uit vitest.config.ts).
// De functie zelf is puur.
const { buildVscodeMachineSettings } = await import('../src/docker');

describe('buildVscodeMachineSettings (#15)', () => {
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
