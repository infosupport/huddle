// Which sandbox is calling.
//
// A devcontainer is identified by its source address; a sandbox cannot be. sbx'
// host daemon terminates and rewrites everything a box sends, so every sandbox
// reaches us as the same client and nothing set inside a box survives the trip.
// What does survive is the credential in the upstream-proxy URL, because it is
// the hop's OWN authentication — the daemon presents it to get through us at all
// — and sbx bakes that URL in when the sandbox is created. See
// docs/ADR-sbx-identity.md.
//
// Shared by both halves, like sbx-upstream.ts: Node mints and spends the secret,
// the gateway recognises it. Hence no imports beyond node:crypto — anything
// reachable from boot-gateway.ts must not drag in the database.

import crypto from 'crypto';

/**
 * The name presented when a sandbox' identity is not claimed by anyone.
 *
 * `proxy.sandbox` is one global setting, so the URL is only per-sandbox because
 * sbx reads it at create. Between creates Huddle parks it here: a credential
 * that maps to no sandbox. Anything that turns up holding it is denied by name
 * instead of inheriting the rights of whichever box was created last.
 */
export const UNCLAIMED_SANDBOX = 'huddle-unclaimed';

/**
 * How a sandbox appears to the rule engine, alongside a devcontainer's id.
 *
 * The name itself, unprefixed — because that is already the key everything else
 * uses: reconcile reads Huddle's ruleset back by that column, and the portal
 * counts a box' pending rows with `container_id === name`. A
 * prefix here would make the proxy file rows under a second, parallel key that
 * none of them look at, so a sandbox' own rules would never match and every box
 * would be denied everything.
 *
 * It is a function rather than the bare string at the call site so there is one
 * place to state that, and one place to change if sandboxes ever need a scope of
 * their own.
 *
 * Collision with a devcontainer IS a real concern, and this function alone
 * cannot close it. A devcontainer's id in this same keyspace is not a 32-char
 * UUID — see feed-build.ts's `authorizedDevcontainerNames`, which is built from
 * docker.ts's `containerSnapshot()` and holds the container's own NAME (its
 * `.Names[0]`, e.g. what `docker ps` prints), plus whatever
 * `huddle migrate --docker-socket` registered under. A sandbox's name
 * (sandbox/protocol.ts's `SANDBOX_NAME_RE`) is drawn from essentially the same
 * character class as Docker's own container-naming grammar, so nothing
 * currently stops a sandbox and a devcontainer from sharing a name — and, once
 * they do, from sharing a row in the `rules.container_id` keyspace this
 * function's output is compared against. Closing that for real means giving
 * sandboxes a keyspace Docker cannot produce (e.g. a prefix or character
 * outside that grammar) — but that key is also read verbatim, unprefixed,
 * by other holders of "the name" described above (reconcile.ts's stale-rule
 * projection, the portal's pending-rule count), so changing what this function
 * returns without updating those in lockstep would silently break rule
 * matching for every existing sandbox instead of fixing the collision. That
 * coordinated change is out of scope here; this function still returns the
 * bare name, and the collision this doc used to wave away is now flagged
 * instead of hidden.
 */
export function sandboxContainerId(name: string): string {
  return name;
}

/**
 * A fresh sandbox secret: 256 bits from the CSPRNG, base64url.
 *
 * Never derive this from the sandbox name, the project, a counter or the clock.
 * The proxy port is reachable by every process on the operator's machine, so a
 * guessable secret is not a weaker identity — it is no identity, because anyone
 * who can guess it can present any box's rights.
 */
export function mintSandboxSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * What the gateway stores instead of the secret: it has to RECOGNISE an identity,
 * not possess one, and it is deliberately the less-trusted half of the split.
 */
export function hashSandboxSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

/** Timing-safe compare of two hex digests, for looking a hash up by equality. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/** `http://<name>:<secret>@host:port` — the URL handed to `sbx settings set`. */
export function sandboxProxyUrl(baseUrl: string, name: string, secret: string): string {
  const u = new URL(baseUrl);
  u.username = encodeURIComponent(name);
  u.password = encodeURIComponent(secret);
  return u.toString();
}

export interface ProxyIdentity {
  name: string;
  secret: string;
}

/** The credential out of a `Proxy-Authorization: Basic …` header, or null. */
export function parseProxyAuthorization(header: string | undefined): ProxyIdentity | null {
  if (!header) return null;
  const [scheme, value] = header.split(/\s+/, 2);
  if (!/^basic$/i.test(scheme) || !value) return null;
  // Buffer.from(_, 'base64') never throws — invalid input decodes leniently
  // (Node just skips the characters it cannot place) — so this try/catch
  // guards nothing on its own. What DOES throw is decodeURIComponent below,
  // on a malformed %-escape a sandbox has full control over (it is base64 of
  // attacker-supplied bytes). Both are handled the same way here: this whole
  // header is untrusted input arriving on every proxied request, so anything
  // it can make throw has to become "no credential" rather than an uncaught
  // exception on the gateway's request path — the latter takes the process
  // down for every other sandbox and devcontainer currently being served.
  let decoded: string;
  try {
    decoded = Buffer.from(value, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // The secret is base64url and carries no colon, so the FIRST colon splits.
  const at = decoded.indexOf(':');
  if (at < 0) return null;
  try {
    return { name: decodeURIComponent(decoded.slice(0, at)), secret: decoded.slice(at + 1) };
  } catch {
    return null;
  }
}

/**
 * The same URL with the credential replaced by `***`.
 *
 * Huddle shows the sbx commands it ran, verbatim, so an operator can see which
 * one broke (`SbxStep.command`). That is worth keeping — but the moment the URL
 * carries a credential, printing it verbatim puts the secret on screen and into
 * every log that captures the screen. Redact at the point of display, never at
 * the point of use.
 */
export function redactProxyUrl(url: string): string {
  try {
    const u = new URL(url);
    if (!u.username && !u.password) return url;
    u.username = u.username ? '***' : '';
    u.password = u.password ? '***' : '';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^/@]*@/, '//***@');
  }
}
