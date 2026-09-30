import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createControlClient } from '../src/control/client';
import { hashSandboxSecret, mintSandboxSecret } from '../src/sbx-identity';
import type { ContainerFeed, PolicyFeed } from '../src/control/feed';

// The gateway's half of sandbox identity: it is handed sha256(secret) → name in
// the container feed and has to recognise a credential from that alone.
//
// No database and no native binding, deliberately — the same reason the rest of
// control-client.test.ts avoids them. This is the half that keeps enforcing
// while Huddle Node is gone, so it must be testable where SQLite is not.

const EMPTY_POLICY: PolicyFeed = { version: 'p1', rules: [], airlocked: [] };

interface Harness {
  client: ReturnType<typeof createControlClient>;
  /** Publish a new container feed. A new version is what makes the client take it. */
  setSandboxAuth(sandboxAuth: Record<string, string>, version: string): void;
  /** Drop the field entirely, as a Huddle Node predating sandbox identity would. */
  setNoSandboxAuth(version: string): void;
}

function harness(): Harness {
  let containers: Partial<ContainerFeed> = { version: 'c0', byIp: {}, sandboxAuth: {} };

  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith('/control/policy')) return Response.json(EMPTY_POLICY);
    if (url.endsWith('/control/containers')) return Response.json(containers);
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return {
    client: createControlClient({
      baseUrl: 'http://node.test',
      token: 'gw-token',
      fetchImpl,
      nowSeconds: () => 1_000,
      session: 'sess-1',
    }),
    setSandboxAuth: (sandboxAuth, version) => { containers = { version, byIp: {}, sandboxAuth }; },
    setNoSandboxAuth: (version) => { containers = { version, byIp: {} }; },
  };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('recognising a sandbox by its credential', () => {
  it('resolves a known secret to the sandbox that owns it', async () => {
    const secretA = mintSandboxSecret();
    const secretB = mintSandboxSecret();
    const h = harness();
    h.setSandboxAuth({ [hashSandboxSecret(secretA)]: 'box-a', [hashSandboxSecret(secretB)]: 'box-b' }, 'c1');
    await h.client.refresh();

    expect(h.client.plane.resolveSandboxBySecret(secretA)).toBe('box-a');
    expect(h.client.plane.resolveSandboxBySecret(secretB)).toBe('box-b');
  });

  it('resolves nothing for a secret it was never given', async () => {
    const h = harness();
    h.setSandboxAuth({ [hashSandboxSecret('secret-a')]: 'box-a' }, 'c1');
    await h.client.refresh();

    // The point of the whole scheme: a credential nobody minted names no box, so
    // the proxy has nothing to attribute the request to and denies it. It never
    // falls back to a wider rule set.
    expect(h.client.plane.resolveSandboxBySecret('secret-guessed')).toBe(null);
    // Not the hash either — presenting sha256(secret) is not presenting secret.
    expect(h.client.plane.resolveSandboxBySecret(hashSandboxSecret('secret-a'))).toBe(null);
  });

  it('recognises nothing before the first feed, and nothing from a Node without the field', async () => {
    const h = harness();
    // Before any poll: the gateway holds no identities at all.
    expect(h.client.plane.resolveSandboxBySecret('secret-a')).toBe(null);

    h.setNoSandboxAuth('c1');
    await h.client.refresh();
    // A Huddle Node that predates sandbox identity sends no map. Denying every
    // sandbox is the safe half of that mismatch.
    expect(h.client.plane.resolveSandboxBySecret('secret-a')).toBe(null);
  });

  it('picks up a sandbox created after it last polled, and drops a removed one', async () => {
    const secretA = mintSandboxSecret();
    const secretB = mintSandboxSecret();
    const h = harness();
    h.setSandboxAuth({ [hashSandboxSecret(secretA)]: 'box-a' }, 'c1');
    await h.client.refresh();
    expect(h.client.plane.resolveSandboxBySecret(secretB)).toBe(null);

    // The feed version has to move with its content, or a new sandbox is denied
    // by a 304 forever — the container feed is polled with If-None-Match.
    h.setSandboxAuth({ [hashSandboxSecret(secretA)]: 'box-a', [hashSandboxSecret(secretB)]: 'box-b' }, 'c2');
    await h.client.refresh();
    expect(h.client.plane.resolveSandboxBySecret(secretB)).toBe('box-b');

    h.setSandboxAuth({ [hashSandboxSecret(secretB)]: 'box-b' }, 'c3');
    await h.client.refresh();
    // `sbx rm` takes the secret with it; a box that comes back holding the old
    // one is a stranger, not box-a.
    expect(h.client.plane.resolveSandboxBySecret(secretA)).toBe(null);
  });

  it('keeps two sandboxes apart rather than merging them', async () => {
    const h = harness();
    h.setSandboxAuth({ [hashSandboxSecret('a')]: 'box-a', [hashSandboxSecret('b')]: 'box-b' }, 'c1');
    await h.client.refresh();
    expect(h.client.plane.resolveSandboxBySecret('a')).toBe('box-a');
    expect(h.client.plane.resolveSandboxBySecret('b')).toBe('box-b');
  });

  it('is unmoved by a hash of the wrong shape', async () => {
    const h = harness();
    // A truncated or garbage entry must not throw out of the hot path: the
    // comparison is length-checked before it is timing-safe.
    h.setSandboxAuth({ 'not-a-sha256': 'box-a', '': 'box-b' }, 'c1');
    await h.client.refresh();
    expect(h.client.plane.resolveSandboxBySecret('secret-a')).toBe(null);
    expect(() => h.client.plane.resolveSandboxBySecret('')).not.toThrow();
  });
});
