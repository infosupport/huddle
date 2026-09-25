import { describe, it, expect } from 'vitest';
import { unavailableReason } from '../src/sandbox/ops';

// sbx is a HOST binary: it drives the user's own Docker installation. Huddle used
// to reach it from the container through a file mailbox; that bridge is gone
// (step 5 of docs/ADR-huddle-node-split.md), so a containerized Huddle simply
// cannot run sbx and should say so rather than fail as if sbx were missing.

describe('unavailableReason', () => {
  it('permits sbx on the host', () => {
    expect(unavailableReason(true, undefined)).toBe(null);
  });

  it('refuses sbx in the gateway container', () => {
    const reason = unavailableReason(false, undefined);
    expect(reason).not.toBe(null);
    // The message has to name the fix, because the failure it replaces
    // ("'sbx' not found on PATH") sends people off installing sbx again.
    expect(reason).toContain('huddle node');
  });

  it('steps aside for an explicit HUDDLE_SBX_BIN', () => {
    // Setting it is a deliberate statement about where the binary is — including
    // in a container that genuinely has one mounted.
    expect(unavailableReason(false, '/usr/local/bin/sbx')).toBe(null);
  });

  it('treats an unset override as unset, not as a value', () => {
    expect(unavailableReason(false, '')).not.toBe(null);
  });
});
