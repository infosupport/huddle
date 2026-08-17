import { describe, it, expect } from 'vitest';
import { commonParentPath, defaultMultiMountWorkspace } from '../src/workspace-root';

// ── IDE project root for a multi-mount devcontainer ──────────────────────────
// When several folders are mounted and the caller supplies no explicit "open at"
// path, the gateway derives the IDE project root from the mounts themselves.
// Regression guard for the fallback: the original code wrote
// `commonParentPath(...) || '/workspaces'`, but commonParentPath() returns '/'
// (truthy) for mounts that share no leading segment — so the documented
// '/workspaces' default was unreachable and such containers opened at '/'.

describe('commonParentPath', () => {
  it('returns the deepest shared directory', () => {
    expect(commonParentPath(['/workspaces/api', '/workspaces/web'])).toBe('/workspaces');
    expect(commonParentPath(['/src/a/one', '/src/a/two'])).toBe('/src/a');
  });

  it('returns the path itself for a single mount', () => {
    expect(commonParentPath(['/workspaces/api'])).toBe('/workspaces/api');
  });

  it('only shares whole path segments, never a partial name', () => {
    expect(commonParentPath(['/workspaces/api', '/workspaces-old/api'])).toBe('/');
  });

  it('returns "/" when nothing is shared and "" for no paths', () => {
    expect(commonParentPath(['/workspaces/api', '/srv/web'])).toBe('/');
    expect(commonParentPath([])).toBe('');
  });
});

describe('defaultMultiMountWorkspace', () => {
  it('uses the shared parent when the mounts have one', () => {
    expect(defaultMultiMountWorkspace(['/workspaces/api', '/workspaces/web'])).toBe('/workspaces');
    expect(defaultMultiMountWorkspace(['/src/a/one', '/src/a/two'])).toBe('/src/a');
  });

  it('falls back to /workspaces instead of rooting the IDE at /', () => {
    expect(defaultMultiMountWorkspace(['/workspaces/api', '/srv/web'])).toBe('/workspaces');
    expect(defaultMultiMountWorkspace(['/a', '/b'])).toBe('/workspaces');
  });

  it('falls back to /workspaces when there are no mounts to compare', () => {
    expect(defaultMultiMountWorkspace([])).toBe('/workspaces');
  });
});
