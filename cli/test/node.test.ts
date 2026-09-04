import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_NODE_PORT,
  MissingNodeEntryError,
  explicitNodeEntry,
  nodeEntryCandidates,
  nodeLaunch,
  nodeEnv,
  nodeProbeUrls,
  platformNodePackageName,
  nodeUrl,
  resolveNodeEntry,
} from '../src/node';
import { parseArgs } from '../src/index';

// `huddle node` runs the control plane on the host (docs/ADR-huddle-node-split.md,
// step 3). Two things have to be right: which build it picks, and the environment
// it hands that build — get the second wrong and a "Huddle Node" quietly starts
// the proxies too, or writes to the container's /data instead of ~/.huddle.

let tmp: string;
let realEntry: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-node-test-'));
  realEntry = path.join(tmp, 'index.js');
  fs.writeFileSync(realEntry, '// a build that exists\n');
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('explicitNodeEntry', () => {
  it('is null when nothing is named', () => {
    expect(explicitNodeEntry({}, {})).toBeNull();
  });

  it('takes the flag', () => {
    expect(explicitNodeEntry({ entry: realEntry }, {})).toBe(realEntry);
  });

  it('falls back to HUDDLE_NODE_ENTRY', () => {
    expect(explicitNodeEntry({}, { HUDDLE_NODE_ENTRY: realEntry })).toBe(realEntry);
  });

  it('lets the flag win over the env var', () => {
    const other = path.join(tmp, 'other.js');
    expect(explicitNodeEntry({ entry: realEntry }, { HUDDLE_NODE_ENTRY: other })).toBe(realEntry);
  });

  it('returns an absolute path so the spawn does not depend on cwd', () => {
    expect(path.isAbsolute(explicitNodeEntry({ entry: 'rel/path.js' }, {})!)).toBe(true);
  });
});

describe('nodeEntryCandidates', () => {
  it('looks for the gateway build next to the CLI in a checkout', () => {
    const candidates = nodeEntryCandidates('/repo/cli/dist');
    expect(candidates[0]).toBe(path.resolve('/repo/gateway/dist/index.js'));
  });

  // Order is the assertion. Someone working ON Huddle has both a checkout build
  // and, sooner or later, a downloaded executable; running the download when
  // they just rebuilt is the confusing failure, not the other way round.
  it('prefers a checkout build over a downloaded single executable', () => {
    const candidates = nodeEntryCandidates('/repo/cli/dist');
    const script = candidates.findIndex((c) => c.endsWith(`dist${path.sep}index.js`));
    const sea = candidates.findIndex((c) => c.includes(`build${path.sep}sea`));
    expect(script).toBeGreaterThanOrEqual(0);
    expect(sea).toBeGreaterThan(script);
  });

  it('looks for a single executable in ~/.huddle', () => {
    const candidates = nodeEntryCandidates('/repo/cli/dist');
    expect(candidates.some((c) => c.startsWith(path.join(os.homedir(), '.huddle')))).toBe(true);
  });

  it('uses the optional package selected for this host', () => {
    const cliDir = path.join(tmp, 'installed-cli', 'dist');
    const pkg = platformNodePackageName();
    expect(pkg).not.toBeNull();
    const executable = process.platform === 'win32' ? 'huddle-node.exe' : 'huddle-node';
    const entry = path.join(tmp, 'installed-cli', 'node_modules', ...pkg!.split('/'), 'bin', executable);
    fs.mkdirSync(path.dirname(entry), { recursive: true });
    fs.writeFileSync(path.join(path.dirname(entry), '..', 'package.json'), JSON.stringify({ name: pkg }));
    fs.writeFileSync(entry, 'SEA');
    expect(nodeEntryCandidates(cliDir)).toContain(entry);
    expect(resolveNodeEntry({}, cliDir, {})).toBe(entry);
  });

  it('names only supported release targets', () => {
    expect(platformNodePackageName('win32', 'x64')).toBe('@infosupport/huddle-node-win32-x64');
    expect(platformNodePackageName('darwin', 'arm64')).toBe('@infosupport/huddle-node-darwin-arm64');
    expect(platformNodePackageName('linux', 'x64')).toBe('@infosupport/huddle-node-linux-x64');
    expect(platformNodePackageName('linux', 'arm64')).toBeNull();
  });
});

describe('nodeLaunch', () => {
  it('runs a .js build under this Node', () => {
    expect(nodeLaunch('/repo/gateway/dist/index.js')).toEqual({
      command: process.execPath,
      args: ['/repo/gateway/dist/index.js'],
    });
  });

  // A single executable IS a Node with the app injected. Passing it to `node`
  // would make it argv[1] — a REPL on POSIX, ENOEXEC on Windows.
  it('runs a single executable on its own, with no interpreter', () => {
    expect(nodeLaunch('/downloads/huddle-node')).toEqual({
      command: '/downloads/huddle-node',
      args: [],
    });
    expect(nodeLaunch('C:\\tools\\huddle-node.exe')).toEqual({
      command: 'C:\\tools\\huddle-node.exe',
      args: [],
    });
  });

  it('decides on the extension, not on the case it was written in', () => {
    expect(nodeLaunch('/repo/gateway/dist/INDEX.JS').command).toBe(process.execPath);
  });
});

describe('resolveNodeEntry', () => {
  it('returns an explicitly named build that exists', () => {
    expect(resolveNodeEntry({ entry: realEntry }, '/nowhere', {})).toBe(realEntry);
  });

  // The important one: naming a build is a claim about WHICH build to run, so a
  // missing file must fail rather than silently starting some other build that
  // happens to exist in the checkout.
  it('throws rather than falling back when a named build is missing', () => {
    const missing = path.join(tmp, 'not-built.js');
    expect(() => resolveNodeEntry({ entry: missing }, '/nowhere', {})).toThrow(MissingNodeEntryError);
    expect(() => resolveNodeEntry({}, '/nowhere', { HUDDLE_NODE_ENTRY: missing })).toThrow(MissingNodeEntryError);
  });

  it('names the missing path in the error', () => {
    const missing = path.join(tmp, 'not-built.js');
    expect(() => resolveNodeEntry({ entry: missing }, '/nowhere', {})).toThrow(missing);
  });

  it('searches the checkout when nothing is named', () => {
    // tmp/cli/dist → tmp/gateway/dist/index.js
    const cliDir = path.join(tmp, 'cli', 'dist');
    const gatewayBuild = path.join(tmp, 'gateway', 'dist', 'index.js');
    fs.mkdirSync(path.dirname(gatewayBuild), { recursive: true });
    fs.writeFileSync(gatewayBuild, '// checkout build\n');
    expect(resolveNodeEntry({}, cliDir, {})).toBe(gatewayBuild);
  });

  it('returns null when there is nothing to run', () => {
    // Its own temp root: the candidates reach two levels up, so a sibling
    // fixture elsewhere under tmp would be found and mask this.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-node-bare-'));
    try {
      expect(resolveNodeEntry({}, path.join(bare, 'cli', 'dist'), {})).toBeNull();
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });
});

describe('nodeEnv', () => {
  it('drops the proxies and moves off the container layout', () => {
    const env = nodeEnv({}, {});
    // The role IS the deployment — there is no separate host-mode switch, and
    // `node` already means "host layout, no proxies" (gateway/src/runtime-env.ts).
    expect(env.HUDDLE_ROLE).toBe('node');
  });

  it('leaves port and data dir to runtime-env defaults when not given', () => {
    const env = nodeEnv({}, {});
    expect(env.HUDDLE_API_PORT).toBeUndefined();
    expect(env.HUDDLE_DATA_DIR).toBeUndefined();
  });

  it('passes through port and data dir when given', () => {
    const env = nodeEnv({ port: '25000', dataDir: tmp }, {});
    expect(env.HUDDLE_API_PORT).toBe('25000');
    expect(env.HUDDLE_DATA_DIR).toBe(path.resolve(tmp));
  });

  it('keeps the rest of the caller environment', () => {
    const env = nodeEnv({}, { PATH: '/usr/bin', HUDDLE_OPERATOR_TOKEN: 'secret' });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HUDDLE_OPERATOR_TOKEN).toBe('secret');
  });

  // A stale HUDDLE_ROLE=gateway in the operator's shell must not turn `huddle
  // node` into a process that opens the firewall proxies on the host.
  it('overrides a conflicting role already in the environment', () => {
    const env = nodeEnv({}, { HUDDLE_ROLE: 'gateway' });
    expect(env.HUDDLE_ROLE).toBe('node');
  });

  it('defaults to Huddle Node\'s own port, not the gateway\'s', () => {
    expect(DEFAULT_NODE_PORT).toBe(24842);
  });
});

describe('nodeProbeUrls', () => {
  // The split's most confusing failure mode: the portal opens in the browser but
  // `huddle init` reports Node "did not come up" and exits before it creates the
  // gateway container. Node binds 127.0.0.1; `localhost` is ::1 first on Windows.
  it('probes loopback literals, not the name localhost', () => {
    delete process.env.HUDDLE_API_HOST;
    expect(nodeProbeUrls(24842)).toEqual(['http://127.0.0.1:24842', 'http://[::1]:24842']);
    expect(nodeProbeUrls(24842).some((u) => u.includes('localhost'))).toBe(false);
  });

  it('still shows humans a localhost URL', () => {
    expect(nodeUrl(24842)).toBe('http://localhost:24842');
  });

  it('defaults to the node port', () => {
    delete process.env.HUDDLE_API_HOST;
    expect(nodeProbeUrls()[0]).toBe(`http://127.0.0.1:${DEFAULT_NODE_PORT}`);
  });

  it('follows HUDDLE_API_HOST when Node is bound off loopback', () => {
    process.env.HUDDLE_API_HOST = '192.168.1.5';
    expect(nodeProbeUrls(24842)).toEqual(['http://192.168.1.5:24842']);
    delete process.env.HUDDLE_API_HOST;
  });

  it('brackets a bare IPv6 bind address', () => {
    process.env.HUDDLE_API_HOST = 'fe80::1';
    expect(nodeProbeUrls(24842)).toEqual(['http://[fe80::1]:24842']);
    process.env.HUDDLE_API_HOST = '[fe80::1]';
    expect(nodeProbeUrls(24842)).toEqual(['http://[fe80::1]:24842']);
    delete process.env.HUDDLE_API_HOST;
  });

  it('treats a wildcard bind as "loopback will do"', () => {
    for (const wildcard of ['0.0.0.0', '::']) {
      process.env.HUDDLE_API_HOST = wildcard;
      expect(nodeProbeUrls(24842)).toEqual(['http://127.0.0.1:24842', 'http://[::1]:24842']);
    }
    delete process.env.HUDDLE_API_HOST;
  });
});

describe('parseArgs — the node command', () => {
  it('takes node as a command with its value flags', () => {
    const { positional, flags } = parseArgs(['node', '--entry', '/b/index.js', '--port', '25000', '--data-dir', '/d']);
    expect(positional).toEqual(['node']);
    expect(flags.entry).toBe('/b/index.js');
    expect(flags.port).toBe('25000');
    expect(flags['data-dir']).toBe('/d');
  });

  it('accepts --flag=value form', () => {
    const { flags } = parseArgs(['node', '--port=25000']);
    expect(flags.port).toBe('25000');
  });

  // 'node' must be a known command, or the "folder that exists" branch in main()
  // could treat it as a path to start a devcontainer in.
  it('does not swallow the next argument as a positional', () => {
    const { positional } = parseArgs(['node', '--port', '25000']);
    expect(positional).toEqual(['node']);
  });
});
