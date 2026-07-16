import { describe, it, expect, beforeEach } from 'vitest';
import { storeTokenExchange, resolveToken, isPlaceholderToken } from '../src/token-exchange';

// Token-exchange containerId-binding (finding #12). Puur (alleen crypto).

describe('token-exchange containerId binding', () => {
  it('de container die het token kreeg kan het inwisselen', () => {
    const ph = storeTokenExchange('container-a', 'REAL-TOKEN');
    expect(isPlaceholderToken(ph)).toBe(true);
    expect(resolveToken(ph, 'container-a')).toBe('REAL-TOKEN');
  });

  it('een ANDERE container kan het niet inwisselen (geen cross-container bearer)', () => {
    const ph = storeTokenExchange('container-a', 'REAL-TOKEN');
    expect(resolveToken(ph, 'container-b')).toBeNull();
  });

  it('een ongeïdentificeerde caller (null) kan niets inwisselen', () => {
    const ph = storeTokenExchange('container-a', 'REAL-TOKEN');
    expect(resolveToken(ph, null)).toBeNull();
  });

  it('een null-container placeholder is nooit inwisselbaar (geen "unknown"-bucket)', () => {
    const ph = storeTokenExchange(null, 'REAL-TOKEN');
    expect(resolveToken(ph, '')).toBeNull();
    expect(resolveToken(ph, 'anything')).toBeNull();
  });

  it('onbekende placeholder → null', () => {
    expect(resolveToken('huddle_tok_deadbeef', 'container-a')).toBeNull();
  });

  describe('TTL', () => {
    beforeEach(() => { delete process.env.HUDDLE_TOKEN_PLACEHOLDER_TTL_MS; });

    it('een verlopen placeholder wordt niet meer ingewisseld', async () => {
      process.env.HUDDLE_TOKEN_PLACEHOLDER_TTL_MS = '5'; // 5ms
      const ph = storeTokenExchange('container-a', 'REAL-TOKEN');
      await new Promise(r => setTimeout(r, 15));
      delete process.env.HUDDLE_TOKEN_PLACEHOLDER_TTL_MS;
      expect(resolveToken(ph, 'container-a')).toBeNull();
    });
  });
});
