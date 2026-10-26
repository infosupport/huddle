// Sandbox egress through Huddle (docs/host-pipe.md, "sbx egress"). sbx has one
// global upstream-proxy setting (`proxy.sandbox`), but a sandbox keeps the value
// it was created with. So every create points the setting at the gateway with a
// secret of its own, and right after the create back at a RESET secret that
// belongs to no sandbox. The gateway knows each sandbox by the SHA-256 of its
// secret. Seeing the reset secret means sbx rebuilt a sandbox's proxy from the
// global setting (a daemon restart does that), so Huddle no longer knows which
// box is which and recreates them all.
//
// Pure helpers only: no DB, no pipe, so they are unit-testable as they are.

import crypto from 'crypto';

/** Port of the sbx egress listener inside the gateway container. */
export const SBX_PROXY_PORT = 3128;
/** Proxy user name of the reset secret. Sandbox names never start with an underscore. */
export const RESET_USER = '_huddle-reset';

/**
 * The host port `huddle init` published for the listener, or null with an older
 * CLI that did not publish one (then egress cannot be routed and sbx stays off).
 */
export function sbxProxyHostPort(env: NodeJS.ProcessEnv = process.env): number | null {
  const port = Number(env.HUDDLE_SBX_PROXY_HOST_PORT);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
}

/** 256 bits from the CSPRNG, base64url: safe in a URL's userinfo as is. */
export function newProxySecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

export function hashProxySecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

/** The proxy URL the sbx daemon gets: it runs on the host, the listener is on host loopback. */
export function sbxProxyUrl(user: string, secret: string, port: number): string {
  return `http://${user}:${secret}@127.0.0.1:${port}`;
}

/** Whether a `proxy.sandbox` value points at our listener (so it is not the user's own). */
export function isHuddleProxyUrl(value: string, port: number): boolean {
  try {
    const u = new URL(value.trim());
    return ['127.0.0.1', 'localhost'].includes(u.hostname) && Number(u.port) === port;
  } catch {
    return false;
  }
}

/** Hides the password in any `scheme://user:pass@` inside a string (step logs, errors). */
export function redactProxyUrls(s: string): string {
  return s.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^:@/\s]*):[^@/\s]*@/gi, '$1:***@');
}

/** user/password from a `Proxy-Authorization: Basic ...` header, or null. */
export function parseProxyAuthorization(header: string | string[] | undefined): { user: string; pass: string } | null {
  if (typeof header !== 'string') return null;
  const m = /^\s*basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

/** Constant-time string comparison (length is not secret here: every secret has the same length). */
export function sameSecret(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
