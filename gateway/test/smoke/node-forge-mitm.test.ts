import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import type http from 'http';
import type { AddressInfo } from 'net';

// Dependency smoke test: node-forge generates the root CA and the per-host leaf
// certificates the MITM proxy presents. A node-forge or TLS regression shows up as a
// handshake that cannot complete, or a leaf that no longer chains to the CA. This runs
// the real proxy: CONNECT <host>:443 -> 200 -> TLS handshake against the generated CA.
// No upstream is needed; the handshake itself is what is under test.

const HOST = 'smoke.example.test';
let proxy: http.Server;
let proxyPort = 0;
let caPem = '';
let caDir = '';

beforeAll(async () => {
  // tls-ca.ts reads CA_DIR at import time, so it must be set before the import.
  caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-smoke-ca-'));
  process.env.CA_DIR = caDir;

  const { db, initDb } = await import('../../src/db');
  initDb();
  db.prepare(`INSERT INTO rules (domain, container_id, status) VALUES (?, NULL, 'allow')`).run(HOST);

  const { initCa, getCaCertPem } = await import('../../src/tls-ca');
  initCa();
  caPem = getCaCertPem();

  const { createProxyServer } = await import('../../src/proxy');
  proxy = createProxyServer(0);
  await new Promise<void>(resolve => {
    if (proxy.listening) return resolve();
    proxy.once('listening', () => resolve());
  });
  proxyPort = (proxy.address() as AddressInfo).port;
}, 60_000);

afterAll(async () => {
  await new Promise<void>(resolve => (proxy ? proxy.close(() => resolve()) : resolve()));
  fs.rmSync(caDir, { recursive: true, force: true });
  delete process.env.CA_DIR;
});

// Open a CONNECT tunnel through the proxy and return the raw socket after the 200.
function connectTunnel(host: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`);
    });
    let buf = '';
    const onData = (chunk: Buffer) => {
      buf += chunk.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.off('data', onData);
      if (/^HTTP\/1\.1 200/.test(buf)) resolve(sock);
      else reject(new Error(`CONNECT refused: ${buf.split('\r\n')[0]}`));
    };
    sock.on('data', onData);
    sock.once('error', reject);
  });
}

describe('smoke: node-forge leaf certificate + TLS handshake through the MITM proxy', () => {
  it('completes a TLS handshake and presents a leaf issued by the Huddle CA', async () => {
    const tunnel = await connectTunnel(HOST);
    const secure = tls.connect({ socket: tunnel, servername: HOST, ca: caPem });
    await new Promise<void>((resolve, reject) => {
      secure.once('secureConnect', () => resolve());
      secure.once('error', reject);
    });
    try {
      expect(secure.authorized).toBe(true); // chain + hostname validated against our CA
      const cert = secure.getPeerCertificate();
      expect(cert.subjectaltname).toContain(`DNS:${HOST}`);
      expect(cert.issuer.CN).toBe('Huddle DMZ Proxy Root CA');
    } finally {
      secure.destroy();
    }
  });

  it('is NOT trusted without the Huddle CA (the leaf really is MITM-signed)', async () => {
    const tunnel = await connectTunnel(HOST);
    const secure = tls.connect({ socket: tunnel, servername: HOST });
    const err = await new Promise<Error>((resolve, reject) => {
      secure.once('secureConnect', () => reject(new Error('handshake unexpectedly trusted')));
      secure.once('error', resolve);
    });
    expect((err as NodeJS.ErrnoException).code).toMatch(
      /SELF_SIGNED|UNABLE_TO_GET_ISSUER|UNABLE_TO_VERIFY/,
    );
    secure.destroy();
  });
});
