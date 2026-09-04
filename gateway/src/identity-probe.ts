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
// That question is answered (docs/ADR-sbx-identity.md §8) and the answer is now
// load-bearing: the credential in Proxy-Authorization IS a sandbox' identity.
// So the probe survives as a diagnostic — which box did a request get attributed
// to, and why — but it no longer prints the credential. It used to log
// Proxy-Authorization raw, on purpose, back when it was an experiment about a
// value nobody depended on; the same line today writes a live secret to the
// console, and ADR §5 says nothing logs it. The username half is kept (it is a
// sandbox NAME, not a secret, and it is what makes a denial diagnosable); the
// password half never leaves this file.
//
// Gated behind HUDDLE_IDENTITY_PROBE=1 so it is inert in normal operation.

import type { IncomingMessage } from 'http';

const ENABLED = process.env.HUDDLE_IDENTITY_PROBE === '1';

export function identityProbeEnabled(): boolean {
  return ENABLED;
}

// Headers that could carry a per-workspace identity signal from an upstream/host
// proxy. All of them are logged so the probe shows which (if any) arrive — the
// two that can carry a credential go through redactAuth first.
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

// Credential-bearing headers, logged as their scheme plus the username half of
// a Basic credential. Enough to say WHICH box presented something and in what
// form; never enough to present it again.
const SECRET_HEADERS = new Set(['proxy-authorization', 'authorization']);

function redactAuth(value: string): string {
  const user = decodeBasic(value);
  if (user !== null) return `Basic ${user}:***`;
  const scheme = /^(\S+)/.exec(value.trim())?.[1];
  return scheme ? `${scheme} ***` : '***';
}

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
    if (v === undefined) continue;
    const flat = Array.isArray(v) ? v.join(', ') : v;
    headers[name] = SECRET_HEADERS.has(name) ? redactAuth(flat) : flat;
  }
  const record = {
    probe: 'identity',
    source,
    remoteAddress: (remoteAddress ?? '').replace(/^::ffff:/, ''),
    target: req.url ?? '',
    resolvedId,
    proxyAuthUser: decodeBasic(
      Array.isArray(req.headers['proxy-authorization'])
        ? req.headers['proxy-authorization'][0]
        : req.headers['proxy-authorization'],
    ),
    headers,
  };
  try {
    console.log(`[identity-probe] ${JSON.stringify(record)}`);
  } catch {
    console.log('[identity-probe] <unserializable record>');
  }
}
