import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Which address the CLI talks to Huddle Node on. This is worth a test because
// getting it wrong does not look like a bug: the portal keeps working (a browser
// tries both loopback families), while every CLI command reports that Huddle is
// not running. See nodeProbeUrls() in src/node.ts.

const realFetch = globalThis.fetch;

/** A fetch that only answers on `answering` and refuses everywhere else. */
function fetchAnsweringOn(answering: string, seen: string[]) {
  return vi.fn(async (url: string) => {
    seen.push(url);
    if (!url.startsWith(answering)) throw new Error('fetch failed');
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  });
}

describe('de basis-URL van de CLI', () => {
  beforeEach(() => {
    vi.resetModules();
    delete process.env.HUDDLE_URL;
    delete process.env.HUDDLE_OPERATOR_TOKEN;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('gebruikt de loopback-literal en niet de naam localhost', async () => {
    const seen: string[] = [];
    globalThis.fetch = fetchAnsweringOn('http://127.0.0.1:24842', seen) as never;
    const { get } = await import('../src/api');

    await get('/api/ping');
    expect(seen[0]).toBe('http://127.0.0.1:24842/api/ping');
    expect(seen.join(' ')).not.toContain('localhost');
  });

  // Node bindt één adres, en welk adres dat is hangt van de host af. Een
  // geweigerde verbinding op de eerste is dus geen fout maar het antwoord op de
  // vraag "welke van de twee is het".
  it('valt terug op ::1 als er op 127.0.0.1 niets luistert', async () => {
    const seen: string[] = [];
    globalThis.fetch = fetchAnsweringOn('http://[::1]:24842', seen) as never;
    const { get } = await import('../src/api');

    await expect(get('/api/ping')).resolves.toEqual({});
    expect(seen).toEqual([
      'http://127.0.0.1:24842/api/ping',
      'http://[::1]:24842/api/ping',
    ]);
  });

  it('onthoudt het adres dat antwoordde voor de volgende aanroep', async () => {
    const seen: string[] = [];
    globalThis.fetch = fetchAnsweringOn('http://[::1]:24842', seen) as never;
    const { get } = await import('../src/api');

    await get('/api/ping');
    seen.length = 0;
    await get('/api/ping');
    expect(seen).toEqual(['http://[::1]:24842/api/ping']);
  });

  // Stilletjes met een ander adres praten dan de operator opgaf is erger dan falen.
  it('probeert niets anders als de operator zelf een URL opgeeft', async () => {
    const seen: string[] = [];
    globalThis.fetch = fetchAnsweringOn('http://elders:9000', seen) as never;
    const { get, setBaseUrl, ApiError } = await import('../src/api');

    setBaseUrl('http://127.0.0.1:1/');
    await expect(get('/api/ping')).rejects.toBeInstanceOf(ApiError);
    expect(seen).toEqual(['http://127.0.0.1:1/api/ping']);
  });
});
