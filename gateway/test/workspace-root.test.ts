import { describe, it, expect } from 'vitest';
import { commonParentPath, containerPathError, defaultMultiMountWorkspace } from '../src/workspace-root';

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

// ── containerPathError ───────────────────────────────────────────────────────
// The workspace root is interpolated into the container setup script that runs as
// root via `sh -c` (docker.ts), which then does mkdir -p / chown -R / chmod -R on
// it. Before this guard the API only checked that the value started with '/', so a
// start request could inject shell commands or aim `chown -R` at the whole
// container filesystem.
describe('containerPathError', () => {
  it('accepts ordinary absolute container paths', () => {
    expect(containerPathError('/workspaces/api')).toBeNull();
    expect(containerPathError('/workspaces/My Project')).toBeNull();
    expect(containerPathError('/srv/app-1.2_final+rc')).toBeNull();
    expect(containerPathError('/workspaces/huddle (copy)')).toBeNull();
  });

  it('rejects the container root, which would chown -R the whole filesystem', () => {
    expect(containerPathError('/')).toMatch(/container root/);
    expect(containerPathError('///')).toMatch(/container root/);
  });

  it('rejects shell metacharacters that would break out of the script', () => {
    expect(containerPathError('/workspaces/x"; touch /tmp/pwned; #')).toMatch(/quotes/);
    expect(containerPathError('/workspaces/$(id)')).toMatch(/quotes/);
    expect(containerPathError('/workspaces/`id`')).toMatch(/quotes/);
    expect(containerPathError("/workspaces/x'y")).toMatch(/quotes/);
    expect(containerPathError('/workspaces/x\\y')).toMatch(/quotes/);
  });

  it('rejects relative paths, traversal, control characters and absurd lengths', () => {
    expect(containerPathError('workspaces/api')).toMatch(/absolute/);
    expect(containerPathError('/workspaces/../etc')).toMatch(/\.\./);
    expect(containerPathError('/workspaces/./api')).toMatch(/segments/);
    expect(containerPathError('/workspaces/a\nb')).toMatch(/control characters/);
    expect(containerPathError('/workspaces/a\x00b')).toMatch(/control characters/);
    expect(containerPathError('/' + 'a'.repeat(600))).toMatch(/512/);
  });
});
