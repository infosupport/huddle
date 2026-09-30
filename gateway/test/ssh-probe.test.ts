import { describe, it, expect, afterEach } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { probeSshBanner, probeSshBannerWithRetry } from '../src/ssh-probe';

// ── Host-side SSH banner probe ────────────────────────────────────────────────
// This is the check that would have caught the whole sbx SSH bug in one step:
// a plain TCP connect() succeeds whether or not anything real is behind it, and
// the reported symptom (kex_exchange_identification: read: Connection aborted)
// is exactly "accept, then abort" — a port that forwards but nothing answers on
// :22 inside the sandbox. Only reading the banner tells the two apart.

let servers: net.Server[] = [];

function listenOn(handler: (socket: net.Socket) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer(handler);
    servers.push(srv);
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
  });
}

afterEach(async () => {
  await Promise.all(servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))));
  servers = [];
});

describe('probeSshBanner', () => {
  it('reports ok with the banner when the server sends a real SSH line', async () => {
    const port = await listenOn((socket) => {
      socket.write('SSH-2.0-OpenSSH_9.2p1\r\n');
    });
    const r = await probeSshBanner(port);
    expect(r.ok).toBe(true);
    expect(r.banner).toBe('SSH-2.0-OpenSSH_9.2p1');
    expect(r.error).toBe('');
  });

  it('reports NOT ok, with an explanatory error, when the connection is accepted then immediately closed', async () => {
    // This is a regression test for the exact reported symptom: a userspace
    // forwarder that accepts on the host and resets when the guest dial fails.
    const port = await listenOn((socket) => {
      socket.destroy();
    });
    const r = await probeSshBanner(port);
    expect(r.ok).toBe(false);
    expect(r.banner).toBe('');
    expect(r.error).toMatch(/closed before any SSH banner/);
  });

  it('reports NOT ok when the peer answers with something that is not an SSH banner', async () => {
    const port = await listenOn((socket) => {
      socket.write('HTTP/1.1 200 OK\r\n');
    });
    const r = await probeSshBanner(port);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/expected an SSH banner/);
  });

  it('reports NOT ok with a connection error when nothing is listening', async () => {
    // A closed port on loopback: connection refused, not a timeout.
    const port = await listenOn(() => {});
    await new Promise<void>((resolve) => servers[servers.length - 1].close(() => resolve()));
    servers = [];
    const r = await probeSshBanner(port);
    expect(r.ok).toBe(false);
    expect(r.banner).toBe('');
    expect(r.error.length).toBeGreaterThan(0);
  });

  it('reports NOT ok on timeout when the peer accepts and stays silent', async () => {
    const port = await listenOn(() => {
      // accept and say nothing
    });
    const r = await probeSshBanner(port, 200);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no SSH banner within/);
  }, 2000);
});

describe('probeSshBannerWithRetry', () => {
  it('returns success immediately once the banner arrives, without exhausting retries', async () => {
    const port = await listenOn((socket) => {
      socket.write('SSH-2.0-OpenSSH_9.2p1\r\n');
    });
    const r = await probeSshBannerWithRetry(port, 3, 10);
    expect(r.ok).toBe(true);
  });

  it('gives up and returns the last failure after the configured number of attempts', async () => {
    const port = await listenOn((socket) => socket.destroy());
    const start = Date.now();
    const r = await probeSshBannerWithRetry(port, 2, 20);
    expect(r.ok).toBe(false);
    // Two attempts with a short delay between them — not an immediate single try.
    expect(Date.now() - start).toBeGreaterThanOrEqual(15);
  });
});
