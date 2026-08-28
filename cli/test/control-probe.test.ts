import { describe, it, expect } from 'vitest';

import { parseDefaultGateway, parseProbeOutput } from '../src/control-probe';

// The impure half of control-probe.ts spawns containers, so only the parsing is
// tested here — which is fine, because the parsing is where a wrong answer turns
// into a firewall that denies everything and says nothing.

describe('parseProbeOutput', () => {
  it('treats 401 as reachable — the packets arrived, which is the question', () => {
    expect(parseProbeOutput('PROBE_HTTP 401\n')).toEqual({ reachable: true, detail: 'HTTP 401' });
  });

  it('treats 200 as reachable too', () => {
    expect(parseProbeOutput('PROBE_HTTP 200')).toEqual({ reachable: true, detail: 'HTTP 200' });
  });

  it('reports the errno of a refused connection', () => {
    expect(parseProbeOutput('PROBE_ERR ECONNREFUSED')).toEqual({
      reachable: false,
      detail: 'ECONNREFUSED',
    });
  });

  it('reports a timeout, which is what a host firewall looks like', () => {
    expect(parseProbeOutput('PROBE_ERR TimeoutError').reachable).toBe(false);
  });

  it('ignores anything the runtime printed ahead of the result', () => {
    const out = 'Unable to find image locally\npulling...\nPROBE_HTTP 401\n';
    expect(parseProbeOutput(out)).toEqual({ reachable: true, detail: 'HTTP 401' });
  });

  it('is not reachable when the probe container never ran', () => {
    expect(parseProbeOutput(null).reachable).toBe(false);
  });

  it('is not reachable on empty output', () => {
    expect(parseProbeOutput('   \n')).toEqual({ reachable: false, detail: 'no output' });
  });
});

describe('parseDefaultGateway', () => {
  it('reads the busybox shape', () => {
    expect(parseDefaultGateway('default via 172.20.144.1 dev eth0\n')).toBe('172.20.144.1');
  });

  it('reads an iproute2 line with the via at the end', () => {
    const out = 'default dev eth0 scope link src 10.0.0.5 via 10.0.0.1\n';
    expect(parseDefaultGateway(out)).toBe('10.0.0.1');
  });

  it('skips non-default routes', () => {
    const out = '172.17.0.0/16 via 172.17.0.1 dev docker0\ndefault via 192.168.65.1 dev eth0\n';
    expect(parseDefaultGateway(out)).toBe('192.168.65.1');
  });

  it('rejects an octet out of range rather than binding to nonsense', () => {
    expect(parseDefaultGateway('default via 999.1.1.1 dev eth0')).toBeNull();
  });

  it('returns null for a default route with no gateway (IPv6-only, link scope)', () => {
    expect(parseDefaultGateway('default dev eth0 scope link')).toBeNull();
  });

  it('returns null when the command produced nothing', () => {
    expect(parseDefaultGateway(null)).toBeNull();
    expect(parseDefaultGateway('')).toBeNull();
  });
});
