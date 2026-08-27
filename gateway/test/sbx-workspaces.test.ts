import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildCreateArgs } from '../src/sandbox/ops';
import { isValidWorkspacePath, normalizeWorkspacePath, workspaceArg } from '../src/sandbox/protocol';
import {
  hostPathToSandboxPath,
  sandboxSettingsTarget,
  planSettingsFolders,
  settingsWorkspaces,
  mergeSandboxWorkspaces,
  buildSettingsFolderScript,
} from '../src/sandbox/settings-folders';
import type { HostFolderMapping } from '../src/host-config';

// ── Multiple folders per sandbox + settings folders ───────────────────────────
// A sandbox may hold several folders: `sbx create AGENT PATH [PATH...]`, `:ro` per
// extra folder, each mounted INSIDE the sandbox at the same path as on the host.
// On top of that, Huddle's folder mappings (the settings folders devcontainers get
// as Docker mounts) ride along as extra workspaces and are then linked to the path
// the agent reads them from.

describe('workspace path validation', () => {
  it('accepts Windows and POSIX host paths', () => {
    expect(isValidWorkspacePath('T:\\projects\\huddle')).toBe(true);
    expect(isValidWorkspacePath('/home/toon/projects/app')).toBe(true);
    expect(isValidWorkspacePath('.')).toBe(true);
  });

  it('refuses a path that would become a flag or split the mailbox argv', () => {
    expect(isValidWorkspacePath('--privileged')).toBe(false);       // argv slot escape
    expect(isValidWorkspacePath('/a\nrm -rf /')).toBe(false);       // mailbox = one arg per line
    expect(isValidWorkspacePath('/a\r/b')).toBe(false);
    expect(isValidWorkspacePath('/a|b')).toBe(false);               // link-script separator
    expect(isValidWorkspacePath('')).toBe(false);
    expect(isValidWorkspacePath(undefined)).toBe(false);
  });

  it('drops one trailing separator but keeps a bare root', () => {
    expect(normalizeWorkspacePath('  C:\\proj\\  ')).toBe('C:\\proj');
    expect(normalizeWorkspacePath('/srv/app/')).toBe('/srv/app');
    expect(normalizeWorkspacePath('/')).toBe('/');
    expect(normalizeWorkspacePath('C:\\')).toBe('C:\\');
  });

  it('appends sbx\'s :ro suffix only for read-only folders', () => {
    expect(workspaceArg({ path: '/docs', readOnly: true })).toBe('/docs:ro');
    expect(workspaceArg({ path: '/docs' })).toBe('/docs');
  });
});

describe('buildCreateArgs', () => {
  it('puts the primary folder first and appends the extras in order', () => {
    expect(
      buildCreateArgs({
        name: 'box',
        agent: 'claude',
        path: 'T:\\projects\\app',
        extraPaths: [{ path: 'T:\\projects\\lib' }, { path: 'T:\\docs', readOnly: true }],
      }),
    ).toEqual(['create', '--name', 'box', 'claude', 'T:\\projects\\app', 'T:\\projects\\lib', 'T:\\docs:ro']);
  });

  it('drops duplicates — sbx refuses the same folder twice (primary wins)', () => {
    expect(
      buildCreateArgs({
        name: 'box',
        agent: 'claude',
        path: '/srv/app',
        extraPaths: [{ path: '/srv/app/' }, { path: '/srv/lib' }, { path: '/srv/lib' }],
      }),
    ).toEqual(['create', '--name', 'box', 'claude', '/srv/app', '/srv/lib']);
  });

  it('works without extras (unchanged single-folder behaviour)', () => {
    expect(buildCreateArgs({ name: 'box', agent: 'claude', path: '.' }))
      .toEqual(['create', '--name', 'box', 'claude', '.']);
  });

  it('refuses an invalid name, agent or folder before anything is executed', () => {
    expect(() => buildCreateArgs({ name: 'bad name', path: '.' })).toThrow(/invalid sandbox name/);
    expect(() => buildCreateArgs({ name: 'box', agent: '--rm', path: '.' })).toThrow(/invalid agent/);
    expect(() => buildCreateArgs({ name: 'box', path: '' })).toThrow(/invalid workspace path/);
    expect(() => buildCreateArgs({ name: 'box', path: '.', extraPaths: [{ path: '-x' }] }))
      .toThrow(/invalid workspace path/);
  });
});

describe('hostPathToSandboxPath', () => {
  it('translates a Windows drive path to the path sbx mounts it at', () => {
    // Evidence: a sandbox created from T:\projects\huddle sees /t/projects/huddle.
    expect(hostPathToSandboxPath('T:\\projects\\huddle')).toBe('/t/projects/huddle');
    expect(hostPathToSandboxPath('C:/Users/me/.claude/')).toBe('/c/Users/me/.claude');
    expect(hostPathToSandboxPath('D:\\')).toBe('/d');
  });

  it('keeps a POSIX host path as-is', () => {
    expect(hostPathToSandboxPath('/home/toon/.claude')).toBe('/home/toon/.claude');
    expect(hostPathToSandboxPath('/home/toon/.claude/')).toBe('/home/toon/.claude');
  });

  it('returns null when the sandbox path cannot be known', () => {
    expect(hostPathToSandboxPath('~/.claude')).toBeNull();       // only the host shell knows ~
    expect(hostPathToSandboxPath('relative/dir')).toBeNull();
    expect(hostPathToSandboxPath('\\\\server\\share')).toBeNull(); // UNC
    expect(hostPathToSandboxPath('')).toBeNull();
    expect(hostPathToSandboxPath(42)).toBeNull();
  });
});

describe('sandboxSettingsTarget', () => {
  it('re-anchors a devcontainer home path on the sandbox user\'s $HOME', () => {
    expect(sandboxSettingsTarget('/home/vscode/.claude')).toBe('~/.claude');
    expect(sandboxSettingsTarget('/home/node/.config/tool')).toBe('~/.config/tool');
    expect(sandboxSettingsTarget('/root/.codex/')).toBe('~/.codex');
  });

  it('keeps any other absolute container path', () => {
    expect(sandboxSettingsTarget('/opt/team-config')).toBe('/opt/team-config');
  });

  it('refuses the home itself, relative paths and shell-unsafe paths', () => {
    expect(sandboxSettingsTarget('/home/vscode')).toBeNull();
    expect(sandboxSettingsTarget('.claude')).toBeNull();
    expect(sandboxSettingsTarget('/home/vscode/$(id)')).toBeNull();
    expect(sandboxSettingsTarget('/home/vscode/../../etc')).toBeNull();
    expect(sandboxSettingsTarget('/a|b')).toBeNull();
  });
});

function mapping(m: Partial<HostFolderMapping>): HostFolderMapping {
  return {
    id: 1, name: 'x', hostPath: '', volumeName: '', containerPath: '/home/vscode/.x',
    readOnly: false, enabled: true, sortOrder: 0, ...m,
  } as HostFolderMapping;
}

describe('planSettingsFolders', () => {
  it('takes every enabled host-path mapping along, read-only flag included', () => {
    const plan = planSettingsFolders([
      mapping({ id: 1, name: 'claude', hostPath: 'C:\\Users\\me\\.claude', containerPath: '/home/vscode/.claude' }),
      mapping({ id: 2, name: 'team', hostPath: '/srv/team', containerPath: '/opt/team', readOnly: true }),
    ]);
    expect(plan.folders).toEqual([
      { name: 'claude', hostPath: 'C:\\Users\\me\\.claude', mountPath: '/c/Users/me/.claude', targetPath: '~/.claude', readOnly: false },
      { name: 'team', hostPath: '/srv/team', mountPath: '/srv/team', targetPath: '/opt/team', readOnly: true },
    ]);
    expect(settingsWorkspaces(plan)).toEqual([
      { path: 'C:\\Users\\me\\.claude', readOnly: false },
      { path: '/srv/team', readOnly: true },
    ]);
    expect(plan.skipped).toEqual([]);
  });

  it('reports a Docker-volume mapping instead of silently dropping it', () => {
    const plan = planSettingsFolders([
      mapping({ name: 'codex', volumeName: 'huddle-codex', containerPath: '/home/vscode/.codex' }),
    ]);
    expect(plan.folders).toEqual([]);
    expect(plan.skipped[0].name).toBe('codex');
    expect(plan.skipped[0].reason).toMatch(/volume 'huddle-codex'.*host folders/);
  });

  it('reports a host path with no knowable sandbox path', () => {
    const plan = planSettingsFolders([mapping({ name: 'tilde', hostPath: '~/.mytool' })]);
    expect(plan.folders).toEqual([]);
    expect(plan.skipped[0].reason).toMatch(/not an absolute host path/);
  });

  it('ignores disabled rows and refuses two mappings on one target', () => {
    const plan = planSettingsFolders([
      mapping({ id: 1, name: 'off', hostPath: '/srv/a', enabled: false }),
      mapping({ id: 2, name: 'first', hostPath: '/srv/b', containerPath: '/home/vscode/.claude' }),
      mapping({ id: 3, name: 'second', hostPath: '/srv/c', containerPath: '/home/vscode/.claude/' }),
    ]);
    expect(plan.folders.map((f) => f.name)).toEqual(['first']);
    expect(plan.skipped).toEqual([{ name: 'second', reason: 'another mapping already targets ~/.claude' }]);
  });
});

describe('mergeSandboxWorkspaces (what `sbx create` is called with)', () => {
  const plan = planSettingsFolders([
    mapping({ id: 1, name: 'claude', hostPath: 'T:\\home\\.claude', containerPath: '/home/vscode/.claude' }),
    mapping({ id: 2, name: 'team', hostPath: 'T:\\team', containerPath: '/opt/team', readOnly: true }),
  ]);

  it('keeps the caller\'s folders first and appends the settings folders', () => {
    const { primary, extras } = mergeSandboxWorkspaces(
      [{ path: 'T:\\projects\\app' }, { path: 'T:\\docs', readOnly: true }],
      plan,
      '.',
    );
    expect(primary).toEqual({ path: 'T:\\projects\\app', readOnly: false });
    expect(extras).toEqual([
      { path: 'T:\\docs', readOnly: true },
      { path: 'T:\\home\\.claude', readOnly: false },
      { path: 'T:\\team', readOnly: true },
    ]);
    // …and that is exactly the argv order `sbx create` receives.
    expect(buildCreateArgs({ name: 'box', agent: 'claude', path: primary.path, extraPaths: extras })).toEqual([
      'create', '--name', 'box', 'claude',
      'T:\\projects\\app', 'T:\\docs:ro', 'T:\\home\\.claude', 'T:\\team:ro',
    ]);
  });

  it('never passes the same folder twice, even when a mapping repeats it', () => {
    const { extras } = mergeSandboxWorkspaces([{ path: 'T:\\team\\' }, { path: 'T:\\team' }], plan, '.');
    expect(extras.map((w) => w.path)).toEqual(['T:\\home\\.claude']);
  });

  it('falls back to the default workspace when no folder was given', () => {
    const { primary, extras } = mergeSandboxWorkspaces([], { folders: [], skipped: [] }, '.');
    expect(primary).toEqual({ path: '.', readOnly: false });
    expect(extras).toEqual([]);
  });
});

describe('buildSettingsFolderScript', () => {
  const folders = [
    { name: 'claude', hostPath: 'C:\\x', mountPath: '/mnt-claude', targetPath: '~/.claude', readOnly: false },
  ];

  it('is empty when there is nothing to link', () => {
    expect(buildSettingsFolderScript([])).toBe('');
  });

  it('stays a SINGLE line — the sbx mailbox passes argv one arg per line', () => {
    const script = buildSettingsFolderScript([
      ...folders,
      { name: 'team docs', hostPath: '/srv/t', mountPath: '/srv/t', targetPath: '/opt/team', readOnly: true },
    ]);
    expect(script).not.toMatch(/[\r\n]/);
  });

  // The script is what actually runs inside the sandbox, so run it for real
  // against a temp $HOME and assert the five cases it has to get right.
  it('links, merges and never clobbers existing agent state', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-sbx-'));
    const home = path.join(root, 'home');
    const mk = (p: string, file?: string) => {
      fs.mkdirSync(p, { recursive: true });
      if (file) fs.writeFileSync(path.join(p, file), 'x');
    };
    mk(home);
    mk(path.join(root, 'm-fresh'), 'CLAUDE.md');           // → LINK (no target yet)
    mk(path.join(root, 'm-merge'), 'AGENTS.md');           // → MERGE into existing dir
    fs.mkdirSync(path.join(root, 'm-merge', 'skills'), { recursive: true });
    mk(path.join(root, 'm-empty'), 'settings.json');       // → target is an empty dir
    mk(path.join(root, 'm-file'), 'settings.json');        // → target is a file: KEEP
    mk(path.join(root, 'm-relink'), 'settings.json');      // → target is a symlink: RELINK

    // Existing agent state: a non-empty ~/.claude with a credential file sbx owns.
    mk(path.join(home, '.claude'), '.credentials.json');
    fs.writeFileSync(path.join(home, '.claude', 'AGENTS.md'), 'mine');
    fs.mkdirSync(path.join(home, '.empty'), { recursive: true });
    fs.writeFileSync(path.join(home, '.afile'), 'do not touch');
    fs.symlinkSync(path.join(root, 'stale'), path.join(home, '.relink'));

    const script = buildSettingsFolderScript([
      { name: 'fresh', hostPath: '-', mountPath: path.join(root, 'm-fresh'), targetPath: '~/.fresh', readOnly: false },
      { name: 'merge', hostPath: '-', mountPath: path.join(root, 'm-merge'), targetPath: '~/.claude', readOnly: false },
      { name: 'empty', hostPath: '-', mountPath: path.join(root, 'm-empty'), targetPath: '~/.empty', readOnly: false },
      { name: 'afile', hostPath: '-', mountPath: path.join(root, 'm-file'), targetPath: '~/.afile', readOnly: false },
      { name: 'relink', hostPath: '-', mountPath: path.join(root, 'm-relink'), targetPath: '~/.relink', readOnly: false },
      { name: 'gone', hostPath: '-', mountPath: path.join(root, 'not-mounted'), targetPath: '~/.gone', readOnly: false },
    ]);
    const out = execFileSync('sh', ['-c', script], { env: { HOME: home, PATH: process.env.PATH ?? '' } }).toString();

    expect(out).toMatch(/LINK fresh/);
    expect(fs.realpathSync(path.join(home, '.fresh'))).toBe(fs.realpathSync(path.join(root, 'm-fresh')));

    // MERGE: the new entry is linked in, the agent's own files stay untouched.
    expect(out).toMatch(/MERGE merge/);
    expect(fs.readFileSync(path.join(home, '.claude', 'AGENTS.md'), 'utf8')).toBe('mine');
    expect(fs.existsSync(path.join(home, '.claude', '.credentials.json'))).toBe(true);
    expect(fs.lstatSync(path.join(home, '.claude', 'skills')).isSymbolicLink()).toBe(true);

    // An empty target directory is replaced by the link; a real file is kept.
    expect(fs.lstatSync(path.join(home, '.empty')).isSymbolicLink()).toBe(true);
    expect(out).toMatch(/KEEP afile/);
    expect(fs.readFileSync(path.join(home, '.afile'), 'utf8')).toBe('do not touch');

    // A symlink from an earlier start is re-pointed; a missing mount is reported.
    expect(out).toMatch(/RELINK relink/);
    expect(fs.realpathSync(path.join(home, '.relink'))).toBe(fs.realpathSync(path.join(root, 'm-relink')));
    expect(out).toMatch(/SKIP gone/);
    expect(fs.existsSync(path.join(home, '.gone'))).toBe(false);

    fs.rmSync(root, { recursive: true, force: true });
  });
});
