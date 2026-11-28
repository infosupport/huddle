import crypto from 'crypto';
import type http from 'http';
import { matchDomain } from './rules';
import {
  getEnvMapping,
  getEnvMappingByUid,
  listEnvMappings,
  envMappingsOf,
  ensureEnvMappingUids,
  readHostConfigStrict,
  hostConfigAvailable,
  type HostEnvMapping,
} from './host-config';
import {
  getEnvSecret,
  resolveEnvPlaceholder,
  setContainerEnvMappings,
  purgeOrphanedEnvMappingBindings,
  backfillEnvSecretUids,
  type ContainerEnvMapping,
} from './db';

// ── Environment variable mappings (issue #108) ───────────────────────────────
//
// A mapping hands a devcontainer an environment variable at create time. For a
// mapping marked secret the container does NOT get the real value: it gets an
// opaque placeholder, and only the egress proxy swaps that placeholder back for
// the real secret — and then only towards the hosts the operator explicitly
// listed on that mapping.
//
// The definitions live in ~/.huddle/config.json (host-config.ts); the secrets and
// the issued placeholders live in the DB (db.ts). This module is the decision
// layer between them, with the security-critical parts written as pure functions
// so they can be tested without a container or a proxy.

export const ENV_PLACEHOLDER_PREFIX = 'huddle_env_';

// 32 random bytes: unguessable, so a container cannot brute-force a placeholder
// it was never handed.
const PLACEHOLDER_BYTES = 32;
const PLACEHOLDER_HEX = PLACEHOLDER_BYTES * 2;

// Global so every occurrence in a header value is swapped; the fixed hex length
// keeps the match from swallowing surrounding text.
const PLACEHOLDER_RE = new RegExp(`${ENV_PLACEHOLDER_PREFIX}[0-9a-f]{${PLACEHOLDER_HEX}}`, 'g');

export function newEnvPlaceholder(): string {
  return ENV_PLACEHOLDER_PREFIX + crypto.randomBytes(PLACEHOLDER_BYTES).toString('hex');
}

export function isEnvPlaceholder(value: string): boolean {
  return new RegExp(`^${ENV_PLACEHOLDER_PREFIX}[0-9a-f]{${PLACEHOLDER_HEX}}$`).test(value);
}

// ── Validation ───────────────────────────────────────────────────────────────

// Variables that carry Huddle's own security posture into the container. A
// mapping that could set HTTPS_PROXY would route traffic around the egress
// firewall; one that could set SSL_CERT_FILE would break CA trust. Refused at the
// API, and the Env array in docker.ts puts Huddle's own entries last as a second
// line of defense (in Docker's Env the last entry wins).
export const RESERVED_ENV_VARS: ReadonlySet<string> = new Set([
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'no_proxy',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'REQUESTS_CA_BUNDLE',
  'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
  'JAVA_TOOL_OPTIONS', 'DEVCONTAINER_CONFIG_PATH', 'XDG_DATA_HOME',
  '_CONTAINER_USER', '_CONTAINER_USER_HOME', '_REMOTE_USER', '_REMOTE_USER_HOME',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'PATH',
]);

const VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Throws with an operator-readable message when `name` is not usable. Fail-closed:
 * anything outside the POSIX-ish shape, or on the reserved list, is rejected
 * rather than sanitized.
 */
export function validateEnvVarName(name: string): void {
  if (!name || !VAR_NAME_RE.test(name)) {
    throw new Error(
      `invalid variable name '${name}': use letters, digits and underscore, not starting with a digit`
    );
  }
  if (RESERVED_ENV_VARS.has(name)) {
    throw new Error(`variable '${name}' is reserved by Huddle and cannot be overridden`);
  }
}

/**
 * Docker's Env is a list of `NAME=value` strings, so a newline or NUL would split
 * or truncate the entry. Reject rather than trim — silently altering a credential
 * is worse than refusing it.
 */
export function validateEnvValue(value: string): void {
  if (/[\n\r\0]/.test(value)) {
    throw new Error('value must not contain newlines or NUL bytes');
  }
}

// ── Secret host allowlist ────────────────────────────────────────────────────

/** Comma- or whitespace-separated patterns, e.g. "api.github.com, *.github.com". */
export function parseSecretHosts(csv: string): string[] {
  return (csv ?? '')
    .split(/[,\s]+/)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * May a secret be redeemed towards `host`? Fail-closed on every uncertainty: an
 * empty allowlist never matches, so a secret saved without hosts is inert rather
 * than universally redeemable. Reuses matchDomain() so `*.example.com` means
 * exactly what it means in a firewall rule.
 */
export function secretHostAllowed(hosts: string[], host: string): boolean {
  if (!host || hosts.length === 0) return false;
  return hosts.some(p => matchDomain(p, host));
}

// ── Header substitution at the egress proxy ──────────────────────────────────

/** Resolves a placeholder to the real secret and the hosts it may be sent to. */
export type SecretLookup = (
  placeholder: string,
  containerId: string,
) => { value: string; hosts: string } | null;

/**
 * The production lookup: the placeholder binding comes from the DB, the host
 * allowlist and the enabled/secret flags from the config file — so disabling a
 * mapping or clearing its hosts immediately stops redemption, without restarting
 * the containers that already hold the placeholder.
 */
export const lookupEnvSecret: SecretLookup = (placeholder, containerId) => {
  const bound = resolveEnvPlaceholder(placeholder, containerId);
  if (!bound) return null;
  // By uid, not by id: the config entry that owns this secret is the one that was
  // issued this uid, so an entry later written by hand under the same numeric id
  // is not it, and cannot lend its host allowlist to someone else's credential.
  const mapping = getEnvMappingByUid(bound.uid);
  if (!mapping || !mapping.enabled || !mapping.secret) return null;
  return { value: bound.value, hosts: mapping.secretHosts };
};

/** A placeholder that was actually redeemed on one request, and for what. */
export interface EnvSecretSubstitution {
  placeholder: string;
  secret: string;
}

function substituteInValue(
  raw: string,
  host: string,
  containerId: string,
  lookup: SecretLookup,
  applied: Map<string, string>,
): string {
  return raw.replace(PLACEHOLDER_RE, (placeholder) => {
    const entry = lookup(placeholder, containerId);
    if (!entry) return placeholder;
    if (!secretHostAllowed(parseSecretHosts(entry.hosts), host)) return placeholder;
    applied.set(placeholder, entry.value);
    return entry.value;
  });
}

/**
 * Swap every placeholder in the outgoing headers for its real secret, in place.
 * Call this on the UPSTREAM COPY of the headers only — the audit log serialises
 * the original request headers and must keep showing the placeholder.
 *
 * A placeholder survives untouched (never an error, never an empty value) when
 * the caller is unidentified, does not own it, or the target host is not on that
 * mapping's allowlist. The unmodified placeholder then simply fails to
 * authenticate upstream, which is the safe outcome.
 *
 * Returns the substitutions it actually applied, so the caller can put the
 * placeholders back before anything derived from the upstream exchange is
 * persisted — see redactEnvSecrets().
 */
export function substituteEnvSecrets(
  headers: http.OutgoingHttpHeaders,
  host: string,
  containerId: string | null,
  lookup: SecretLookup = lookupEnvSecret,
): EnvSecretSubstitution[] {
  // An unidentified caller can never own a placeholder — bail before touching
  // anything, so an unknown source cannot harvest secrets.
  if (!containerId) return [];
  const applied = new Map<string, string>();
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      if (!value.includes(ENV_PLACEHOLDER_PREFIX)) continue;
      headers[key] = substituteInValue(value, host, containerId, lookup, applied);
    } else if (Array.isArray(value)) {
      if (!value.some(v => typeof v === 'string' && v.includes(ENV_PLACEHOLDER_PREFIX))) continue;
      headers[key] = value.map(v =>
        typeof v === 'string' ? substituteInValue(v, host, containerId, lookup, applied) : v
      );
    }
  }
  return [...applied].map(([placeholder, secret]) => ({ placeholder, secret }));
}

/**
 * Put the placeholders back into anything the upstream sent us, before it is
 * persisted. The audit trail is supposed to contain placeholders only, but an
 * allowlisted service is free to echo a request header back (a debug endpoint, a
 * `Set-Cookie`, an error message naming the credential) — and that response body
 * lands in audit_log and is served from /api/audit. Redeeming a secret towards
 * the upstream must not turn the network log into a place to read it back.
 *
 * Only the substitutions actually applied to THIS request are reverted, so an
 * empty list costs nothing and one container's secret is never searched for in
 * another container's traffic.
 */
export function redactEnvSecrets(text: string, subs: readonly EnvSecretSubstitution[]): string {
  let out = text;
  for (const { placeholder, secret } of subs) {
    // Guard the empty string: split('') would explode the text into characters.
    if (!secret || !out.includes(secret)) continue;
    out = out.split(secret).join(placeholder);
  }
  return out;
}

/**
 * The same redaction, but over a byte stream, for the response on its way back to
 * the DEVCONTAINER — not just the audit copy.
 *
 * Redeeming a placeholder upstream is only safe while the real value stays out of
 * the container. An allowlisted endpoint that reflects request headers (a debug
 * route, an error quoting the credential, a `Set-Cookie`) would otherwise hand the
 * secret straight back, and the workload would hold a credential the placeholder
 * design exists to keep away from it.
 *
 * Streaming rather than buffering is deliberate: the proxy carries Server-Sent
 * Events (an env-mapped ANTHROPIC_API_KEY on a streaming completion is the obvious
 * case), and buffering the body would stall those until the response completed.
 *
 * Works on bytes, so it is unaffected by multi-byte characters splitting across
 * chunks. `push()` holds back the last (longest secret - 1) bytes, since a match
 * starting there cannot be known to be complete yet; `flush()` releases them.
 */
export interface SecretStreamRedactor {
  push(chunk: Uint8Array): Uint8Array;
  flush(): Uint8Array;
}

const EMPTY_BYTES: Uint8Array = Buffer.alloc(0);

export function createSecretStreamRedactor(subs: readonly EnvSecretSubstitution[]): SecretStreamRedactor {
  const pairs = subs
    .filter(s => s.secret)
    .map(s => ({ secret: Buffer.from(s.secret, 'utf8'), placeholder: Buffer.from(s.placeholder, 'utf8') }));
  // Nothing was redeemed on this request: hand the bytes straight through.
  if (pairs.length === 0) {
    return { push: (chunk) => chunk, flush: () => EMPTY_BYTES };
  }
  const holdBack = Math.max(...pairs.map(p => p.secret.length)) - 1;
  let pending: Uint8Array = EMPTY_BYTES;

  // Buffer.concat both normalizes the input to a Buffer we can indexOf() on and
  // gives back a contiguous copy, so the subarray views handed out below never
  // alias a chunk the caller may reuse.
  const replaceAll = (input: Uint8Array): Buffer => {
    let buf = Buffer.concat([input]);
    for (const { secret, placeholder } of pairs) {
      let at = buf.indexOf(secret);
      if (at < 0) continue;
      const parts: Uint8Array[] = [];
      let from = 0;
      while (at >= 0) {
        parts.push(buf.subarray(from, at), placeholder);
        from = at + secret.length;
        at = buf.indexOf(secret, from);
      }
      parts.push(buf.subarray(from));
      buf = Buffer.concat(parts);
    }
    return buf;
  };

  return {
    push(chunk: Uint8Array): Uint8Array {
      const buf = replaceAll(Buffer.concat([pending, chunk]));
      if (buf.length <= holdBack) {
        pending = buf;
        return EMPTY_BYTES;
      }
      pending = buf.subarray(buf.length - holdBack);
      return buf.subarray(0, buf.length - holdBack);
    },
    flush(): Uint8Array {
      const out = replaceAll(pending);
      pending = EMPTY_BYTES;
      return out;
    },
  };
}

// ── Reconciling the config file with the runtime rows ────────────────────────

/**
 * One-time migration: give every mapping a uid and re-key its stored secret onto
 * it (#108).
 *
 * Installs predating the uid have their secrets filed under the numeric
 * mapping_id, which is the recyclable key this change exists to get away from.
 * Minting the uids and copying the rows across has to happen before anything
 * reads a secret, so it runs at startup ahead of purgeOrphanedEnvMappings().
 *
 * Skipped when the config is not mounted or could not be written — retried on the
 * next start rather than left half-done. Non-destructive: the legacy rows stay
 * (same approach as settings-migration.ts), and an existing uid-keyed secret is
 * never overwritten, so re-running changes nothing.
 */
export function migrateEnvSecretsToUids(): number {
  if (!hostConfigAvailable()) return 0;
  const idToUid = ensureEnvMappingUids();
  if (!idToUid) {
    console.warn('[env-mappings] could not write config.json; secret migration retried on next start');
    return 0;
  }
  const moved = backfillEnvSecretUids(idToUid);
  if (moved > 0) console.log(`[env-mappings] re-keyed ${moved} stored secret(s) onto their mapping uid`);
  return moved;
}

/**
 * Housekeeping: drop the placeholder bindings and remembered selections of every
 * mapping the config no longer defines, for entries removed straight out of the
 * hand-editable config.json rather than through the API's delete path.
 *
 * Not load-bearing for security — a placeholder resolves only through its uid,
 * and a uid that has left the config is never re-issued, so a stale binding
 * already resolves to nothing. It is still refused on a config that could not be
 * read, or whose `envMappings` is not a list, because unbinding every live
 * container over a typo would be a thoroughly annoying way to find out.
 */
export function purgeOrphanedEnvMappings(): number {
  const config = readHostConfigStrict();
  if (!config) return 0;
  if ('envMappings' in config && !Array.isArray(config.envMappings)) {
    console.warn('[env-mappings] skipping orphan cleanup: envMappings in config.json is not a list');
    return 0;
  }
  const removed = purgeOrphanedEnvMappingBindings(envMappingsOf(config).map(m => m.id));
  if (removed > 0) {
    console.warn(`[env-mappings] unbound ${removed} placeholder(s) left by mappings removed from config.json`);
  }
  return removed;
}

// ── Building the container's Env entries ─────────────────────────────────────

export interface BuiltEnvMappings {
  /** `NAME=value` entries to put in front of the container's Env array. */
  entries: string[];
  /** Which mapping the container got, and the placeholder it was handed. */
  containerRows: ContainerEnvMapping[];
  /** Mappings left out because they failed validation, for operator-visible logging. */
  skipped: Array<{ id: number; var_name: string; reason: string }>;
}

/**
 * Turn the selected mappings into Docker Env entries. A secret mapping yields a
 * freshly generated placeholder (so two containers never share one) and its real
 * value stays in the DB.
 *
 * `secretFor` supplies the stored secret; a secret mapping with nothing stored is
 * skipped rather than exported as an empty variable, which would look like a
 * working credential.
 *
 * Later entries win in Docker's Env, so the caller passes globals first and the
 * explicitly picked mappings after: picking a mapping at start time is an
 * intentional override of the global default for the same variable.
 */
export function buildEnvEntries(
  mappings: HostEnvMapping[],
  secretFor: (uid: string) => string | null,
  makePlaceholder: () => string = newEnvPlaceholder,
): BuiltEnvMappings {
  const entries: string[] = [];
  const containerRows: ContainerEnvMapping[] = [];
  const skipped: Array<{ id: number; var_name: string; reason: string }> = [];

  for (const m of mappings) {
    if (!m.enabled) continue;
    // A secret hangs off the uid, so an entry without one owns nothing. That is
    // the hand-written `{"id": 5, "secret": true}` case: it must come up empty
    // rather than adopt whatever secret the numeric id once pointed at.
    const value = m.secret ? secretFor(m.uid) : m.value;
    try {
      validateEnvVarName(m.varName);
      if (value === null) throw new Error('secret mapping has no stored value');
      validateEnvValue(value);
    } catch (err) {
      // config.json is hand-editable, so a stored mapping can be invalid. Skip it
      // and say so, rather than letting it break (or weaken) the container start.
      skipped.push({ id: m.id, var_name: m.varName, reason: (err as Error).message });
      continue;
    }
    const placeholder = m.secret ? makePlaceholder() : null;
    entries.push(`${m.varName}=${placeholder ?? value}`);
    containerRows.push({ mapping_id: m.id, uid: m.uid, placeholder });
  }

  return { entries, containerRows, skipped };
}

/**
 * The mappings that apply to a container: every enabled global one, followed by
 * the non-global ones the operator picked at start time.
 */
export function applicableEnvMappings(selectedIds: number[] = []): HostEnvMapping[] {
  const selected = new Set(selectedIds);
  const all = listEnvMappings().filter(m => m.enabled);
  return [
    ...all.filter(m => m.global),
    ...all.filter(m => !m.global && selected.has(m.id)),
  ];
}

/**
 * Everything the container start needs: the Env entries to inject, plus the
 * bookkeeping that lets the proxy later resolve the placeholders back. Always
 * writes the bookkeeping, also when empty, so a container name reused for a new
 * container does not inherit the previous container's placeholders.
 */
export function buildEnvMappings(containerName: string, selectedIds: number[] = []): string[] {
  const { entries, containerRows, skipped } = buildEnvEntries(
    applicableEnvMappings(selectedIds),
    getEnvSecret,
  );
  for (const s of skipped) {
    console.warn(`[env-mappings] skipping mapping #${s.id} ('${s.var_name}'): ${s.reason}`);
  }
  setContainerEnvMappings(containerName, containerRows);
  return entries;
}
