import { describe, it, expect } from 'vitest';
import { parsePolicyLogJson, parseSandboxListJson, parsePolicyLsJson } from '../src/sandbox/ops';

// `sbx policy ls --json` — the ACTUAL policy, used by reconcile to spot drift and
// remove rules by id. Confirmed schema (2026-08-16): id, decision, resource_type,
// resources[] (may carry :port), scope "global"|"sandbox:<n>" / sandbox_id,
// editable, status.
describe('parsePolicyLsJson', () => {
  const real = JSON.stringify({
    policies: [
      { id: '6092', name: '6092', scope: 'sandbox:huddle-sbx', applies_to: 'sandbox:huddle-sbx', resource_type: 'network', decision: 'allow', resources: ['jsonplaceholder.typicode.com:443'], origin: 'scoped', layer: 'local', status: 'active', editable: true, sandbox_id: 'huddle-sbx' },
      { id: 'g1', scope: 'global', resource_type: 'network', decision: 'deny', resources: ['evil.test:80', 'bad.test'], status: 'active', editable: true },
      { id: 'org1', scope: 'global', resource_type: 'network', decision: 'allow', resources: ['org.test'], status: 'active', editable: false }, // org rule → skip
      { id: 'dns1', scope: 'global', resource_type: 'dns', decision: 'allow', resources: ['x.test'], status: 'active', editable: true }, // non-network → skip
    ],
  });

  it('parses id/decision/scope and strips :port from resources', () => {
    const out = parsePolicyLsJson(real)!;
    expect(out).toContainEqual({ id: '6092', action: 'allow', target: 'jsonplaceholder.typicode.com', scope: { kind: 'sandbox', name: 'huddle-sbx' } });
  });

  it('expands multiple resources into one rule each (global scope)', () => {
    const out = parsePolicyLsJson(real)!;
    expect(out).toContainEqual({ id: 'g1', action: 'deny', target: 'evil.test', scope: { kind: 'global' } });
    expect(out).toContainEqual({ id: 'g1', action: 'deny', target: 'bad.test', scope: { kind: 'global' } });
  });

  it('skips non-editable (org/system) and non-network rules', () => {
    const out = parsePolicyLsJson(real)!;
    expect(out.some((r) => r.id === 'org1')).toBe(false);
    expect(out.some((r) => r.id === 'dns1')).toBe(false);
  });

  it('accepts a top-level array and returns [] / null appropriately', () => {
    expect(parsePolicyLsJson(JSON.stringify([{ id: 'a', decision: 'allow', resources: ['a.test'], status: 'active' }]))![0].id).toBe('a');
    expect(parsePolicyLsJson('')).toEqual([]);
    expect(parsePolicyLsJson('not json')).toBeNull();
  });
});

describe('parseSandboxListJson', () => {
  it('parses a top-level array of objects (name/status)', () => {
    const out = parseSandboxListJson(JSON.stringify([
      { name: 'huddle-2', status: 'Up 2 hours' },
      { name: 'box1', state: 'exited' },
    ]));
    expect(out).toEqual([
      { name: 'huddle-2', status: 'Up 2 hours' },
      { name: 'box1', status: 'exited' },
    ]);
  });

  it('unwraps {sandboxes:[...]} and honours Name/vm_name/id', () => {
    expect(parseSandboxListJson(JSON.stringify({ sandboxes: [{ Name: 'a' }, { vm_name: 'b' }, { id: 'c' }] })))
      .toEqual([{ name: 'a', status: undefined }, { name: 'b', status: undefined }, { name: 'c', status: undefined }]);
  });

  it('accepts an array of bare name strings', () => {
    expect(parseSandboxListJson(JSON.stringify(['x', 'y']))).toEqual([{ name: 'x', status: undefined }, { name: 'y', status: undefined }]);
  });

  it('never emits a header row (the old tabwriter bug)', () => {
    const out = parseSandboxListJson(JSON.stringify([{ name: 'real-box', status: 'running' }]));
    expect(out.some((s) => s.name.toUpperCase() === 'NAME')).toBe(false);
  });

  it('[] for empty, null for non-JSON / unrecognised', () => {
    expect(parseSandboxListJson('')).toEqual([]);
    expect(parseSandboxListJson('NAME   STATUS\nalpha  Up')).toBeNull(); // tabwriter → fall back
    expect(parseSandboxListJson('{"weird":true}')).toBeNull();
  });
});

// Real `sbx policy log --json` schema (confirmed 2026-08-15):
//   { blocked_hosts: [{ host: "h:port", vm_name, reason, ... }], allowed_hosts: [...] }
describe('parsePolicyLogJson', () => {
  const sample = JSON.stringify({
    blocked_hosts: [
      { host: 'toonisleuk.be:80', vm_name: 'huddle-2', reason: 'Policy snapshot stale (retryable)', count_since: 2 }, // transient → skip
      { host: 'api.test:443', vm_name: 'huddle-2', reason: 'blocked by policy' },                                     // genuine → keep
      { host: 'github.com.huddle-x.docker.internal', vm_name: 'huddle-x', proxy_type: 'network', reason: 'DNS lookup blocked by proxy policy' }, // internal → skip
      { host: 'github.com', vm_name: 'huddle-x', proxy_type: 'network', reason: 'DNS lookup blocked by proxy policy' }, // genuine DNS → keep
    ],
    allowed_hosts: [
      { host: 'download.jetbrains.com:443', vm_name: 'huddle-sbx-msukde25', proxy_type: 'forward-bypass' },
    ],
  });

  it('extracts genuine policy denials (strips :port, scopes by vm_name)', () => {
    const out = parsePolicyLogJson(sample);
    expect(out).toContainEqual({ domain: 'api.test', sandbox: 'huddle-2' });
    expect(out).toContainEqual({ domain: 'github.com', sandbox: 'huddle-x' });
  });

  it('SKIPS transient "policy snapshot stale (retryable)" blocks (not real pending)', () => {
    const out = parsePolicyLogJson(sample);
    expect(out.some((e) => e.domain === 'toonisleuk.be')).toBe(false);
  });

  it('ignores allowed_hosts (they already got through — not pending)', () => {
    const out = parsePolicyLogJson(sample);
    expect(out.some((e) => e.domain === 'download.jetbrains.com')).toBe(false);
  });

  it('skips sbx-internal .docker.internal DNS plumbing', () => {
    const out = parsePolicyLogJson(sample);
    expect(out.some((e) => e.domain.endsWith('.docker.internal'))).toBe(false);
  });

  it('handles IP + metadata hosts', () => {
    const out = parsePolicyLogJson(JSON.stringify({ blocked_hosts: [{ host: '169.254.169.254:80', vm_name: 'box1', reason: 'blocked by policy' }] }));
    expect(out).toEqual([{ domain: '169.254.169.254', sandbox: 'box1' }]);
  });

  it('returns [] on empty / garbage / no blocked_hosts', () => {
    expect(parsePolicyLogJson('')).toEqual([]);
    expect(parsePolicyLogJson('not json')).toEqual([]);
    expect(parsePolicyLogJson(JSON.stringify({ allowed_hosts: [{ host: 'x.test', vm_name: 'b' }] }))).toEqual([]);
  });

  it('generic array fallback honours a deny decision (and skips allowed)', () => {
    const out = parsePolicyLogJson(JSON.stringify([
      { host: 'a.test', vm_name: 'b', reason: 'blocked' },
      { host: 'ok.test', vm_name: 'b', reason: 'allowed' },
    ]));
    expect(out).toEqual([{ domain: 'a.test', sandbox: 'b' }]);
  });
});
