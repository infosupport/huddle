import { describe, it, expect, afterEach, vi } from 'vitest';
import type { IncomingMessage } from 'http';
import { mintSandboxSecret, sandboxProxyUrl } from '../src/sbx-identity';

// The probe exists to explain an attribution — which box a request was judged
// as. It used to print Proxy-Authorization raw, which was harmless while the
// value meant nothing and is a leaked credential now that it IS the identity
// (docs/ADR-sbx-identity.md §5: nothing logs it). The header is redacted at the
// only place it is read, so the guarantee does not depend on who calls this.

async function probeLines(headers: Record<string, string>): Promise<string[]> {
  process.env.HUDDLE_IDENTITY_PROBE = '1';
  vi.resetModules();
  const { logIdentityProbe } = await import('../src/identity-probe');
  const lines: string[] = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { lines.push(String(m)); });
  try {
    logIdentityProbe('connect', { headers, url: 'example.com:443' } as unknown as IncomingMessage, '127.0.0.1', 'box-a');
  } finally {
    spy.mockRestore();
  }
  return lines;
}

describe('identity probe', () => {
  afterEach(() => { delete process.env.HUDDLE_IDENTITY_PROBE; vi.resetModules(); });

  it('never prints the sandbox secret, in any encoding', async () => {
    const secret = mintSandboxSecret();
    // Built the way sbx presents it, so the test breaks if the wire format moves.
    const url = new URL(sandboxProxyUrl('http://localhost:24842', 'box-a', secret));
    const basic = Buffer.from(`${url.username}:${url.password}`, 'utf8').toString('base64');
    const [line] = await probeLines({ 'proxy-authorization': `Basic ${basic}` });

    expect(line).toBeDefined();
    expect(line).not.toContain(secret);          // decoded
    expect(line).not.toContain(basic);           // as sent
    expect(line).not.toContain(url.password);    // as the URL carries it
  });

  it('still says which box presented a credential, and in what form', async () => {
    const basic = Buffer.from('box-a:s3cret', 'utf8').toString('base64');
    const [line] = await probeLines({ 'proxy-authorization': `Basic ${basic}` });
    expect(line).toContain('box-a');
    expect(line).toContain('Basic box-a:***');
    expect(line).not.toContain('s3cret');
  });

  it('redacts a scheme it cannot decode rather than passing it through', async () => {
    const [line] = await probeLines({ 'proxy-authorization': 'Bearer abcdef.token.value' });
    expect(line).toContain('Bearer ***');
    expect(line).not.toContain('abcdef.token.value');
  });

  it('says nothing at all unless the probe is switched on', async () => {
    delete process.env.HUDDLE_IDENTITY_PROBE;
    vi.resetModules();
    const { logIdentityProbe } = await import('../src/identity-probe');
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((m?: unknown) => { lines.push(String(m)); });
    logIdentityProbe('request', { headers: { 'proxy-authorization': 'Basic x' }, url: '/' } as unknown as IncomingMessage, '127.0.0.1', null);
    spy.mockRestore();
    expect(lines).toEqual([]);
  });
});
