import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import net from 'net';
import path from 'path';

// ── Docker-socket-proxy: socket-layout ───────────────────────────────────────
// De proxy-socket leeft in een per-container subdirectory (<dir>/<naam>/docker.sock)
// die als DIRECTORY in de devcontainer gemount wordt. Een file-mount van de socket
// zelf pint de inode: na een huddle-herstart (unlink + nieuwe listen) kijkt zo'n
// mount voorgoed naar de dode oude socket. Deze tests dekken de layout en het
// herstart-scenario; de policy-logica zelf zit achter een live Docker-socket en
// valt buiten deze unit-tests.

// socket-proxy importeert db.ts alleen voor de grant-checks; mocken houdt de
// native better-sqlite3-binding buiten deze test (die ontbreekt in een verse
// DMZ-devcontainer, zie rules.test.ts / grants.test.ts).
vi.mock('../src/db', () => ({
  getGrant: () => null,
  getActionPolicy: () => null,
  isHostPortApproved: () => false,
}));

function connect(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath, () => { c.end(); resolve(); });
    c.on('error', reject);
  });
}

// ── withLabelFilter: filter-formaat ──────────────────────────────────────────
// De Docker-client stuurt `filters` in het legacy map-formaat
// (`{"label":{"foo=bar":true},"status":{"running":true}}`). Als we alleen `label`
// naar een array omzetten en de andere sleutels als map laten staan, ontstaat een
// gemengde vorm die de daemon met "invalid filter" afwijst en o.a.
// `docker compose up` breekt. Deze tests borgen dat élke sleutel naar het
// (universeel geaccepteerde) array-formaat genormaliseerd wordt.
describe('withLabelFilter', () => {
  let withLabelFilter: typeof import('../src/socket-proxy').withLabelFilter;

  beforeAll(async () => {
    withLabelFilter = (await import('../src/socket-proxy')).withLabelFilter;
  });

  function filtersOf(url: string): Record<string, unknown> {
    const qs = new URLSearchParams(url.split('?')[1]);
    return JSON.parse(qs.get('filters') ?? '{}');
  }

  it('normaliseert legacy map-filters (compose) naar array-formaat', () => {
    const raw = '/v1.55/containers/json?all=1&filters=' +
      encodeURIComponent('{"label":{"com.docker.compose.project=x":true},"status":{"running":true}}');
    const out = filtersOf(withLabelFilter(raw, 'huddle.parent=dc-a'));
    expect(out).toEqual({
      label: ['com.docker.compose.project=x', 'huddle.parent=dc-a'],
      status: ['running'],
    });
    // Geen enkele sleutel mag als map achterblijven (dat = "invalid filter").
    for (const v of Object.values(out)) expect(Array.isArray(v)).toBe(true);
  });

  it('behoudt bestaande array-filters en voegt het label toe', () => {
    const raw = '/v1.55/containers/json?filters=' +
      encodeURIComponent('{"label":["a=b"]}');
    expect(filtersOf(withLabelFilter(raw, 'huddle.parent=dc-a'))).toEqual({
      label: ['a=b', 'huddle.parent=dc-a'],
    });
  });

  it('werkt zonder bestaande filters', () => {
    expect(filtersOf(withLabelFilter('/v1.55/containers/json', 'huddle.parent=dc-a')))
      .toEqual({ label: ['huddle.parent=dc-a'] });
  });
});

// Deze tests binden een echte AF_UNIX-socket (server.listen op een pad). Dat is
// een Linux-primitief; de gateway draait in productie in een Linux-container.
// Op native Windows faalt de bind met EACCES, dus we slaan het blok daar over
// (draai de suite in WSL/Linux voor dekking).
describe.skipIf(process.platform === 'win32')('createContainerProxy socket-layout', () => {
  let createContainerProxy: typeof import('../src/socket-proxy').createContainerProxy;
  let dir: string;
  const servers: net.Server[] = [];

  beforeAll(async () => {
    const mod = await import('../src/socket-proxy');
    createContainerProxy = mod.createContainerProxy;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sock-'));
  });

  afterAll(() => {
    for (const s of servers) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('luistert op <dir>/<naam>/docker.sock in een per-container subdirectory', async () => {
    servers.push(await createContainerProxy('dc-a', dir));
    const sockPath = path.join(dir, 'dc-a', 'docker.sock');
    expect(fs.statSync(sockPath).isSocket()).toBe(true);
    await connect(sockPath);
  });

  it('legt een compat-symlink op het oude platte pad <naam>.sock', async () => {
    servers.push(await createContainerProxy('dc-b', dir));
    const legacy = path.join(dir, 'dc-b.sock');
    expect(fs.lstatSync(legacy).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(legacy)).toBe(path.join(dir, 'dc-b', 'docker.sock'));
    // Verbinden via de symlink moet ook werken (containers van vóór de
    // directory-mount bereiken de socket zo na hun eigen herstart).
    await connect(legacy);
  });

  it('een herstart (tweede create) serveert opnieuw op hetzelfde pad', async () => {
    servers.push(await createContainerProxy('dc-c', dir));
    const sockPath = path.join(dir, 'dc-c', 'docker.sock');
    await connect(sockPath);

    // Simuleer een huddle-herstart: unlink + nieuwe socket op hetzelfde pad.
    // (Een file-mount zou hier breken — die blijft de ge-unlinkte socket zien;
    // via de directory-mount en de symlink blijft het pad gewoon werken.)
    servers.push(await createContainerProxy('dc-c', dir));

    expect(fs.statSync(sockPath).isSocket()).toBe(true);
    await connect(sockPath);
    await connect(path.join(dir, 'dc-c.sock'));
  });
});

// De naam-guard staat los van het binden van een socket, dus deze test draait
// ook op native Windows (geen AF_UNIX-bind nodig — zie het blok hierboven).
describe('createContainerProxy naam-validatie', () => {
  let createContainerProxy: typeof import('../src/socket-proxy').createContainerProxy;
  let dir: string;

  beforeAll(async () => {
    createContainerProxy = (await import('../src/socket-proxy')).createContainerProxy;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dc-sock-'));
  });

  afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // containerName vloeit via path.join() in de socket-paden. De naam komt uit
  // huddle's eigen orchestratie, maar we dwingen de Docker-naamgrammatica
  // expliciet af zodat `..`/`/`/leidende punt onmogelijk buiten socketDir kunnen
  // schrijven of lezen (path-traversal). Deze test borgt die guard.
  it('weigert onveilige containernamen (path-traversal)', async () => {
    for (const bad of ['../evil', 'a/b', '..', '.hidden', '/abs', 'foo/../bar']) {
      await expect(createContainerProxy(bad, dir)).rejects.toThrow(/unsafe container name/);
    }
    // Er mag niets buiten socketDir zijn aangemaakt.
    expect(fs.existsSync(path.join(dir, '..', 'evil'))).toBe(false);
  });
});
