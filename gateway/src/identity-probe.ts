// ── Identity probe (diagnostic, off by default) ──────────────────────────────
// Temporary instrumentation to answer one question for the sandbox-runtime work
// (docs/ADR-workspace-runtime-abstraction.md §5.2): when a Docker Sandboxes
// microVM's egress is forced through Huddle as its upstream proxy, WHAT does
// Huddle actually see per request — a distinct, stable per-sandbox source IP, or
// host-aggregated traffic that needs an explicit identity signal (a per-sandbox
// Proxy-Authorization token / upstream URL)?
//
// It also checks the spoofing question: if the guest (which has root) injects its
// own Proxy-Authorization, does the sandbox host proxy forward that to us, or
// replace it with the host-configured upstream credential? Only the latter makes
// a token identity unforgeable.
//
// Gated behind HUDDLE_IDENTITY_PROBE=1 so it is inert in normal operation and
// safe to ship. It logs the raw Proxy-Authorization on purpose (the whole point
// is to see it), which is why it must stay OFF by default — do not enable it in a
// deployment where the proxy credential is a real secret you care about leaking
// to the console log.

import type { IncomingMessage } from 'http';

const ENABLED = process.env.HUDDLE_IDENTITY_PROBE === '1';

export function identityProbeEnabled(): boolean {
  return ENABLED;
}

// Headers that could carry a per-workspace identity signal from an upstream/host
// proxy. We log all of them so the experiment shows which (if any) arrive.
const CANDIDATE_HEADERS = [
  'proxy-authorization',
  'authorization',
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'via',
  'x-huddle-ext',
  'user-agent',
];

function decodeBasic(value: string | undefined): string | null {
  if (typeof value !== 'string') return null;
  const m = /^basic\s+(.+)$/i.exec(value.trim());
  if (!m) return null;
  try {
    // Show only the username half (the token); never echo a decoded password.
    const decoded = Buffer.from(m[1], 'base64').toString('utf8');
    const user = decoded.split(':', 1)[0];
    return user;
  } catch {
    return null;
  }
}

/**
 * Emit one line of diagnostics for a proxied request. `source` distinguishes the
 * three proxy entry points (plain HTTP, WebSocket upgrade, CONNECT). No-op unless
 * HUDDLE_IDENTITY_PROBE=1.
 */
export function logIdentityProbe(
  source: 'request' | 'upgrade' | 'connect',
  req: IncomingMessage,
  remoteAddress: string | undefined,
  resolvedId: string | null,
): void {
  if (!ENABLED) return;
  const headers: Record<string, string> = {};
  for (const name of CANDIDATE_HEADERS) {
    const v = req.headers[name];
    if (v !== undefined) headers[name] = Array.isArray(v) ? v.join(', ') : v;
  }
  const record = {
    probe: 'identity',
    source,
    remoteAddress: (remoteAddress ?? '').replace(/^::ffff:/, ''),
    target: req.url ?? '',
    resolvedId,
    proxyAuthUser: decodeBasic(headers['proxy-authorization']),
    headers,
  };
  try {
    console.log(`[identity-probe] ${JSON.stringify(record)}`);
  } catch {
    console.log('[identity-probe] <unserializable record>');
  }
}
