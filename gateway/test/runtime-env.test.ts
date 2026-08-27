import { describe, it, expect } from 'vitest';
import os from 'os';
import path from 'path';
import { resolveRuntimeEnv } from '../src/runtime-env';

// runtime-env is the single place that answers "where does this process find the
// world" for both halves of the Node/Gateway split (docs/ADR-huddle-node-split.md).
// There are exactly two configurations and no third: Huddle Node on the host,
// huddle-gateway in the container. The role IS the deployment — there is no
// separate host-mode switch, because the two never crossed in practice.
//
// The container defaults MUST stay byte-identical to the literals they replaced,
// or an unmodified image changes behaviour under the same `docker run`.

const huddleHome = path.join(os.homedir(), '.huddle');
const gateway = (extra: NodeJS.ProcessEnv = {}) => resolveRuntimeEnv({ HUDDLE_ROLE: 'gateway', ...extra });

describe('resolveRuntimeEnv — huddle-gateway, in the container', () => {
  const env = gateway();

  it('keeps every container path exactly as it was hardcoded', () => {
    expect(env.hostMode).toBe(false);
    expect(env.dataDir).toBe('/data');
    expect(env.dbPath).toBe('/data/huddle.db');
    expect(env.extDir).toBe('/data/extensions');
    expect(env.homeDir).toBe('/huddle-home');
    expect(env.firewallRulesMount).toBe('/firewall-rules');
    expect(env.teamExtDir).toBe('/extensions');
    expect(env.socketDir).toBe('/tmp/dc-sockets');
    expect(env.dockerSocketPath).toBe('/var/run/docker.sock');
  });

  // Node generates the CA and owns it; the gateway only SIGNS leaf certs with it
  // and gets the directory bind-mounted read-only. Two halves each minting their
  // own root would validate nothing.
  it('reads the CA from its own read-only mount, not from /data', () => {
    expect(env.caDir).toBe('/ca');
  });

  it('keeps every published port exactly as it was hardcoded', () => {
    expect(env.apiPort).toBe(3000);
    expect(env.proxyPort).toBe(80);
    expect(env.sbxProxyPort).toBe(32768);
  });

  it('binds every interface, because in a container -p decides the exposure', () => {
    expect(env.apiBindHost).toBe('0.0.0.0');
  });

  // Docker Desktop provides host.docker.internal; on Linux `huddle init` injects
  // it with --add-host=host.docker.internal:host-gateway.
  it('looks for Huddle Node outside the container', () => {
    expect(env.nodeControlUrl).toBe('http://host.docker.internal:24843');
  });
});

describe('resolveRuntimeEnv — Huddle Node, on the host', () => {
  const env = resolveRuntimeEnv({});

  it('is the default role, because that is what a bare `node dist/index.js` should be', () => {
    expect(env.role).toBe('node');
    expect(env.hostMode).toBe(true);
  });

  it('owns ~/.huddle for state and config', () => {
    expect(env.dataDir).toBe(huddleHome);
    expect(env.homeDir).toBe(huddleHome);
    expect(env.dbPath).toBe(path.join(huddleHome, 'huddle.db'));
    expect(env.caDir).toBe(path.join(huddleHome, 'ca'));
    expect(env.extDir).toBe(path.join(huddleHome, 'extensions'));
  });

  it('listens on Huddle Node\'s own port, not the gateway\'s 3000', () => {
    expect(env.apiPort).toBe(24842);
  });

  it('keeps the socket dir on the ENGINE host, which is Linux on every platform', () => {
    expect(env.socketDir).toBe('/tmp/dc-sockets');
  });

  it('binds loopback, so moving to the host does not publish the API to the LAN', () => {
    // There is no `-p` step on the host to decide exposure, and Huddle Node can
    // exec into containers and rewrite firewall policy. 0.0.0.0 here would put
    // that on every interface the machine has.
    expect(env.apiBindHost).toBe('127.0.0.1');
  });

  // The control channel is a SEPARATE listener precisely so the portal can stay
  // on loopback: on Linux the gateway can only reach the host on the bridge
  // address, and widening the portal to there would put the operator token's
  // surface on the default Docker network.
  it('serves the control channel on its own port, loopback by default', () => {
    expect(env.controlPort).toBe(24843);
    expect(env.controlBindHost).toBe('127.0.0.1');
    expect(env.controlPort).not.toBe(env.apiPort);
  });
});

describe('resolveRuntimeEnv — explicit env always wins', () => {
  it('overrides paths in the gateway', () => {
    const env = gateway({
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

  it('overrides paths on Huddle Node too', () => {
    const env = resolveRuntimeEnv({ HUDDLE_DATA_DIR: '/srv/huddle' });
    expect(env.dataDir).toBe('/srv/huddle');
    expect(env.dbPath).toBe(path.join('/srv/huddle', 'huddle.db'));
  });

  it('overrides ports', () => {
    const env = gateway({
      HUDDLE_API_PORT: '8080',
      HUDDLE_PROXY_PORT: '8081',
      HUDDLE_SBX_PROXY_PORT: '8082',
    });
    expect(env.apiPort).toBe(8080);
    expect(env.proxyPort).toBe(8081);
    expect(env.sbxProxyPort).toBe(8082);
  });

  it('ignores an empty or whitespace-only override', () => {
    const env = gateway({ DB_PATH: '  ', HUDDLE_API_PORT: '' });
    expect(env.dbPath).toBe('/data/huddle.db');
    expect(env.apiPort).toBe(3000);
  });

  // On Linux the gateway container cannot reach a loopback-bound host process,
  // so `huddle init` points the control listener at the bridge address. It is
  // the CONTROL channel that moves — never the portal.
  it('lets the control channel be moved off loopback', () => {
    expect(resolveRuntimeEnv({ HUDDLE_CONTROL_HOST: '172.17.0.1' }).controlBindHost).toBe('172.17.0.1');
    expect(resolveRuntimeEnv({ HUDDLE_CONTROL_PORT: '25000' }).controlPort).toBe(25000);
    expect(gateway({ HUDDLE_NODE_CONTROL_URL: 'http://172.17.0.1:24843' }).nodeControlUrl)
      .toBe('http://172.17.0.1:24843');
  });

  it('lets the bind host be widened deliberately, in either role', () => {
    expect(resolveRuntimeEnv({ HUDDLE_API_HOST: '172.17.0.1' }).apiBindHost).toBe('172.17.0.1');
    expect(gateway({ HUDDLE_API_HOST: '  ' }).apiBindHost).toBe('0.0.0.0');
  });
});

describe('resolveRuntimeEnv — roles', () => {
  it.each(['node', 'gateway'] as const)('accepts %s', (role) => {
    expect(resolveRuntimeEnv({ HUDDLE_ROLE: role }).role).toBe(role);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(resolveRuntimeEnv({ HUDDLE_ROLE: '  GateWay ' }).role).toBe('gateway');
  });

  it('refuses an unknown role rather than picking one', () => {
    expect(() => resolveRuntimeEnv({ HUDDLE_ROLE: 'proxy' })).toThrow(/HUDDLE_ROLE/);
    // 'all' was the combined process. It no longer exists, and quietly
    // accepting it would start a Node that also opens the proxies.
    expect(() => resolveRuntimeEnv({ HUDDLE_ROLE: 'all' })).toThrow(/HUDDLE_ROLE/);
  });

  // index.ts dispatches on these, so getting them wrong either starts the
  // proxies on the host or leaves the firewall with no listener.
  it('runs exactly one plane per role', () => {
    const node = resolveRuntimeEnv({ HUDDLE_ROLE: 'node' });
    expect(node.runsNode).toBe(true);
    expect(node.runsGateway).toBe(false);

    const gw = resolveRuntimeEnv({ HUDDLE_ROLE: 'gateway' });
    expect(gw.runsGateway).toBe(true);
    expect(gw.runsNode).toBe(false);
  });
});

describe('resolveRuntimeEnv — port validation', () => {
  it.each(['0', '65536', '-1', 'http', '80.5'])('refuses %s', (port) => {
    expect(() => resolveRuntimeEnv({ HUDDLE_API_PORT: port })).toThrow(/HUDDLE_API_PORT/);
    expect(() => resolveRuntimeEnv({ HUDDLE_CONTROL_PORT: port })).toThrow(/HUDDLE_CONTROL_PORT/);
  });
});
