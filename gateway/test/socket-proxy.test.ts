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
  isHostPortApproved: () => false,
}));

function connect(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath, () => { c.end(); resolve(); });
    c.on('error', reject);
  });
}

describe('createContainerProxy socket-layout', () => {
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
