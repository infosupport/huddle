import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// docker.ts pulls in socket-proxy.ts, which touches the database on import
// (see docker-actions.test.ts) — mocked out so this test only needs http.
vi.mock('../src/db', () => ({
  isHostPortApproved: () => false,
  getActionPolicy: () => null,
  getGrant: () => null,
}));

// Fakes the Docker socket call connectNetwork makes, one response per call so
// the "already connected" (rejected) case can be told apart from a real
// connect (resolved).
const responses: { statusCode: number; body: string }[] = [];
vi.mock('http', () => ({
  default: {
    request: (_opts: unknown, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const next = responses.shift() ?? { statusCode: 200, body: '{}' };
      const res = Object.assign(new EventEmitter(), { statusCode: next.statusCode });
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        queueMicrotask(() => {
          cb(res);
          res.emit('data', next.body);
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

const { connectNetwork, currentNetworkGeneration } = await import('../src/docker');

// The network-generation counter is what lets the container feed change on a
// reconnect alone — see feed.ts's ContainerFeed.networkGeneration and
// dns-egress.ts. A connect that Docker/Podman rejects as already-connected
// touched nothing, so it must not bump the counter; a connect that succeeds
// really did touch resolv.conf, so it must.
describe('docker.ts — network-generation counter', () => {
  beforeEach(() => { responses.length = 0; });

  it('bumps on a successful connect', async () => {
    const before = currentNetworkGeneration();
    responses.push({ statusCode: 200, body: '{}' });
    await connectNetwork('dc-net-alpha', 'huddle');
    expect(currentNetworkGeneration()).toBe(before + 1);
  });

  it('does not bump when Docker reports the container already connected', async () => {
    const before = currentNetworkGeneration();
    responses.push({ statusCode: 403, body: 'already exists in network dc-net-alpha' });
    await expect(connectNetwork('dc-net-alpha', 'huddle')).rejects.toThrow('already exists in network');
    expect(currentNetworkGeneration()).toBe(before);
  });
});
