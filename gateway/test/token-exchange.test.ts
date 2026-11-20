import { describe, it, expect, beforeEach, vi } from 'vitest';
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

describe('revokeTokenExchange', () => {
  it('a revoked placeholder can no longer be redeemed', async () => {
    const { revokeTokenExchange } = await import('../src/token-exchange');
    const ph = storeTokenExchange('container-r', 'REAL-TOKEN', 'host');
    revokeTokenExchange('container-r');
    expect(resolveToken(ph, 'container-r')).toBeNull();
  });

  it('only revokes the placeholder of that container', async () => {
    const { revokeTokenExchange } = await import('../src/token-exchange');
    const a = storeTokenExchange('container-x', 'A', 'host');
    const b = storeTokenExchange('container-y', 'B', 'host');
    revokeTokenExchange('container-x');
    expect(resolveToken(a, 'container-x')).toBeNull();
    expect(resolveToken(b, 'container-y')).toBe('B');
  });
});

describe('token slots', () => {
  it('a host-registered token does not evict the login placeholder of the same container, and back', async () => {
    const { revokeTokenExchange } = await import('../src/token-exchange');
    const login = storeTokenExchange('container-s', 'LOGIN');
    const host = storeTokenExchange('container-s', 'HOST', 'host');
    expect(resolveToken(login, 'container-s')).toBe('LOGIN');
    expect(resolveToken(host, 'container-s')).toBe('HOST');
    const login2 = storeTokenExchange('container-s', 'LOGIN2');
    expect(resolveToken(login, 'container-s')).toBeNull(); // same slot: replaced
    expect(resolveToken(host, 'container-s')).toBe('HOST');
    revokeTokenExchange('container-s');
    expect(resolveToken(host, 'container-s')).toBeNull();
    expect(resolveToken(login2, 'container-s')).toBe('LOGIN2');
  });
});

// Host-side registration routes (update agent). The audit log is mocked so the
// test does not need the better-sqlite3 binding.
vi.mock("../src/db", () => ({ logAudit: vi.fn() }));

describe('token registration routes', () => {
  async function buildApp() {
    const Fastify = (await import('fastify')).default;
    const { registerTokenExchangeRoutes } = await import('../src/token-exchange-api');
    const app = Fastify({ logger: false });
    registerTokenExchangeRoutes(app);
    return app;
  }

  it('returns a placeholder that resolves only for the registered container', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/docker/containers/update-agent-pr-12/token',
      payload: { secret: 'sk-ant-real' },
    });
    expect(res.statusCode).toBe(200);
    const { placeholder } = res.json() as { placeholder: string };
    expect(isPlaceholderToken(placeholder)).toBe(true);
    expect(placeholder).not.toContain('sk-ant-real');
    expect(resolveToken(placeholder, 'update-agent-pr-12')).toBe('sk-ant-real');
    expect(resolveToken(placeholder, 'other-container')).toBeNull();
  });

  it('DELETE revokes the placeholder', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/docker/containers/update-agent-pr-13/token',
      payload: { secret: 'sk-ant-real' },
    });
    const { placeholder } = res.json() as { placeholder: string };
    const del = await app.inject({ method: 'DELETE', url: '/api/docker/containers/update-agent-pr-13/token' });
    expect(del.statusCode).toBe(200);
    expect(resolveToken(placeholder, 'update-agent-pr-13')).toBeNull();
  });

  it.each([
    [{}, 'missing secret'],
    [{ secret: '' }, 'empty secret'],
    [{ secret: 'abc def' }, 'whitespace'],
    [{ secret: 'abc\r\nX-Evil: 1' }, 'CRLF header injection'],
    [{ secret: 42 }, 'non-string'],
  ])('rejects %j (%s)', async (payload) => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/api/docker/containers/c1/token', payload });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an invalid container name', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/docker/containers/-bad/token',
      payload: { secret: 'x' },
    });
    expect(res.statusCode).toBe(400);
  });
});
