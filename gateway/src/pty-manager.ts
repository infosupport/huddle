import type { WebSocket } from 'ws';
import { dockerExec, dockerExecStart, dockerExecResize } from './terminal';
import { listDevcontainers } from './docker';
import { logAudit } from './db';

// Multi-attach PTY-manager: meerdere WebSocket-clients delen één Docker exec
// per container (vergelijkbaar met een gedeelde tmux-sessie). De eerste client
// opent de exec; volgende clients haken aan op dezelfde stream. Sluit de laatste
// client, dan wordt de exec-stream afgebroken.

interface PtySession {
  execId: string;
  stream: NodeJS.ReadWriteStream;
  clients: Set<WebSocket>;
  cols: number;
  rows: number;
}

const WS_OPEN = 1;

class PtyManager {
  private sessions = new Map<string, PtySession>();
  private creating = new Map<string, Promise<PtySession>>();

  async attach(ws: WebSocket, containerName: string): Promise<void> {
    const containers = await listDevcontainers();
    if (!containers.find((c) => c.name === containerName)) {
      ws.close(1008, 'unknown container');
      return;
    }

    let session = this.sessions.get(containerName);
    if (!session) {
      const pending = this.creating.get(containerName);
      if (pending) {
        session = await pending;
      } else {
        const p = this._create(containerName);
        this.creating.set(containerName, p);
        try {
          session = await p;
        } finally {
          this.creating.delete(containerName);
        }
      }
    }

    const active = session;
    // Finding #13: een tweede client die op een bestaande sessie aanhaakt deelt
    // dezelfde shell (leest alle I/O, kan toetsaanslagen injecteren). We kunnen
    // in het single-operator-token-model geen per-operator identiteit afdwingen,
    // maar we maken de join expliciet zichtbaar: log 'attach:join' met het aantal
    // clients zodat een stille overname niet meer mogelijk is (operators zien 'm
    // in de audit-log). De eerste client is de eigenaar ('attach:owner').
    const isJoin = active.clients.size > 0;
    active.clients.add(ws);
    logAudit({
      containerId: containerName,
      domain: 'terminal',
      action: isJoin ? `attach:join(${active.clients.size} clients)` : 'attach:owner',
    });

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        try { active.stream.write(data as Buffer); } catch {}
        return;
      }
      const text = data.toString();
      try {
        const msg = JSON.parse(text);
        if (msg?.type === 'resize' && typeof msg.cols === 'number' && typeof msg.rows === 'number') {
          active.cols = Math.max(1, msg.cols | 0);
          active.rows = Math.max(1, msg.rows | 0);
          dockerExecResize(active.execId, active.cols, active.rows).catch(() => {});
          return;
        }
      } catch {
        // geen JSON-control: behandel als rauwe pty-input
      }
      try { active.stream.write(data as Buffer); } catch {}
    });

    ws.on('close', () => this._detach(containerName, ws));
    ws.on('error', () => this._detach(containerName, ws));
  }

  private async _create(containerName: string): Promise<PtySession> {
    const execId = await dockerExec(containerName);
    const stream = await dockerExecStart(execId);
    const session: PtySession = { execId, stream, clients: new Set(), cols: 80, rows: 24 };
    this.sessions.set(containerName, session);
    logAudit({ containerId: containerName, domain: 'terminal', action: 'open' });

    stream.on('data', (chunk: Buffer) => {
      for (const client of session.clients) {
        if (client.readyState === WS_OPEN) {
          try { client.send(chunk, { binary: true }); } catch {}
        }
      }
    });
    const tearDown = () => {
      if (this.sessions.get(containerName) === session) {
        this.sessions.delete(containerName);
      }
      for (const client of session.clients) {
        try { client.close(1000, 'pty-closed'); } catch {}
      }
      session.clients.clear();
    };
    stream.on('end', tearDown);
    stream.on('close', tearDown);
    stream.on('error', tearDown);
    return session;
  }

  private _detach(containerName: string, ws: WebSocket): void {
    const session = this.sessions.get(containerName);
    if (!session) return;
    session.clients.delete(ws);
    if (session.clients.size === 0) {
      this.sessions.delete(containerName);
      try { session.stream.end(); } catch {}
      logAudit({ containerId: containerName, domain: 'terminal', action: 'close:empty' });
    }
  }
}

export const ptyManager = new PtyManager();
