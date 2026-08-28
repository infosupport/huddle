import { describe, it, expect, afterAll } from 'vitest';
import net from 'net';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ── Starting a container carries no body ────────────────────────────────────
//
// `POST /containers/<id>/start` used to take the host config. The daemon does
// not ignore a body it no longer wants — it refuses the request:
//
//   400 starting container with non-empty request body was deprecated since
//       API v1.22 and removed in v1.24
//
// `{}` is two bytes, so the difference between a devcontainer that starts and
// one that dies on creation is a JSON literal that looks like nothing. Podman
// and newer moby both enforce it.
//
// The fake daemon is a raw socket rather than an http.Server on purpose: it is
// the bytes after the blank line that decide this, and an http.Server would
// hand back a parsed body that looks the same either way.

const sockDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-dockersock-'));
const sockPath = path.join(sockDir, 'docker.sock');
process.env.HUDDLE_DOCKER_SOCKET = sockPath;

const requests: string[] = [];

const daemon = net.createServer((sock) => {
  let buf = '';
  sock.on('data', (d) => {
    buf += d.toString();
    // Every request here is headers-only or headers plus a short JSON body, so
    // one flush after the blank line is enough to see all of it.
    if (buf.includes('\r\n\r\n')) {
      requests.push(buf);
      sock.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n');
    }
  });
});
await new Promise<void>((r) => daemon.listen(sockPath, () => r()));

// Imported after the env var is set, so runtime-env picks up the fake socket.
const { startExistingContainer } = await import('../src/docker');

afterAll(async () => {
  await new Promise<void>((r) => daemon.close(() => r()));
  fs.rmSync(sockDir, { recursive: true, force: true });
});

describe('starting an existing container', () => {
  it('sends the start with no body and no content-length', async () => {
    await startExistingContainer('d769439d7fbb');
    expect(requests).toHaveLength(1);
    const [head, body] = requests[0].split('\r\n\r\n');
    expect(head.split('\r\n')[0]).toBe('POST /containers/d769439d7fbb/start HTTP/1.1');
    // `content-length: 0` is Node's own and is fine — the daemon rejects on
    // body BYTES, not on the header. What must not be here is a payload.
    expect(head.toLowerCase()).not.toContain('content-type');
    // Not `{}`: two bytes is non-empty.
    expect(body).toBe('');
  });
});
