import { describe, it, expect, beforeEach } from 'vitest';
import { storeTokenExchange, resolveToken, isPlaceholderToken, managesTokenExchange } from '../src/token-exchange';

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

  // sbx mode: Docker Sandboxes manages the credential itself (the sandbox holds
  // `sk-ant-oat01-proxy-managed`), and the sbx port cannot attribute a request to
  // one sandbox (ADR §1.3). Huddle must therefore keep its hands off the
  // Authorization header there — a placeholder minted for an unattributable
  // caller is unredeemable by construction, which is why the proxy must never
  // mint one in the first place.
  describe('who manages the token', () => {
    it('the devcontainer proxy manages tokens, the sbx port does not', () => {
      expect(managesTokenExchange(false)).toBe(true);
      expect(managesTokenExchange(true)).toBe(false);
    });

    it('shows why: an unattributable caller could never redeem what it was handed', () => {
      const ph = storeTokenExchange(null, 'REAL-TOKEN');
      expect(resolveToken(ph, null)).toBeNull();
    });
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
