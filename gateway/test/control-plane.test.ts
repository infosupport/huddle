import { describe, it, expect, afterEach } from 'vitest';
import * as plane from '../src/control/plane';
import type { ControlPlane } from '../src/control/plane';

// The control-plane facade is the proxy's single seam to policy, container
// identity and audit (docs/ADR-huddle-node-split.md). It imports no database and
// no Docker client — that is the property that lets the gateway run without
// either — so this suite needs no SQLite build and never skips.

function recordingPlane(calls: string[]): ControlPlane {
  return {
    checkRule: (d, c, p) => { calls.push(`checkRule:${d}:${c}:${p}`); return { status: 'allow', ruleId: 1 }; },
    isPathMode: (d, c) => { calls.push(`isPathMode:${d}:${c}`); return true; },
    resolveContainerByIp: async (ip) => { calls.push(`resolveContainerByIp:${ip}`); return 'dc-1'; },
    resolveSandboxBySecret: (s) => { calls.push(`resolveSandboxBySecret:${s}`); return 'box'; },
    logAudit: () => { calls.push('logAudit'); return 42; },
    updateAuditResponse: (ref) => { calls.push(`updateAuditResponse:${ref}`); },
    reportSudoAudit: (c, e) => { calls.push(`reportSudoAudit:${c}:${e}`); },
  };
}

describe('control-plane facade', () => {
  afterEach(() => { plane.resetControlPlane(); });

  it('delegates every member to the active binding', async () => {
    const calls: string[] = [];
    plane.setControlPlane(recordingPlane(calls));

    expect(plane.controlPlane.checkRule('example.com', 'dc-1', '/a')).toEqual({ status: 'allow', ruleId: 1 });
    expect(plane.controlPlane.isPathMode('example.com', null)).toBe(true);
    await expect(plane.controlPlane.resolveContainerByIp('10.0.0.2')).resolves.toBe('dc-1');
    expect(plane.controlPlane.resolveSandboxBySecret('s3cret')).toBe('box');
    expect(plane.controlPlane.logAudit({ containerId: null, domain: 'example.com', action: 'allow' })).toBe(42);
    plane.controlPlane.updateAuditResponse(42, { resStatus: 200 });
    plane.controlPlane.reportSudoAudit('dc-1', 'COMMAND=/usr/bin/id');

    expect(calls).toEqual([
      'checkRule:example.com:dc-1:/a',
      'isPathMode:example.com:null',
      'resolveContainerByIp:10.0.0.2',
      'resolveSandboxBySecret:s3cret',
      'logAudit',
      'updateAuditResponse:42',
      'reportSudoAudit:dc-1:COMMAND=/usr/bin/id',
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

  // The window between the process starting and the control client connecting
  // is real, and this is what the proxy sees during it. `deny`, not `requested`:
  // filing the host as pending would claim a rule exists for it when the gateway
  // holds no policy at all.
  it('denies everything while nothing is bound', () => {
    expect(plane.controlPlane.checkRule('unseen.example.com', null, null)).toEqual({ status: 'deny', ruleId: null });
    expect(plane.controlPlane.isPathMode('unseen.example.com', null)).toBe(false);
    // Same reason: with nothing bound the gateway recognises no sandbox, so
    // every box on the sbx listener is denied rather than assumed.
    expect(plane.controlPlane.resolveSandboxBySecret('s3cret')).toBe(null);
    expect(plane.controlPlane.logAudit({ containerId: null, domain: 'x.test', action: 'deny' })).toBe(null);
    // A sudo line that arrives before the plane is bound is dropped, not
    // buffered: it is an audit record, not a decision, and there is nowhere to
    // put it. Throwing here would take down the proxy request that relayed it.
    expect(() => plane.controlPlane.reportSudoAudit('dc-1', 'COMMAND=/usr/bin/id')).not.toThrow();
  });

  it('falls back to denying on reset, not to the previous binding', () => {
    plane.setControlPlane(recordingPlane([]));
    plane.resetControlPlane();
    expect(plane.controlPlane.checkRule('unseen.example.com', null, null).status).toBe('deny');
  });

  // There is exactly one production binding, ./client. An in-process binding
  // reading SQLite directly would be a second definition of the firewall.
  it('exposes no in-process binding', () => {
    expect((plane as Record<string, unknown>).inProcessControlPlane).toBeUndefined();
  });
});
