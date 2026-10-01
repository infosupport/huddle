import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
const CONFIG = path.join(HOME, 'config.json');
const MOUNT = path.join(HOME, 'host-logs', 'claude', 'projects');
process.env.HUDDLE_HOME_DIR = HOME;
process.env.HUDDLE_HOST_AGENT_LOGS_MOUNT = MOUNT;
const CODEX_MOUNT = path.join(HOME, 'host-logs', 'codex', 'sessions');
process.env.HUDDLE_HOST_CODEX_LOGS_MOUNT = CODEX_MOUNT;

const hc = await import('../src/host-config');

beforeEach(() => {
  fs.rmSync(CONFIG, { force: true });
  fs.rmSync(path.join(HOME, 'host-logs'), { recursive: true, force: true });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('host agent-logs setting', () => {
  it('is off when the config does not mention it', () => {
    // Arrange
    fs.writeFileSync(CONFIG, JSON.stringify({ operatorToken: 't' }));

    // Act
    const on = hc.getHostAgentLogs();

    // Assert
    expect(on).toBe(false);
  });

  it('is written to config.json without touching the rest of the file', () => {
    // Arrange
    fs.writeFileSync(CONFIG, JSON.stringify({ operatorToken: 'keep-me' }));

    // Act
    const persisted = hc.setHostAgentLogs(true);

    // Assert
    expect(persisted).toBe(true);
    expect(JSON.parse(fs.readFileSync(CONFIG, 'utf8'))).toEqual({ operatorToken: 'keep-me', hostAgentLogs: true });
    expect(hc.getHostAgentLogs()).toBe(true);
  });

  it('removes the key when turned off instead of storing false', () => {
    // Arrange
    fs.writeFileSync(CONFIG, JSON.stringify({ hostAgentLogs: true, operatorToken: 't' }));

    // Act
    hc.setHostAgentLogs(false);

    // Assert
    expect(JSON.parse(fs.readFileSync(CONFIG, 'utf8'))).toEqual({ operatorToken: 't' });
  });

  it('only counts a real true as on', () => {
    // Arrange
    fs.writeFileSync(CONFIG, JSON.stringify({ hostAgentLogs: 'yes' }));

    // Act
    const on = hc.getHostAgentLogs();

    // Assert
    expect(on).toBe(false);
  });

  it('reports whether the host log folder is actually mounted', () => {
    // Arrange
    const before = hc.hostAgentLogsMounted();
    fs.mkdirSync(MOUNT, { recursive: true });

    // Act
    const after = hc.hostAgentLogsMounted();

    // Assert
    expect(before).toBe(false);
    expect(after).toBe(true);
  });

  it('counts the host logs as mounted when only the Codex folder is mounted', () => {
    // Arrange
    fs.mkdirSync(CODEX_MOUNT, { recursive: true });

    // Act
    const mounted = hc.hostAgentLogsMounted();

    // Assert
    expect(mounted).toBe(true);
    expect(hc.HOST_CODEX_LOGS_MOUNT).toBe(CODEX_MOUNT);
  });
});
