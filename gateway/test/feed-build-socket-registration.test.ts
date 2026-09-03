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
let buildContainerFeed: typeof import('../src/control/feed-build').buildContainerFeed;

beforeAll(async () => {
  const dbMod = await import('../src/db');
  db = dbMod.db;
  registerSocketName = dbMod.registerSocketName;
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
});
