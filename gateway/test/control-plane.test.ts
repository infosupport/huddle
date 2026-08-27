import { describe, it, expect, beforeAll, afterEach } from 'vitest';

// The control-plane facade is the proxy's single seam to policy, container
// identity and audit (docs/ADR-huddle-node-split.md, step 4). It pulls in db.ts,
// so it needs a usable SQLite build for the same reason the other DB tests do.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[control-plane.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let plane: typeof import('../src/control/plane');

beforeAll(async () => {
  if (!sqliteAvailable) return;
  plane = await import('../src/control/plane');
});

function recordingPlane(calls: string[]): import('../src/control/plane').ControlPlane {
  return {
    checkRule: (d, c, p) => { calls.push(`checkRule:${d}:${c}:${p}`); return { status: 'allow', ruleId: 1 }; },
    checkFleetRule: (d, n, p) => { calls.push(`checkFleetRule:${d}:${[...n].join(',')}:${p}`); return { status: 'deny', ruleId: 2 }; },
    isPathMode: (d, c) => { calls.push(`isPathMode:${d}:${c}`); return true; },
    knownSandboxNames: () => { calls.push('knownSandboxNames'); return new Set(['box']); },
    resolveContainerByIp: async (ip) => { calls.push(`resolveContainerByIp:${ip}`); return 'dc-1'; },
    logAudit: () => { calls.push('logAudit'); return 42; },
    updateAuditResponse: (id) => { calls.push(`updateAuditResponse:${id}`); },
  };
}

describe.skipIf(!sqliteAvailable)('control-plane facade', () => {
  afterEach(() => { plane.resetControlPlane(); });

  it('delegates every member to the active binding', async () => {
    const calls: string[] = [];
    plane.setControlPlane(recordingPlane(calls));

    expect(plane.controlPlane.checkRule('example.com', 'dc-1', '/a')).toEqual({ status: 'allow', ruleId: 1 });
    expect(plane.controlPlane.checkFleetRule('example.com', new Set(['box']), null)).toEqual({ status: 'deny', ruleId: 2 });
    expect(plane.controlPlane.isPathMode('example.com', null)).toBe(true);
    expect(plane.controlPlane.knownSandboxNames()).toEqual(new Set(['box']));
    await expect(plane.controlPlane.resolveContainerByIp('10.0.0.2')).resolves.toBe('dc-1');
    expect(plane.controlPlane.logAudit({ containerId: null, domain: 'example.com', action: 'allow' })).toBe(42);
    plane.controlPlane.updateAuditResponse(42, { resStatus: 200 });

    expect(calls).toEqual([
      'checkRule:example.com:dc-1:/a',
      'checkFleetRule:example.com:box:null',
      'isPathMode:example.com:null',
      'knownSandboxNames',
      'resolveContainerByIp:10.0.0.2',
      'logAudit',
      'updateAuditResponse:42',
    ]);
  });

  // proxy.ts destructures the facade once at module load. That is only safe
  // because the destructured values are the wrappers, which look up the active
  // binding per call — if this breaks, the proxy silently keeps the binding it
  // captured at import time and every later swap is ignored.
  it('honours a swap made after the members were destructured', () => {
    const { checkRule } = plane.controlPlane;
    const calls: string[] = [];
    plane.setControlPlane(recordingPlane(calls));

    expect(checkRule('late.example.com', null, null)).toEqual({ status: 'allow', ruleId: 1 });
    expect(calls).toEqual(['checkRule:late.example.com:null:null']);
  });

  it('restores the in-process binding on reset', () => {
    plane.setControlPlane(recordingPlane([]));
    plane.resetControlPlane();
    // The real binding evaluates against the (empty, in-memory) rule set, which
    // files an unknown host as requested rather than returning the stub's allow.
    expect(plane.controlPlane.checkRule('unseen.example.com', null, null).status).toBe('requested');
  });

  it('defaults to the in-process binding', () => {
    expect(plane.inProcessControlPlane).toBeDefined();
    expect(Object.keys(plane.inProcessControlPlane).sort()).toEqual(
      Object.keys(plane.controlPlane).sort(),
    );
  });
});
