import { describe, it, expect, afterEach } from 'vitest';
import { bundleSha256, checkExtensionIntegrity } from '../src/extensions/loader';

// Extensie-integriteitscheck (finding #11). loader.ts importeert better-sqlite3
// alleen als type (erased op runtime) en instantieert geen DB, dus dit draait
// zonder de native binding.

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
