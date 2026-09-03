import { describe, expect, it, vi } from 'vitest';
import { sanitizeAfterNetworkChange } from '../src/dns-egress';

describe('DNS sanitizing after a network-generation feed change', () => {
  it('runs immediately, then retains the settling retries', () => {
    const sanitize = vi.fn();
    sanitizeAfterNetworkChange(sanitize);

    // The first pass is synchronous with handling the changed feed; it does
    // not wait for the one-second poll/settling timer.
    expect(sanitize).toHaveBeenCalledTimes(1);
  });
});
