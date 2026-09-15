// Requests addressed to Huddle itself.
//
// The filtering proxy forwards on behalf of devcontainers, so "localhost" in a
// devcontainer's request is resolved in the GATEWAY's network namespace, not the
// container's. That makes self-addressed traffic a category of its own: it is
// never what the caller meant, it reaches Huddle's own API and proxy ports, and
// forwarding it to the proxy's own listener loops it straight back into itself.
// Default-deny already refuses it in practice — no rule matches, so it is filed
// as `requested` and blocked — but that leaves it one operator mistake away from
// being allowed. These are refused regardless of policy.
//
// With one exception, which is the reason this is a classifier and not a
// blocklist: devcontainers legitimately POST their sudo-audit records to Huddle
// through the proxy, and that has to keep working. It no longer reaches an API —
// nothing listens on that port in the gateway — the proxy answers it itself and
// relays the line to Huddle Node (proxy.ts:handleSudoAudit). What this function
// decides is therefore not "may it be forwarded" but "is this THE endpoint".
//
// Imports nothing, so it is testable without a database or a native binding —
// and the caller passes the API port in rather than this module resolving it,
// because after the split "which port is Huddle's API" has two answers.

/**
 * Hostnames that mean "the gateway itself", in the exact spelling
 * canonicalizeHost produces.
 *
 * `huddle` is the container name devcontainers reach the proxy by; the rest is
 * loopback. The list is short because canonicalization has already collapsed the
 * variants: the WHATWG parser folds every IPv6 loopback spelling (`[0::1]`,
 * `[0:0:0:0:0:0:0:1]`) onto `[::1]`, rejects an unbracketed one outright, and
 * rewrites IPv4 shorthand (`127.1`, `2130706433`, `0x7f000001`) to dotted-quad.
 * The classic SSRF-bypass spellings therefore never reach this comparison in a
 * form it could miss — proxy-self.test.ts pins that.
 */
const SELF_NAMES: ReadonlySet<string> = new Set([
  'huddle',
  'localhost',
  'ip6-localhost',
  'ip6-loopback',
  '[::1]',
  // The unspecified address routes to this host too.
  '0.0.0.0',
  '[::]',
]);

/**
 * Is this request addressed to Huddle itself? `host` must already be
 * canonicalized (lowercased, punycode, bracketed IPv6, no trailing dot) — the
 * proxy does that at all three entry points via canonicalizeHost, and comparing
 * anything else would be the parser-differential bug that finding #3 was about.
 */
export function isSelfHost(host: string): boolean {
  if (SELF_NAMES.has(host)) return true;
  // The whole 127.0.0.0/8 block, not just 127.0.0.1.
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  // ...and the same block reached through an IPv4-mapped IPv6 address, which
  // canonicalizes to hex: [::ffff:127.0.0.1] becomes [::ffff:7f00:1].
  return /^\[::ffff:7f[0-9a-f]{0,2}:[0-9a-f]{1,4}\]$/.test(host);
}

/**
 * The one thing a devcontainer may reach on Huddle: posting its sudo-audit
 * records. Everything else addressed to Huddle is refused even when isSelfHost
 * says yes.
 *
 * `port` is the port from the request URL — empty when the caller gave none,
 * which for http:// means 80 and is therefore never the API.
 */
export function isPublicSelfEndpoint(
  port: string,
  method: string | undefined,
  path: string | null,
  apiPort: number,
): boolean {
  return port === String(apiPort) && method === 'POST' && path === '/api/audit/sudo';
}
