import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Where the two team-managed folders (#69) come from after the Huddle Node
// split. They used to be bind mounts at fixed container paths; Huddle Node runs
// on the host, so it reads them out of ~/.huddle/config.json — per call, so
// `firewall folder set` is live on the next reload instead of the next restart.
//
// Both modules resolve HUDDLE_ROLE and the home directory at import time, so
// every case gets its own module registry (vi.resetModules via dynamic import
// after mutating the environment).

const saved = { ...process.env };
let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
});

afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  fs.rmSync(home, { recursive: true, force: true });
});

function writeConfig(cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(cfg));
}

async function loadHostMode(): Promise<{
  firewallRulesMount: () => string;
  teamExtDir: () => string;
}> {
  process.env.HUDDLE_ROLE = 'node';
  process.env.HUDDLE_HOME_DIR = home;
  const vitest = await import('vitest');
  vitest.vi.resetModules();
  const fw = await import('../src/firewall-rules-folder');
  const ext = await import('../src/extensions/loader');
  return { firewallRulesMount: fw.firewallRulesMount, teamExtDir: ext.teamExtDir };
}

describe('team folder resolution (host mode)', () => {
  it('reads both folders from the CLI config', async () => {
    writeConfig({ firewallRulesFolder: '/team/fw', extensionsFolder: '/team/ext' });
    const { firewallRulesMount, teamExtDir } = await loadHostMode();
    expect(firewallRulesMount()).toBe('/team/fw');
    expect(teamExtDir()).toBe('/team/ext');
  });

  it('picks up a folder written after the process started', async () => {
    writeConfig({});
    const { firewallRulesMount } = await loadHostMode();
    expect(firewallRulesMount()).toBe('');
    writeConfig({ firewallRulesFolder: '/team/fw' });
    expect(firewallRulesMount()).toBe('/team/fw');
  });

  it('reports no folder rather than a container path when none is configured', async () => {
    writeConfig({ defaultCpus: '2' });
    const { firewallRulesMount, teamExtDir } = await loadHostMode();
    expect(firewallRulesMount()).toBe('');
    expect(teamExtDir()).toBe('');
  });

  it('still honours the environment override', async () => {
    writeConfig({ firewallRulesFolder: '/team/fw', extensionsFolder: '/team/ext' });
    process.env.HUDDLE_FIREWALL_RULES_MOUNT = '/override/fw';
    process.env.HUDDLE_EXTENSIONS_MOUNT = '/override/ext';
    const { firewallRulesMount, teamExtDir } = await loadHostMode();
    expect(firewallRulesMount()).toBe('/override/fw');
    expect(teamExtDir()).toBe('/override/ext');
  });
});
