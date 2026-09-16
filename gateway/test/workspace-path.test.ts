import { describe, it, expect } from 'vitest';
import { containerWorkspacePath, normalizeWorkspaceDir } from '../src/workspace-path';

// The path this helper returns is handed to three places that must agree: the
// bind mount, the in-container config script, and the attached-container config
// the CLI writes for VS Code. A drift here means VS Code attaches and opens a
// folder that does not exist.
describe('normalizeWorkspaceDir', () => {
  it('turns a Windows path into forward slashes', () => {
    expect(normalizeWorkspaceDir('C:\\Users\\me\\proj')).toBe('C:/Users/me/proj');
  });

  it('drops a trailing slash so the leaf is the folder, not an empty segment', () => {
    expect(normalizeWorkspaceDir('/home/me/proj/')).toBe('/home/me/proj');
  });

  it('treats a missing workspace as empty', () => {
    expect(normalizeWorkspaceDir(undefined)).toBe('');
  });
});

describe('containerWorkspacePath', () => {
  it('mounts the workspace under its own folder name', () => {
    expect(containerWorkspacePath('/home/me/proj', 'devcontainer-proj', false)).toBe('/workspaces/proj');
  });

  it('uses the leaf of a normalized Windows path', () => {
    expect(containerWorkspacePath('C:\\Users\\me\\proj\\', 'devcontainer-proj', false)).toBe('/workspaces/proj');
  });

  it('falls back to the container name for an empty container', () => {
    expect(containerWorkspacePath('', 'devcontainer-scratch', true)).toBe('/workspaces/scratch');
  });

  it('never produces a bare /workspaces/ when there is no usable leaf', () => {
    expect(containerWorkspacePath('', 'devcontainer-proj', false)).toBe('/workspaces/devcontainer-proj');
    expect(containerWorkspacePath('', 'devcontainer-', true)).toBe('/workspaces/devcontainer-');
  });
});
