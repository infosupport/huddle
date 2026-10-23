import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  hostAgentLogsMountArgs, hostCodexLogsMountArgs, hostCodexIndexMountArgs, HOST_AGENT_LOGS_MOUNT, HOST_CODEX_LOGS_MOUNT, HOST_CODEX_INDEX_MOUNT,
} from '../src/host-logs';

const HOME = path.join('/', 'Users', 'dev');
const PROJECTS = path.join(HOME, '.claude', 'projects');
const SESSIONS = path.join(HOME, '.codex', 'sessions');
const INDEX = path.join(HOME, '.codex', 'session_index.jsonl');

describe('hostAgentLogsMountArgs', () => {
  it('mounts only ~/.claude/projects, read-only, when the setting is on', () => {
    // Act
    const args = hostAgentLogsMountArgs({ hostAgentLogs: true }, HOME, () => true);

    // Assert
    expect(args).toEqual(['-v', `${PROJECTS}:${HOST_AGENT_LOGS_MOUNT}:ro`]);
  });

  it.each([
    ['the setting is off', {}, true],
    ['the setting is not a real true', { hostAgentLogs: 'yes' }, true],
    ['the folder does not exist', { hostAgentLogs: true }, false],
  ])('mounts nothing when %s', (_label, cfg, exists) => {
    // Act
    const args = hostAgentLogsMountArgs(cfg as any, HOME, () => exists);

    // Assert
    expect(args).toEqual([]);
  });
});

describe('hostCodexLogsMountArgs', () => {
  it('mounts only ~/.codex/sessions, read-only, when the setting is on', () => {
    // Act
    const args = hostCodexLogsMountArgs({ hostAgentLogs: true }, HOME, () => true);

    // Assert
    expect(args).toEqual(['-v', `${SESSIONS}:${HOST_CODEX_LOGS_MOUNT}:ro`]);
  });

  it('checks the sessions folder itself, not ~/.codex', () => {
    // Arrange
    const checked: string[] = [];

    // Act
    hostCodexLogsMountArgs({ hostAgentLogs: true }, HOME, (p) => { checked.push(p); return false; });

    // Assert
    expect(checked).toEqual([SESSIONS]);
  });

  it.each([
    ['the setting is off', {}, true],
    ['the setting is not a real true', { hostAgentLogs: 'yes' }, true],
    ['the folder does not exist', { hostAgentLogs: true }, false],
  ])('mounts nothing when %s', (_label, cfg, exists) => {
    // Act
    const args = hostCodexLogsMountArgs(cfg as any, HOME, () => exists);

    // Assert
    expect(args).toEqual([]);
  });

  it('mounts next to the Claude folder, never over it', () => {
    // Assert
    expect(HOST_CODEX_LOGS_MOUNT).toBe('/host-logs/codex/sessions');
    expect(HOST_CODEX_LOGS_MOUNT.startsWith(`${HOST_AGENT_LOGS_MOUNT}/`)).toBe(false);
  });
});

describe('hostCodexIndexMountArgs', () => {
  it('mounts only ~/.codex/session_index.jsonl, read-only, when the setting is on', () => {
    // Act
    const args = hostCodexIndexMountArgs({ hostAgentLogs: true }, HOME, () => true);

    // Assert
    expect(args).toEqual(['-v', `${INDEX}:${HOST_CODEX_INDEX_MOUNT}:ro`]);
  });

  it('checks the index file itself, not ~/.codex', () => {
    // Arrange
    const checked: string[] = [];

    // Act
    hostCodexIndexMountArgs({ hostAgentLogs: true }, HOME, (p) => { checked.push(p); return false; });

    // Assert
    expect(checked).toEqual([INDEX]);
  });

  it.each([
    ['the setting is off', {}, true],
    ['the setting is not a real true', { hostAgentLogs: 'yes' }, true],
    ['the file does not exist', { hostAgentLogs: true }, false],
  ])('mounts nothing when %s', (_label, cfg, exists) => {
    // Act
    const args = hostCodexIndexMountArgs(cfg as any, HOME, () => exists);

    // Assert
    expect(args).toEqual([]);
  });

  it('mounts next to the sessions folder, never inside it', () => {
    // Assert
    expect(HOST_CODEX_INDEX_MOUNT).toBe('/host-logs/codex/session_index.jsonl');
    expect(HOST_CODEX_INDEX_MOUNT.startsWith(`${HOST_CODEX_LOGS_MOUNT}/`)).toBe(false);
  });
});

describe('hostCodexIndexMountArgs on a real disk', () => {
  let home: string;
  let outside: string;
  const index = () => path.join(home, '.codex', 'session_index.jsonl');

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-outside-'));
    fs.mkdirSync(path.join(home, '.codex'));
    fs.writeFileSync(path.join(outside, 'auth.json'), 'secret');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('mounts the index when it is a plain file', () => {
    // Arrange
    fs.writeFileSync(index(), '{}\n');

    // Act
    const args = hostCodexIndexMountArgs({ hostAgentLogs: true }, home);

    // Assert
    expect(args).toEqual(['-v', `${index()}:${HOST_CODEX_INDEX_MOUNT}:ro`]);
  });

  it.each([
    ['a symlink', (target: string, link: string) => fs.symlinkSync(target, link)],
    ['a hard link', (target: string, link: string) => fs.linkSync(target, link)],
  ])('never mounts an index that is %s, which could point the mount at auth.json', (_label, make) => {
    // Arrange
    make(path.join(outside, 'auth.json'), index());

    // Act
    const args = hostCodexIndexMountArgs({ hostAgentLogs: true }, home);

    // Assert
    expect(args).toEqual([]);
  });
});

describe.each([
  ['hostAgentLogsMountArgs', hostAgentLogsMountArgs, ['.claude', 'projects'], HOST_AGENT_LOGS_MOUNT],
  ['hostCodexLogsMountArgs', hostCodexLogsMountArgs, ['.codex', 'sessions'], HOST_CODEX_LOGS_MOUNT],
] as const)('%s on a real disk', (_name, mountArgs, rel, mount) => {
  let home: string;
  let outside: string;
  const folder = () => path.join(home, ...rel);

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
    outside = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-outside-'));
    fs.mkdirSync(path.join(home, rel[0]));
    fs.writeFileSync(path.join(outside, 'auth.json'), 'secret');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  it('mounts the folder when it is a real directory', () => {
    // Arrange
    fs.mkdirSync(folder());

    // Act
    const args = mountArgs({ hostAgentLogs: true }, home);

    // Assert
    expect(args).toEqual(['-v', `${folder()}:${mount}:ro`]);
  });

  it.each([
    ['a symlink to another folder', () => fs.symlinkSync(outside, folder())],
    ['a symlink to its parent, which holds credentials', () => fs.symlinkSync(path.join(home, rel[0]), folder())],
    ['a file', () => fs.writeFileSync(folder(), 'x')],
  ])('never mounts the folder when it is %s', (_label, make) => {
    // Arrange
    make();

    // Act
    const args = mountArgs({ hostAgentLogs: true }, home);

    // Assert
    expect(args).toEqual([]);
  });
});
