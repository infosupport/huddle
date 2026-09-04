import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// blocker 15: a container `huddle migrate --docker-socket` registered has to
// show up in the container feed's `devcontainers` even though it is not
// running (or does not exist yet) and carries none of the IDE labels
// containerSnapshot() filters on — see socket_registrations' comment in
// db.ts and ContainerFeed.devcontainers' doc in control/feed.ts.

let byIp = new Map<string, string>();
let running: string[] = [];

vi.mock('../src/docker', () => ({
  containerSnapshot: async () => ({ byIp, devcontainers: running }),
  currentNetworkGeneration: () => 0,
}));

let db: typeof import('../src/db').db;
let registerSocketName: typeof import('../src/db').registerSocketName;
let listRegisteredSocketNames: typeof import('../src/db').listRegisteredSocketNames;
let buildContainerFeed: typeof import('../src/control/feed-build').buildContainerFeed;

beforeAll(async () => {
  const dbMod = await import('../src/db');
  db = dbMod.db;
  registerSocketName = dbMod.registerSocketName;
  listRegisteredSocketNames = dbMod.listRegisteredSocketNames;
  dbMod.initDb();
  ({ buildContainerFeed } = await import('../src/control/feed-build'));
});

beforeEach(() => {
  byIp = new Map();
  running = [];
  db.exec('DELETE FROM socket_registrations');
  db.exec('DELETE FROM sandbox_identity');
});

describe('buildContainerFeed — socket registrations', () => {
  it('includes a registered name Docker has never reported as running', async () => {
    registerSocketName('compose-api');
    const feed = await buildContainerFeed();
    expect(feed.devcontainers).toContain('compose-api');
  });

  it('does not duplicate a name that is both running and registered', async () => {
    running = ['dc-alpha'];
    registerSocketName('dc-alpha');
    const feed = await buildContainerFeed();
    expect(feed.devcontainers?.filter((n) => n === 'dc-alpha')).toHaveLength(1);
  });

  it('changes the feed version when a registration is added, even with byIp/devcontainers unchanged', async () => {
    const before = await buildContainerFeed();
    registerSocketName('compose-api');
    const after = await buildContainerFeed();
    expect(after.version).not.toBe(before.version);
  });

  it('also changes the feed version when an existing name is re-registered', async () => {
    registerSocketName('compose-api');
    const before = await buildContainerFeed();
    registerSocketName('compose-api');
    const after = await buildContainerFeed();
    expect(after.version).not.toBe(before.version);
  });

  // Part B of the fix: a registration that was actually served (ready_at set)
  // and then drops off Docker's running list is a container that is gone —
  // removed outside Huddle's control, since there is no devcontainer delete
  // route to have unregistered it. That row must not linger forever.
  it('prunes a ready registration whose container is no longer running', async () => {
    registerSocketName('dc-gone');
    db.prepare(`UPDATE socket_registrations SET ready_at = unixepoch() WHERE name = 'dc-gone'`).run();
    running = []; // Docker no longer reports it
    const feed = await buildContainerFeed();
    expect(feed.devcontainers).not.toContain('dc-gone');
    expect(db.prepare('SELECT name FROM socket_registrations').all()).toEqual([]);
  });

  // The `huddle migrate --docker-socket` (and createAndStartContainer) use
  // case: a name is registered ahead of its container ever running, and is
  // not yet acknowledged ready. That is expected, not stale — pruning it
  // just because it isn't in `running` yet would break the handshake.
  it('does not prune a not-yet-ready registration even though its container is not running', async () => {
    registerSocketName('dc-not-ready-yet');
    running = [];
    const feed = await buildContainerFeed();
    expect(feed.devcontainers).toContain('dc-not-ready-yet');
    expect(listRegisteredSocketNames()).toEqual(['dc-not-ready-yet']);
  });

  it('keeps a ready registration whose container is still running', async () => {
    registerSocketName('dc-alpha');
    db.prepare(`UPDATE socket_registrations SET ready_at = unixepoch() WHERE name = 'dc-alpha'`).run();
    running = ['dc-alpha'];
    const feed = await buildContainerFeed();
    expect(feed.devcontainers).toContain('dc-alpha');
    expect(listRegisteredSocketNames()).toEqual(['dc-alpha']);
  });
});
