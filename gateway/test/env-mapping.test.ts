import { describe, it, expect } from 'vitest';
import { validateEnvMappingKeys, fromWireEnvPatch } from '../src/host-config';

// Environment variable mappings (#108). Two things are worth testing without a
// container or a proxy: the fail-closed field validation on the CRUD wire shape
// (same reasoning as folder-mapping.test.ts), and the decision that swaps a
// placeholder for a real secret at the egress proxy.
//
// env-mappings.ts reaches db.ts through rules.ts, and db.ts instantiates the
// native better-sqlite3 binding at import time. That binding is missing in a
// fresh DMZ devcontainer (nodejs.org blocked -> node-gyp cannot fetch headers),
// so probe first and skip rather than fail. In CI / the huddle image this runs
// in full.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[env-mapping.test] SKIPPED (secret substitution) — better-sqlite3 binding not usable: ${(e as Error).message}\n` +
    `  Fix on your host: \`npm rebuild better-sqlite3\` (or remove node_modules and \`npm install\`).`
  );
}

const d = sqliteAvailable ? describe : describe.skip;

// host-config.ts needs no native binding, so the wire-shape suites always run.
describe('validateEnvMappingKeys (fail-closed)', () => {
  it('allows the known wire fields', () => {
    expect(validateEnvMappingKeys({ name: 'x', is_secret: 1 }).sort()).toEqual(['is_secret', 'name']);
  });

  it('rejects a prepared injection key', () => {
    expect(() =>
      validateEnvMappingKeys({
        'var_name = (SELECT value FROM env_secrets LIMIT 1), name': 'x',
      }),
    ).toThrow(/unknown env-mapping field/i);
  });

  it('rejects every unknown key', () => {
    expect(() => validateEnvMappingKeys({ id: 5 })).toThrow(/unknown/i);
    expect(() => validateEnvMappingKeys({ evil: 1 })).toThrow(/unknown/i);
  });
});

describe('fromWireEnvPatch', () => {
  it('converts the wire shape into the config shape', () => {
    expect(fromWireEnvPatch({
      name: 'Anthropic key', var_name: 'ANTHROPIC_API_KEY', value: '',
      is_secret: 1, secret_hosts: 'api.anthropic.com', is_global: 0, enabled: 1, sort_order: 2,
    })).toEqual({
      name: 'Anthropic key', varName: 'ANTHROPIC_API_KEY', value: '',
      secret: true, secretHosts: 'api.anthropic.com', global: false, enabled: true, sortOrder: 2,
    });
  });

  it('keeps a partial patch partial', () => {
    expect(fromWireEnvPatch({ enabled: 0 })).toEqual({ enabled: false });
  });

  it('throws on an unknown key instead of silently dropping it', () => {
    expect(() => fromWireEnvPatch({ enabled: 1, evil: 'x' })).toThrow(/unknown/i);
  });
});

const {
  validateEnvVarName,
  validateEnvValue,
  parseSecretHosts,
  secretHostAllowed,
  substituteEnvSecrets,
  buildEnvEntries,
  newEnvPlaceholder,
  isEnvPlaceholder,
} = sqliteAvailable
  ? await import('../src/env-mappings')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  : ({} as any);

d('validateEnvVarName', () => {
  it('accepts an ordinary variable name', () => {
    expect(() => validateEnvVarName('FOO_BAR')).not.toThrow();
    expect(() => validateEnvVarName('_private1')).not.toThrow();
  });

  it('rejects a name that is not a shell variable', () => {
    expect(() => validateEnvVarName('1FOO')).toThrow(/invalid variable name/i);
    expect(() => validateEnvVarName('FOO-BAR')).toThrow(/invalid variable name/i);
    expect(() => validateEnvVarName('FOO=BAR')).toThrow(/invalid variable name/i);
    expect(() => validateEnvVarName('')).toThrow(/invalid variable name/i);
  });

  // The important one: a mapping that could set HTTPS_PROXY would route the
  // container's traffic around the egress firewall.
  it('rejects the variables that carry huddle’s own security posture', () => {
    for (const name of ['HTTPS_PROXY', 'http_proxy', 'NO_PROXY', 'DOCKER_HOST',
                        'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
                        'LD_PRELOAD', 'PATH']) {
      expect(() => validateEnvVarName(name), name).toThrow(/reserved by Huddle/i);
    }
  });
});

d('validateEnvValue', () => {
  it('accepts an ordinary value', () => {
    expect(() => validateEnvValue('sk-ant-123')).not.toThrow();
    expect(() => validateEnvValue('')).not.toThrow();
  });

  // Docker's Env is a list of `NAME=value` strings; a newline would split the
  // entry and let one mapping define a second, unvalidated variable.
  it('rejects a value that would break out of its Env entry', () => {
    expect(() => validateEnvValue('a\nHTTPS_PROXY=http://evil')).toThrow(/newlines or NUL/i);
    expect(() => validateEnvValue('a\r\nb')).toThrow(/newlines or NUL/i);
    expect(() => validateEnvValue('a\0b')).toThrow(/newlines or NUL/i);
  });
});

d('secret host allowlist', () => {
  it('parses a comma- or space-separated list', () => {
    expect(parseSecretHosts('api.github.com, *.github.com')).toEqual(['api.github.com', '*.github.com']);
    expect(parseSecretHosts('  API.Example.com  ')).toEqual(['api.example.com']);
    expect(parseSecretHosts('')).toEqual([]);
  });

  it('matches exactly and by wildcard, like a firewall rule', () => {
    expect(secretHostAllowed(['api.github.com'], 'api.github.com')).toBe(true);
    expect(secretHostAllowed(['*.github.com'], 'api.github.com')).toBe(true);
    expect(secretHostAllowed(['*.github.com'], 'github.com')).toBe(false);
    expect(secretHostAllowed(['api.github.com'], 'evilapi.github.com')).toBe(false);
  });

  it('never matches on an empty allowlist (fail-closed)', () => {
    expect(secretHostAllowed([], 'api.github.com')).toBe(false);
    expect(secretHostAllowed(['api.github.com'], '')).toBe(false);
  });
});

d('substituteEnvSecrets', () => {
  const PLACEHOLDER = 'huddle_env_' + 'a1b2c3d4'.repeat(8); // 64 hex chars
  const OWNER = 'devcontainer-app';

  // Stands in for the DB + config lookup: this placeholder belongs to OWNER and
  // may only be redeemed towards api.example.com.
  const lookup = (p: string, containerId: string) =>
    p === PLACEHOLDER && containerId === OWNER
      ? { value: 'real-secret', hosts: 'api.example.com' }
      : null;

  it('swaps the placeholder for the real secret on an allowlisted host', () => {
    const headers: Record<string, unknown> = { authorization: `Bearer ${PLACEHOLDER}` };
    substituteEnvSecrets(headers, 'api.example.com', OWNER, lookup);
    expect(headers.authorization).toBe('Bearer real-secret');
  });

  it('leaves the placeholder alone for a host outside the allowlist', () => {
    const headers: Record<string, unknown> = { 'x-api-key': PLACEHOLDER };
    substituteEnvSecrets(headers, 'attacker.example.org', OWNER, lookup);
    expect(headers['x-api-key']).toBe(PLACEHOLDER);
  });

  it('leaves the placeholder alone for a container that does not own it', () => {
    const headers: Record<string, unknown> = { 'x-api-key': PLACEHOLDER };
    substituteEnvSecrets(headers, 'api.example.com', 'devcontainer-other', lookup);
    expect(headers['x-api-key']).toBe(PLACEHOLDER);
  });

  it('does nothing at all for an unidentified caller', () => {
    const headers: Record<string, unknown> = { 'x-api-key': PLACEHOLDER };
    substituteEnvSecrets(headers, 'api.example.com', null, lookup);
    expect(headers['x-api-key']).toBe(PLACEHOLDER);
  });

  it('never redeems a mapping whose allowlist is empty', () => {
    const headers: Record<string, unknown> = { 'x-api-key': PLACEHOLDER };
    substituteEnvSecrets(headers, 'api.example.com', OWNER, () => ({ value: 'real-secret', hosts: '' }));
    expect(headers['x-api-key']).toBe(PLACEHOLDER);
  });

  it('handles array-valued headers and leaves other headers untouched', () => {
    const headers: Record<string, unknown> = {
      cookie: [`a=${PLACEHOLDER}`, 'b=plain'],
      'user-agent': 'curl/8',
    };
    substituteEnvSecrets(headers, 'api.example.com', OWNER, lookup);
    expect(headers.cookie).toEqual(['a=real-secret', 'b=plain']);
    expect(headers['user-agent']).toBe('curl/8');
  });

  it('leaves a value that merely looks like a placeholder alone', () => {
    const headers: Record<string, unknown> = { 'x-api-key': 'huddle_env_short' };
    substituteEnvSecrets(headers, 'api.example.com', OWNER, lookup);
    expect(headers['x-api-key']).toBe('huddle_env_short');
  });
});

d('placeholder shape', () => {
  it('generates a distinct, recognisable placeholder every time', () => {
    const a = newEnvPlaceholder();
    const b = newEnvPlaceholder();
    expect(a).not.toBe(b);
    expect(isEnvPlaceholder(a)).toBe(true);
    expect(isEnvPlaceholder('huddle_env_nothex')).toBe(false);
  });
});

d('buildEnvEntries', () => {
  const mapping = (over: Record<string, unknown> = {}) => ({
    id: 1, name: 'Demo', varName: 'DEMO', value: 'plain',
    secret: false, secretHosts: '', global: true, enabled: true, sortOrder: 0,
    ...over,
  });

  it('exports a plain mapping verbatim', () => {
    const built = buildEnvEntries([mapping()], () => null);
    expect(built.entries).toEqual(['DEMO=plain']);
    expect(built.containerRows).toEqual([{ mapping_id: 1, placeholder: null }]);
  });

  // The heart of the feature: the real secret must not reach the container.
  it('hands a secret mapping a placeholder, never the real value', () => {
    const built = buildEnvEntries(
      [mapping({ secret: true, secretHosts: 'api.example.com', value: '' })],
      () => 'real-secret',
      () => 'huddle_env_' + 'f'.repeat(64),
    );
    expect(built.entries).toEqual([`DEMO=huddle_env_${'f'.repeat(64)}`]);
    expect(built.entries.join()).not.toContain('real-secret');
    expect(built.containerRows[0].placeholder).toBe('huddle_env_' + 'f'.repeat(64));
  });

  it('skips a disabled mapping', () => {
    expect(buildEnvEntries([mapping({ enabled: false })], () => null).entries).toEqual([]);
  });

  it('skips a secret mapping with nothing stored instead of exporting it empty', () => {
    const built = buildEnvEntries([mapping({ secret: true, secretHosts: 'a.example.com' })], () => null);
    expect(built.entries).toEqual([]);
    expect(built.skipped[0].reason).toMatch(/no stored value/i);
  });

  // config.json is hand-editable, so an invalid mapping can be on disk. It must
  // be skipped, not allowed to override huddle's own environment.
  it('skips a reserved or malformed variable instead of exporting it', () => {
    const built = buildEnvEntries(
      [mapping({ id: 2, varName: 'HTTPS_PROXY', value: 'http://evil' }),
       mapping({ id: 3, varName: 'BAD-NAME' })],
      () => null,
    );
    expect(built.entries).toEqual([]);
    expect(built.skipped.map(s => s.id)).toEqual([2, 3]);
  });
});
