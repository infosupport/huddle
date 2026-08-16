import { describe, it, expect } from 'vitest';
import { parsePolicyLogJson, parseSandboxListJson } from '../src/sandbox/ops';

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
