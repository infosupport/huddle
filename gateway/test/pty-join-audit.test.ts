import { describe, it, expect, vi, beforeEach } from 'vitest';

// PTY-join audit (finding #13): meerdere clients delen één shell per container.
// Een tweede client die aanhaakt op een bestaande sessie MOET als 'attach:join'
// in de audit-log verschijnen — in het gedeelde-token-model kunnen we een join
// niet verbieden, maar een stille overname mag niet kunnen. We mocken de
// docker-exec-laag (geen echte container nodig) en vangen logAudit af.

const auditCalls: Array<{ containerId?: string | null; domain?: string; action?: string }> = [];
vi.mock('../src/db', () => ({
  logAudit: (e: { containerId?: string | null; domain?: string; action?: string }) => { auditCalls.push(e); },
}));

// Minimale ReadWriteStream-stub: pty-manager registreert alleen handlers en
// schrijft; niets hoeft te vuren voor de attach-audit.
const fakeStream = { on: () => fakeStream, write: () => true, end: () => {} };
vi.mock('../src/terminal', () => ({
  dockerExec: async () => 'exec-1',
  dockerExecStart: async () => fakeStream,
  dockerExecResize: async () => {},
}));

vi.mock('../src/docker', () => ({
  listDevcontainers: async () => [{ name: 'devcontainer-x' }],
}));

const { ptyManager } = await import('../src/pty-manager');

// WebSocket-stub: attach() registreert message/close/error-handlers en leest
// readyState; verder is niets nodig.
function fakeWs(): any {
  return { readyState: 1, on: () => {}, send: () => {}, close: () => {} };
}

describe('pty-manager join-audit (finding #13)', () => {
  beforeEach(() => { auditCalls.length = 0; });

  it('logt de eerste client als attach:owner en de tweede als attach:join', async () => {
    await ptyManager.attach(fakeWs(), 'devcontainer-x');
    await ptyManager.attach(fakeWs(), 'devcontainer-x');

    const attachActions = auditCalls
      .filter(e => e.domain === 'terminal' && String(e.action).startsWith('attach'))
      .map(e => e.action);

    expect(attachActions[0]).toBe('attach:owner');
    expect(attachActions[1]).toBe('attach:join(2 clients)');
  });
});
