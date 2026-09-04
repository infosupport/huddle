import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// createAndStartContainer touches db.ts (registerSocketName/unregisterSocketName)
// and, via socket-proxy.ts, more of db.ts's read-only surface — mocked out the
// same way docker-network-generation.test.ts does, plus spies on the two
// registration calls this test asserts on.
const dbCalls = { registered: [] as string[], unregistered: [] as string[] };
vi.mock('../src/db', () => ({
  isHostPortApproved: () => false,
  getActionPolicy: () => null,
  getGrant: () => null,
  registerSocketName: (name: string) => { dbCalls.registered.push(name); },
  unregisterSocketName: (name: string) => { dbCalls.unregistered.push(name); },
}));

vi.mock('../src/events', () => ({ notifyStateChanged: () => {} }));

// Controls whether the gateway "acknowledges" the socket registration —
// the fallible step this test drives the rollback through, since it sits
// right after registerSocketName and before any further Docker calls.
let socketReady = true;
vi.mock('../src/socket-registration', () => ({
  waitForSocketReadiness: async () => socketReady,
}));

// Fakes the Docker socket for every dockerRequest/dockerGet call
// createAndStartContainer makes before it reaches waitForSocketReadiness:
// the "does it already exist" inspect (404 = does not exist), network
// exists/create/connect, and image-exists.
vi.mock('http', () => ({
  default: {
    request: (opts: { method: string; path: string }, cb: (res: EventEmitter & { statusCode: number }) => void) => {
      const { method, path } = opts;
      let statusCode = 200;
      let body = '{}';
      if (method === 'GET' && /^\/containers\/.+\/json$/.test(path)) { statusCode = 404; body = 'no such container'; }
      else if (method === 'GET' && /^\/networks\//.test(path)) { statusCode = 404; body = 'network not found'; }
      else if (method === 'GET' && /^\/images\/.+\/json$/.test(path)) { statusCode = 200; body = '{}'; }

      const res = Object.assign(new EventEmitter(), { statusCode });
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void };
      req.write = () => {};
      req.end = () => {
        queueMicrotask(() => {
          cb(res);
          res.emit('data', body);
          res.emit('end');
        });
      };
      return req;
    },
  },
}));

const { createAndStartContainer } = await import('../src/docker');

describe('createAndStartContainer — rollback on failure (Aikido: phantom socket registrations)', () => {
  beforeEach(() => {
    dbCalls.registered.length = 0;
    dbCalls.unregistered.length = 0;
    socketReady = true;
  });

  it('unregisters the socket name when the gateway never acknowledges it', async () => {
    socketReady = false;
    await expect(createAndStartContainer({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '/home/user/project',
      containerName: 'dc-rollback-test',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
    })).rejects.toThrow(/did not confirm the Docker socket/);

    expect(dbCalls.registered).toEqual(['dc-rollback-test']);
    // The row registerSocketName just added must be undone — a failed create
    // attempt must not leave a permanent phantom socket_registrations row
    // (the Aikido finding this test guards against).
    expect(dbCalls.unregistered).toEqual(['dc-rollback-test']);
  });

  it('does not unregister when the readiness handshake succeeds and the container starts', async () => {
    // With socketReady=true, createAndStartContainer proceeds past the
    // handshake into mount/worktree building, which this test does not stub
    // — it only needs to see that no rollback happened before that point, so
    // asserting the promise settles (either way) without an unregister call
    // is enough to show the try/catch does not fire on the success path.
    await createAndStartContainer({
      imageName: 'ghcr.io/infosupport/base-devimage-vscode',
      workspaceDir: '/home/user/project',
      containerName: 'dc-rollback-ok',
      containerWorkspace: '/workspaces/project',
      presentableName: 'project',
      ideName: 'vscode',
      empty: true,
    }).catch(() => {});

    expect(dbCalls.registered).toEqual(['dc-rollback-ok']);
    expect(dbCalls.unregistered).toEqual([]);
  });
});
