import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveRuntimeEnv } from '../src/runtime-env';

// runtime-env is the single place that answers "where does this process find the
// world" for both halves of the Node/Gateway split (docs/ADR-huddle-node-split.md).
// The container defaults MUST stay byte-identical to the literals they replaced,
// or an unmodified `huddle init` against an unmodified image changes behaviour.

const huddleHome = path.join(os.homedir(), '.huddle');

describe('resolveRuntimeEnv — container mode (today)', () => {
  const env = resolveRuntimeEnv({});

  it('defaults to the combined role', () => {
    expect(env.role).toBe('all');
    expect(env.hostMode).toBe(false);
  });

  it('keeps every container path exactly as it was hardcoded', () => {
    expect(env.dataDir).toBe('/data');
    expect(env.dbPath).toBe('/data/huddle.db');
    expect(env.caDir).toBe('/data');
    expect(env.extDir).toBe('/data/extensions');
    expect(env.homeDir).toBe('/huddle-home');
    expect(env.firewallRulesMount).toBe('/firewall-rules');
    expect(env.teamExtDir).toBe('/extensions');
    expect(env.socketDir).toBe('/tmp/dc-sockets');
    expect(env.dockerSocketPath).toBe('/var/run/docker.sock');
  });

  it('keeps every published port exactly as it was hardcoded', () => {
    expect(env.apiPort).toBe(3000);
    expect(env.proxyPort).toBe(80);
    expect(env.sbxProxyPort).toBe(32768);
  });
});

describe('resolveRuntimeEnv — host mode', () => {
  const env = resolveRuntimeEnv({ HUDDLE_HOST_MODE: '1' });

  it('owns ~/.huddle for state and config', () => {
    expect(env.hostMode).toBe(true);
    expect(env.dataDir).toBe(huddleHome);
    expect(env.homeDir).toBe(huddleHome);
    expect(env.dbPath).toBe(path.join(huddleHome, 'huddle.db'));
    expect(env.caDir).toBe(huddleHome);
    expect(env.extDir).toBe(path.join(huddleHome, 'extensions'));
  });

  it('listens on Huddle Node\'s own port, not the gateway\'s 3000', () => {
    expect(env.apiPort).toBe(24842);
  });

  it('keeps the socket dir on the ENGINE host, which is Linux on every platform', () => {
    expect(env.socketDir).toBe('/tmp/dc-sockets');
  });
});

describe('resolveRuntimeEnv — explicit env always wins', () => {
  it('overrides paths in container mode', () => {
    const env = resolveRuntimeEnv({
      DB_PATH: '/custom/huddle.db',
      CA_DIR: '/custom/ca',
      EXT_DIR: '/custom/ext',
      HUDDLE_HOME_DIR: '/custom/home',
      HUDDLE_DOCKER_SOCKET: '/custom/docker.sock',
      HUDDLE_SOCKET_DIR: '/custom/sockets',
      HUDDLE_FIREWALL_RULES_MOUNT: '/custom/rules',
      HUDDLE_EXTENSIONS_MOUNT: '/custom/extensions',
    });
    expect(env.dbPath).toBe('/custom/huddle.db');
    expect(env.caDir).toBe('/custom/ca');
    expect(env.extDir).toBe('/custom/ext');
    expect(env.homeDir).toBe('/custom/home');
    expect(env.dockerSocketPath).toBe('/custom/docker.sock');
    expect(env.socketDir).toBe('/custom/sockets');
    expect(env.firewallRulesMount).toBe('/custom/rules');
    expect(env.teamExtDir).toBe('/custom/extensions');
  });

  it('overrides paths in host mode too', () => {
    const env = resolveRuntimeEnv({ HUDDLE_HOST_MODE: '1', HUDDLE_DATA_DIR: '/srv/huddle' });
    expect(env.dataDir).toBe('/srv/huddle');
    expect(env.dbPath).toBe(path.join('/srv/huddle', 'huddle.db'));
  });

  it('overrides ports', () => {
    const env = resolveRuntimeEnv({
      HUDDLE_API_PORT: '8080',
      HUDDLE_PROXY_PORT: '8081',
      HUDDLE_SBX_PROXY_PORT: '8082',
    });
    expect(env.apiPort).toBe(8080);
    expect(env.proxyPort).toBe(8081);
    expect(env.sbxProxyPort).toBe(8082);
  });

  it('ignores an empty or whitespace-only override', () => {
    const env = resolveRuntimeEnv({ DB_PATH: '  ', HUDDLE_API_PORT: '' });
    expect(env.dbPath).toBe('/data/huddle.db');
    expect(env.apiPort).toBe(3000);
  });
});

describe('resolveRuntimeEnv — roles', () => {
  it.each(['all', 'node', 'gateway'] as const)('accepts %s', (role) => {
    expect(resolveRuntimeEnv({ HUDDLE_ROLE: role }).role).toBe(role);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveRuntimeEnv({ HUDDLE_ROLE: '  GateWay ' }).role).toBe('gateway');
  });

  it('refuses an unknown role rather than silently running as all', () => {
    expect(() => resolveRuntimeEnv({ HUDDLE_ROLE: 'proxy' })).toThrow(/HUDDLE_ROLE/);
  });
});

describe('resolveRuntimeEnv — port validation', () => {
  it.each(['0', '65536', '-1', 'http', '80.5'])('refuses %s', (port) => {
    expect(() => resolveRuntimeEnv({ HUDDLE_API_PORT: port })).toThrow(/HUDDLE_API_PORT/);
  });
});
