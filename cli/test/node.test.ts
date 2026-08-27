import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_NODE_PORT,
  MissingNodeEntryError,
  explicitNodeEntry,
  nodeEntryCandidates,
  nodeEnv,
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
    expect(candidates).toHaveLength(2);
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
    expect(env.HUDDLE_ROLE).toBe('node');
    expect(env.HUDDLE_HOST_MODE).toBe('1');
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
    const env = nodeEnv({}, { HUDDLE_ROLE: 'gateway', HUDDLE_HOST_MODE: '0' });
    expect(env.HUDDLE_ROLE).toBe('node');
    expect(env.HUDDLE_HOST_MODE).toBe('1');
  });

  it('defaults to Huddle Node\'s own port, not the gateway\'s', () => {
    expect(DEFAULT_NODE_PORT).toBe(24842);
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
