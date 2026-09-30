import { describe, it, expect, afterEach } from 'vitest';
import { bundleSha256, checkExtensionIntegrity, loadExtension } from '../src/extensions/loader';

// Extensie-integriteitscheck (finding #11). loader.ts importeert het DB-handle
// alleen als type (erased op runtime) en opent zelf geen database, dus deze test
// raakt geen opslag.

const bundle = Buffer.from('fake-extension-zip-bytes');
const hash = bundleSha256(bundle);

afterEach(() => { delete process.env.HUDDLE_EXTENSION_SHA256_ALLOWLIST; });

describe('checkExtensionIntegrity', () => {
  it('log-only zonder allowlist → toegestaan (null)', () => {
    expect(checkExtensionIntegrity(bundle)).toBeNull();
  });

  it('bundel op de allowlist → toegestaan', () => {
    process.env.HUDDLE_EXTENSION_SHA256_ALLOWLIST = hash;
    expect(checkExtensionIntegrity(bundle)).toBeNull();
  });

  it('allowlist gezet maar bundel-hash ontbreekt → geweigerd', () => {
    process.env.HUDDLE_EXTENSION_SHA256_ALLOWLIST = 'deadbeef';
    expect(checkExtensionIntegrity(bundle)).toMatch(/not on HUDDLE_EXTENSION_SHA256_ALLOWLIST/);
  });

  it('allowlist is hoofdletter-ongevoelig en tolereert spaties', () => {
    process.env.HUDDLE_EXTENSION_SHA256_ALLOWLIST = ` OTHER , ${hash.toUpperCase()} `;
    expect(checkExtensionIntegrity(bundle)).toBeNull();
  });
});

describe('loadExtension id guard', () => {
  // The id indexes a directory under baseDir via path.join; a non-basename id
  // must be rejected up front so the readFile sink can never traverse out.
  it('rejects a traversal / non-basename id before any fs access', async () => {
    await expect(loadExtension('../evil')).rejects.toThrow(/invalid extension id/);
    await expect(loadExtension('a/b')).rejects.toThrow(/invalid extension id/);
    await expect(loadExtension('..')).rejects.toThrow(/invalid extension id/);
  });
});
