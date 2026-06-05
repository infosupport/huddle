import http from 'http';
import { WebSocket } from 'ws';
import { listDevcontainers } from './docker';
import { logAudit } from './db';

// In-container exec sessie voor de embedded terminal in het portaal.
// Flow:
//   1. Browser opent WS naar /ws/exec/<container-name>
//   2. We valideren de naam tegen listDevcontainers (whitelist).
//   3. POST /containers/<name>/exec  (Tty=true, bash als vscode)
//   4. POST /exec/<id>/start         (Detach=false, Tty=true) -> hijacked
//      Upgrade-stream met rauwe pty-bytes (geen 8-byte multiplex-header).
//   5. WS <-> stream: binary frames recht doorpipen.
//   6. Resize: JSON control-frame {"type":"resize","cols":N,"rows":M}
//      -> POST /exec/<id>/resize?h=M&w=N

interface ExecHandle {
  execId: string;
  stream: NodeJS.ReadWriteStream;
}

export function dockerExec(containerName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      Tty: true,
      Cmd: ['/bin/bash', '-l'],
      User: 'vscode',
      Env: ['TERM=xterm-256color'],
    });
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/containers/${encodeURIComponent(containerName)}/exec`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
      },
      (res) => {
        let raw = '';
        res.on('data', (c: string) => (raw += c));
        res.on('end', () => {
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`exec create ${res.statusCode}: ${raw}`));
            return;
          }
          try { resolve(JSON.parse(raw).Id as string); }
          catch (e: any) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function dockerExecStart(execId: string): Promise<NodeJS.ReadWriteStream> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ Detach: false, Tty: true });
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/exec/${encodeURIComponent(execId)}/start`,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          // Vraag een upgrade aan zodat Docker de TCP-stream hijack't en
          // we rauwe bidirectional bytes krijgen.
          'connection': 'Upgrade',
          'upgrade': 'tcp',
        },
      },
    );
    // Docker reageert hier met '101 UPGRADED' en hijack't de socket.
    req.on('upgrade', (_res, socket) => resolve(socket as NodeJS.ReadWriteStream));
    // Voor het geval Docker zonder upgrade reageert (zou niet moeten met TTY).
    req.on('response', (res) => {
      if (res.statusCode && res.statusCode >= 400) {
        let raw = '';
        res.on('data', (c: string) => (raw += c));
        res.on('end', () => reject(new Error(`exec start ${res.statusCode}: ${raw}`)));
      }
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

export function dockerExecResize(execId: string, cols: number, rows: number): Promise<void> {
  return new Promise((resolve) => {
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/exec/${encodeURIComponent(execId)}/resize?h=${rows}&w=${cols}`,
      },
      (res) => { res.resume(); res.on('end', () => resolve()); },
    );
    req.on('error', () => resolve()); // niet-fatale fout, terminal blijft werken
    req.end();
  });
}

export async function openExec(containerName: string): Promise<ExecHandle> {
  const execId = await dockerExec(containerName);
  const stream = await dockerExecStart(execId);
  return { execId, stream };
}

export async function attachTerminal(ws: WebSocket, containerName: string): Promise<void> {
  // Whitelist: alleen actieve devcontainers met het JB-label.
  const containers = await listDevcontainers();
  const known = containers.find((c) => c.name === containerName);
  if (!known) {
    ws.close(1008, 'unknown container');
    return;
  }

  let handle: ExecHandle;
  try {
    handle = await openExec(containerName);
  } catch (err: any) {
    console.warn(`[terminal] exec failed for ${containerName}:`, err.message);
    ws.close(1011, 'exec failed');
    return;
  }

  logAudit({ containerId: containerName, domain: 'terminal', action: 'open' });

  let closed = false;
  const closeAll = (reason: string) => {
    if (closed) return;
    closed = true;
    try { handle.stream.end(); } catch {}
    try { ws.close(1000, reason); } catch {}
    logAudit({ containerId: containerName, domain: 'terminal', action: `close:${reason}` });
  };

  handle.stream.on('data', (chunk: Buffer) => {
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(chunk, { binary: true }); } catch {}
  });
  handle.stream.on('end', () => closeAll('stream-end'));
  handle.stream.on('error', () => closeAll('stream-error'));

  ws.on('message', (data, isBinary) => {
    // Tekstframes interpreteren we als JSON-controls (resize, signaal-keys
    // doen we via gewone keystrokes). Binary = keyboard-input naar de pty.
    if (isBinary || Buffer.isBuffer(data) && data.length > 0 && data[0] !== 0x7b /* '{' */) {
      try { handle.stream.write(data as Buffer); } catch {}
      return;
    }
    try {
      const text = data.toString();
      const msg = JSON.parse(text);
      if (msg?.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
        dockerExecResize(handle.execId, Math.max(1, msg.cols | 0), Math.max(1, msg.rows | 0));
      }
    } catch {
      // Geen JSON: behandel als rauwe input.
      try { handle.stream.write(data as Buffer); } catch {}
    }
  });

  ws.on('close', () => closeAll('ws-close'));
  ws.on('error', () => closeAll('ws-error'));
}
