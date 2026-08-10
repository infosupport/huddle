import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { bold, green, cyan, dim, yellow, red } from './utils';
import { resolveRuntime } from './runtime';
import { INTERNAL_NET, HOST_SOCKET_DIR } from './init';

// ─────────────────────────────────────────────────────────────────────────────
// Conventions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Label a developer puts on ONE network in their existing docker-compose.yml to
 * mark it as "the network whose services should run behind Huddle". Every
 * service attached to that network gets the proxy env, the CA path and (opt-in)
 * the filtered Docker socket injected via the generated override — the
 * developer never hand-writes any of that.
 */
export const HUDDLE_NETWORK_LABEL = 'huddle.network';

/**
 * Network key added by the override that points at Huddle's shared internal
 * network. Marked services are additionally attached to it so they reach the
 * Huddle proxy; their own (internal) network is left untouched. Renamed if the
 * project already uses this key.
 */
export const HUDDLE_NET_KEY = 'huddle';

/** Default absolute path the CA is fetched to (see the printed postCreateCommand). */
export const DEFAULT_CA_PATH = '/home/vscode/.huddle-ca.crt';

/** Default filename for the generated Compose override. */
export const OVERRIDE_FILENAME = 'docker-compose.huddle.yml';

export interface OverrideOptions {
  /** Where the CA ends up in the container (NODE_EXTRA_CA_CERTS). */
  caPath?: string;
  /** Also inject the filtered Docker socket mount + DOCKER_HOST (opt-in). */
  dockerSocket?: boolean;
  /** Network key/name that points at Huddle's internal net (defaults to HUDDLE_NET_KEY). */
  huddleNetKey?: string;
  /** Name of Huddle's shared internal network (defaults to INTERNAL_NET). */
  internalNet?: string;
  /** Host directory holding the per-container sockets (defaults to HOST_SOCKET_DIR). */
  socketDir?: string;
}

export interface AnalysisResult {
  /** Key of the network marked with `huddle.network`. */
  markedNetwork: string;
  /** Services (by compose key) attached to the marked network. */
  services: string[];
  /** The generated Compose override object (dump with dumpYaml). */
  override: ComposeDoc;
  /** Non-fatal advisories (e.g. a service without container_name). */
  warnings: string[];
  /**
   * Security-critical problems that leave the service with a direct internet
   * path (marked network not internal, or a second non-internal network). The
   * override is still generated, but `runMigrate` refuses to write it unless
   * `--force` is given — reporting success here would be misleading.
   */
  blockers: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Egress wiring that gets injected (mirrors the working .devcontainer example,
// which issue-66-reply.md calls the source of truth). `huddle` stays in NO_PROXY
// so the direct CA fetch to huddle:24842 does not loop through the proxy on :80.
// ─────────────────────────────────────────────────────────────────────────────

export function huddleProxyEnv(caPath: string, dockerSocket: boolean): Record<string, string> {
  const env: Record<string, string> = {
    HTTP_PROXY: 'http://huddle:80',
    HTTPS_PROXY: 'http://huddle:80',
    http_proxy: 'http://huddle:80',
    https_proxy: 'http://huddle:80',
    NO_PROXY: 'localhost,127.0.0.1,::1,[::1],huddle',
    no_proxy: 'localhost,127.0.0.1,::1,[::1],huddle',
    NODE_EXTRA_CA_CERTS: caPath,
  };
  if (dockerSocket) {
    // The container talks to Huddle's filtered socket, never the raw engine.
    env.DOCKER_HOST = 'unix:///var/run/huddle/docker.sock';
  }
  return env;
}

// ─────────────────────────────────────────────────────────────────────────────
// Marked-network detection + override generation (pure — unit-tested)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComposeDoc {
  services?: Record<string, ComposeService>;
  networks?: Record<string, ComposeNetwork | null>;
  [k: string]: unknown;
}

export interface ComposeService {
  container_name?: string;
  networks?: string[] | Record<string, unknown | null>;
  environment?: string[] | Record<string, unknown>;
  volumes?: string[];
  [k: string]: unknown;
}

export interface ComposeNetwork {
  internal?: unknown;
  labels?: string[] | Record<string, unknown>;
  [k: string]: unknown;
}

/** YAML/Compose truthiness: accepts booleans and the usual string spellings. */
function isTruthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === 'string') return ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase());
  return false;
}

/** Reads a `labels:` block (map form or `- key=value` list form) into a plain map. */
export function normalizeLabels(labels: ComposeNetwork['labels']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!labels) return out;
  if (Array.isArray(labels)) {
    for (const entry of labels) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq >= 0) out[entry.slice(0, eq).trim()] = entry.slice(eq + 1).trim();
      else out[entry.trim()] = '';
    }
  } else {
    for (const [k, v] of Object.entries(labels)) out[k] = v == null ? '' : String(v);
  }
  return out;
}

/** Network keys of a service (map form or list form) as a plain array. */
export function serviceNetworkKeys(service: ComposeService): string[] {
  const nets = service.networks;
  if (!nets) return [];
  if (Array.isArray(nets)) return nets.filter((n): n is string => typeof n === 'string');
  return Object.keys(nets);
}

/** All network keys carrying the `huddle.network` label. */
export function findMarkedNetworks(compose: ComposeDoc): string[] {
  const networks = compose.networks ?? {};
  return Object.entries(networks)
    .filter(([, def]) => def && isTruthy(normalizeLabels((def as ComposeNetwork).labels)[HUDDLE_NETWORK_LABEL]))
    .map(([key]) => key);
}

/**
 * Core generator: given a parsed compose object, produce the Compose OVERRIDE
 * that wires every service on the marked network behind Huddle. Purely additive
 * — it never rewrites the user's own network (which would clash with a base
 * `internal: true` when Compose merges the two files), it only ADDS a second
 * `huddle` network (external → Huddle's internal net) plus env/CA/socket.
 *
 * Throws on hard configuration errors (no/ambiguous marked network); collects
 * softer problems in `warnings`.
 */
// Exactly one network must carry the huddle.network label. Zero or more than one
// is a hard error the operator must resolve before a safe override can be built.
function resolveMarkedNetwork(compose: ComposeDoc): string {
  const marked = findMarkedNetworks(compose);
  if (marked.length === 0) {
    throw new Error(
      `No network marked with \`${HUDDLE_NETWORK_LABEL}: "true"\` was found. ` +
        'Add that label to the (internal) network your services use.',
    );
  }
  if (marked.length > 1) {
    throw new Error(`Multiple networks marked with \`${HUDDLE_NETWORK_LABEL}\`: ${marked.join(', ')}. Mark exactly one.`);
  }
  return marked[0];
}

// Pick a key for the injected egress network that collides with NOTHING: not an
// existing network, and not the marked network itself (otherwise the two keys in
// the service's `networks` map collapse into one and the egress net is silently
// never added). Keep suffixing until it is unique.
function pickHuddleNetKey(compose: ComposeDoc, markedNetwork: string, preferred: string): string {
  const taken = new Set(Object.keys(compose.networks ?? {}));
  taken.add(markedNetwork);
  let key = preferred;
  if (taken.has(key)) {
    let n = 0;
    do {
      key = n === 0 ? `${HUDDLE_NET_KEY}-egress` : `${HUDDLE_NET_KEY}-egress-${n}`;
      n++;
    } while (taken.has(key));
  }
  return key;
}

interface InjectContext {
  markedNetwork: string;
  huddleNetKey: string;
  caPath: string;
  socketDir: string;
  dockerSocket: boolean;
}

// Build the override entry for a single service: keep it on the marked network,
// add the Huddle egress network + proxy env, and (with --docker-socket) mount the
// filtered Docker socket. Any second, non-internal network is flagged as a
// blocker — it would be an unfiltered route out that bypasses Huddle.
function buildInjectedService(
  svc: ComposeService,
  name: string,
  compose: ComposeDoc,
  ctx: InjectContext,
  warnings: string[],
  blockers: string[],
): ComposeService {
  for (const netKey of serviceNetworkKeys(svc)) {
    if (netKey === ctx.markedNetwork) continue;
    const def = (compose.networks?.[netKey] ?? {}) as ComposeNetwork;
    if (!isTruthy(def.internal)) {
      blockers.push(
        `Service "${name}" is also on network "${netKey}", which is not internal. ` +
          'Remove it or make it internal — a second non-internal network bypasses Huddle.',
      );
    }
  }

  const injected: ComposeService = {
    // Keep the service on its own network AND add the Huddle egress network.
    // Map form is robust regardless of Compose's list merge semantics.
    networks: { [ctx.markedNetwork]: null, [ctx.huddleNetKey]: null },
    environment: huddleProxyEnv(ctx.caPath, ctx.dockerSocket),
  };

  if (ctx.dockerSocket) {
    const cn = svc.container_name;
    if (!cn) {
      warnings.push(
        `Service "${name}" has no \`container_name\`, so the filtered Docker socket cannot be mounted ` +
          'at a stable path. Set a fixed container_name or drop --docker-socket for this service.',
      );
    } else {
      injected.volumes = [`${ctx.socketDir}/${cn}:/var/run/huddle`];
    }
  }

  return injected;
}

export function buildOverride(compose: ComposeDoc, opts: OverrideOptions = {}): AnalysisResult {
  const caPath = opts.caPath ?? DEFAULT_CA_PATH;
  const internalNet = opts.internalNet ?? INTERNAL_NET;
  const socketDir = opts.socketDir ?? HOST_SOCKET_DIR;
  const warnings: string[] = [];
  const blockers: string[] = [];

  const markedNetwork = resolveMarkedNetwork(compose);
  const huddleNetKey = pickHuddleNetKey(compose, markedNetwork, opts.huddleNetKey ?? HUDDLE_NET_KEY);

  // Guardrail: the marked network must be internal, otherwise it already has a
  // route to the internet and would bypass the firewall/proxy.
  const markedDef = (compose.networks?.[markedNetwork] ?? {}) as ComposeNetwork;
  if (!isTruthy(markedDef.internal)) {
    blockers.push(
      `Network "${markedNetwork}" is not marked \`internal: true\`. It must be internal, ` +
        'otherwise services can reach the internet directly and bypass Huddle.',
    );
  }

  const services = Object.entries(compose.services ?? {})
    .filter(([, svc]) => serviceNetworkKeys(svc as ComposeService).includes(markedNetwork))
    .map(([key]) => key);

  if (services.length === 0) {
    warnings.push(`No service is attached to the marked network "${markedNetwork}"; the override wires nothing.`);
  }

  const ctx: InjectContext = { markedNetwork, huddleNetKey, caPath, socketDir, dockerSocket: !!opts.dockerSocket };
  const overrideServices: Record<string, ComposeService> = {};
  for (const name of services) {
    const svc = (compose.services?.[name] ?? {}) as ComposeService;
    overrideServices[name] = buildInjectedService(svc, name, compose, ctx, warnings, blockers);
  }

  const override: ComposeDoc = {
    services: overrideServices,
    networks: {
      // external: true → reuse the network `huddle init` already created; do not
      // create or take ownership of it here.
      [huddleNetKey]: { external: true, name: internalNet } as unknown as ComposeNetwork,
    },
  };

  return { markedNetwork, services, override, warnings, blockers };
}

// ─────────────────────────────────────────────────────────────────────────────
// Minimal YAML support
//
// The CLI ships with zero runtime dependencies (see cli/package.json), so we do
// not pull in a YAML library. This is a pragmatic, indentation-based reader for
// the subset docker-compose files use (nested maps, block/flow sequences,
// `key=value` label lists, quoted/plain scalars). It is NOT a general YAML
// parser: anchors, multi-line block scalars and complex flow nesting are out of
// scope. Both functions are unit-tested.
// ─────────────────────────────────────────────────────────────────────────────

interface Line {
  indent: number;
  text: string;
}

function tokenize(input: string): Line[] {
  const out: Line[] = [];
  for (const rawLine of input.split(/\r?\n/)) {
    const stripped = stripComment(rawLine);
    if (stripped.trim() === '') continue;
    const indent = stripped.length - stripped.trimStart().length;
    out.push({ indent, text: stripped.trim() });
  }
  return out;
}

/** Removes a `# comment`, but never one that sits inside quotes or a `://` URL. */
function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === '#' && !inSingle && !inDouble && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

// Shared depth cap for both the reader (parseNode ↔ parseMapping/parseSequence)
// and the writer (dumpYaml ↔ dumpInlineOrBlock). Real compose trees are only a
// few levels deep; a much larger cap still forecloses stack-exhaustion (CWE-674).
const MAX_YAML_DEPTH = 64;

function unsupportedYaml(feature: string): Error {
  return new Error(
    `the compose file uses ${feature}, which \`huddle migrate\`'s built-in YAML reader does ` +
      'not support and would mis-parse (risking a dropped, un-filtered service). Inline or ' +
      'quote it, or flatten the file first with `docker compose config`, then re-run `huddle migrate`.',
  );
}

// A YAML block-scalar header: `|` or `>` followed by an optional indentation
// indicator (1-9) and/or chomping indicator (+/-), each at most once, in either
// order. Anchored so plain scalars that merely start with `>`/`|` (e.g. `>=1.0`)
// do not match.
const BLOCK_SCALAR_HEADER = /^[|>]([1-9][+-]?|[+-][1-9]?)?$/;

// The value carried by a tokenized line: a mapping value (after `key:`), a
// sequence-item value (after `- `), or the bare line.
function lineValue(text: string): string {
  const colon = findKeyColon(text);
  if (colon >= 0) return text.slice(colon + 1).trim();
  if (isSeqItem(text)) return text.replace(/^-\s*/, '').trim();
  return text;
}

// Fail-closed on YAML features the indentation reader below cannot represent
// (finding #9). Block scalars (`|`/`>`), anchors/aliases (`&`/`*`) and merge keys
// (`<<`) are silently mis-parsed — a block scalar's indented body is read as real
// structure, which can swallow the next service and drop it from the generated
// override (leaving it with an unfiltered route out). Detect them up front and
// refuse with a clear, actionable error instead of guessing.
function rejectUnsupportedYaml(lines: Line[]): void {
  for (const { text } of lines) {
    if (/^<<\s*:/.test(text)) throw unsupportedYaml('a merge key (`<<`)');
    const value = lineValue(text);
    if (BLOCK_SCALAR_HEADER.test(value)) throw unsupportedYaml('a block scalar (`|` or `>`)');
    // Match an anchor/alias in any NODE position: at the value start OR right
    // after a flow opener/separator (`[`, `{`, `,`) or a flow-map colon — so
    // `networks: [*net]` and `{n: *net}` are caught too, not just `x: *net`.
    // The trailing name char keeps this off scalar `&`/`*` (env URLs, globs like
    // `*.log`), which never start an anchor/alias name.
    if (/(^|[[{,:]\s*)&[A-Za-z0-9_]/.test(value)) throw unsupportedYaml('a YAML anchor (`&`)');
    if (/(^|[[{,:]\s*)\*[A-Za-z0-9_]/.test(value)) throw unsupportedYaml('a YAML alias (`*`)');
  }
}

export function parseYaml(input: string): ComposeDoc {
  const lines = tokenize(input);
  rejectUnsupportedYaml(lines);
  let pos = 0;

  // Cap the mutual recursion (parseNode ↔ parseMapping/parseSequence) so a deeply
  // nested (malformed or hostile) compose file cannot exhaust the stack (CWE-674).
  function parseNode(indent: number, depth: number): unknown {
    if (depth > MAX_YAML_DEPTH) {
      throw new Error(`YAML nesting exceeds ${MAX_YAML_DEPTH} levels; refusing to parse this compose file.`);
    }
    if (pos >= lines.length || lines[pos].indent < indent) return null;
    return isSeqItem(lines[pos].text) ? parseSequence(indent, depth) : parseMapping(indent, depth);
  }

  function parseMapping(indent: number, depth: number): Record<string, unknown> {
    const map: Record<string, unknown> = {};
    while (pos < lines.length && lines[pos].indent === indent && !isSeqItem(lines[pos].text)) {
      const { text } = lines[pos];
      const colon = findKeyColon(text);
      if (colon < 0) {
        // Not a mapping line where we expected one — stop and let the caller cope.
        break;
      }
      const key = unquote(text.slice(0, colon).trim());
      const rest = text.slice(colon + 1).trim();
      pos++;
      if (rest !== '') {
        map[key] = parseScalar(rest);
      } else if (pos < lines.length && lines[pos].indent > indent) {
        map[key] = parseNode(lines[pos].indent, depth + 1);
      } else {
        map[key] = null;
      }
    }
    return map;
  }

  function parseSequence(indent: number, depth: number): unknown[] {
    const arr: unknown[] = [];
    while (pos < lines.length && lines[pos].indent === indent && isSeqItem(lines[pos].text)) {
      const afterDash = lines[pos].text.replace(/^-\s*/, '');
      if (afterDash === '') {
        pos++;
        arr.push(pos < lines.length && lines[pos].indent > indent ? parseNode(lines[pos].indent, depth + 1) : null);
      } else if (findKeyColon(afterDash) >= 0) {
        // Inline map item: "- key: value". Re-interpret the remainder as a
        // mapping that starts at a virtual indent past the dash.
        const virtualIndent = indent + (lines[pos].text.length - afterDash.length);
        lines[pos] = { indent: virtualIndent, text: afterDash };
        arr.push(parseMapping(virtualIndent, depth + 1));
      } else {
        arr.push(parseScalar(afterDash));
        pos++;
      }
    }
    return arr;
  }

  const root = parseNode(lines.length ? lines[0].indent : 0, 0);
  return (root && typeof root === 'object' ? root : {}) as ComposeDoc;
}

function isSeqItem(text: string): boolean {
  return text === '-' || text.startsWith('- ');
}

/** Index of the `key:` colon (the first colon followed by space or end-of-line). */
function findKeyColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === ':' && !inSingle && !inDouble && (i + 1 === text.length || text[i + 1] === ' ')) {
      return i;
    }
  }
  return -1;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (value.startsWith('[') && value.endsWith(']')) {
    return splitFlow(value.slice(1, -1)).map((v) => parseScalar(v));
  }
  if (value.startsWith('{') && value.endsWith('}')) {
    const map: Record<string, unknown> = {};
    for (const part of splitFlow(value.slice(1, -1))) {
      const colon = findKeyColon(part);
      // Fail closed: a flow-map entry we cannot split into `key: value` (e.g. the
      // compact `{networks:[dev, public]}` form, where the colon has no following
      // space) must NOT be silently dropped — that would omit the service from the
      // generated override and leave it on its original, un-filtered network.
      if (colon < 0) throw unsupportedYaml('a compact flow-mapping entry (`{key:value}` without a space after the colon)');
      map[unquote(part.slice(0, colon).trim())] = parseScalar(part.slice(colon + 1).trim());
    }
    return map;
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return unquote(value);
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null' || value === '~' || value === '') return null;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  return value;
}

/** Splits a flow collection body on top-level commas (ignores commas in quotes/brackets). */
function splitFlow(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inSingle = false;
  let inDouble = false;
  let current = '';
  for (const c of body) {
    if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '"' && !inSingle) inDouble = !inDouble;
    if (!inSingle && !inDouble) {
      if (c === '[' || c === '{') depth++;
      else if (c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        if (current.trim() !== '') parts.push(current.trim());
        current = '';
        continue;
      }
    }
    current += c;
  }
  if (current.trim() !== '') parts.push(current.trim());
  return parts;
}

function unquote(value: string): string {
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

/** Emits an object as YAML using the subset the reader understands. */
export function dumpYaml(obj: unknown, indent = 0): string {
  // `indent` doubles as the recursion depth (dumpYaml ↔ dumpInlineOrBlock each
  // step it by one). Cap it so a pathologically nested object cannot exhaust the
  // stack (CWE-674) — mirrors the MAX_DEPTH guard on the parse side. Legitimate
  // compose trees are only a few levels deep.
  if (indent > MAX_YAML_DEPTH) {
    throw new Error(`YAML nesting exceeds ${MAX_YAML_DEPTH} levels; refusing to emit this override.`);
  }
  const pad = '  '.repeat(indent);
  if (obj === null || obj === undefined) return '';
  if (Array.isArray(obj)) {
    if (obj.length === 0) return `${pad}[]\n`;
    return obj.map((item) => `${pad}- ${dumpInlineOrBlock(item, indent)}`).join('');
  }
  if (typeof obj === 'object') {
    const entries = Object.entries(obj as Record<string, unknown>);
    if (entries.length === 0) return `${pad}{}\n`;
    let out = '';
    for (const [key, value] of entries) {
      // Keys can come straight from an untrusted compose file (service/network
      // names). Emit them through the same quote/escape path as scalar values so
      // a crafted key (`a: b`, `evil #comment`, or one containing a newline)
      // cannot break out of its line and inject sibling compose directives.
      const k = formatScalar(key);
      if (value === null || value === undefined) {
        out += `${pad}${k}:\n`;
      } else if (typeof value === 'object') {
        const isEmpty = Array.isArray(value) ? value.length === 0 : Object.keys(value).length === 0;
        if (isEmpty) {
          out += `${pad}${k}: ${Array.isArray(value) ? '[]' : '{}'}\n`;
        } else {
          out += `${pad}${k}:\n${dumpYaml(value, indent + 1)}`;
        }
      } else {
        out += `${pad}${k}: ${formatScalar(value)}\n`;
      }
    }
    return out;
  }
  return `${pad}${formatScalar(obj)}\n`;
}

function dumpInlineOrBlock(item: unknown, indent: number): string {
  if (item !== null && typeof item === 'object') {
    // Render the nested structure, then splice its first line onto the dash.
    const block = dumpYaml(item, indent + 1);
    return block.trimStart();
  }
  return `${formatScalar(item)}\n`;
}

function formatScalar(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value);
  const str = String(value);
  if (needsQuote(str)) {
    // Escape backslash first, then quotes, then control chars — otherwise a raw
    // newline/CR/tab would terminate the current line and let attacker-supplied
    // text be reparsed as fresh YAML structure.
    const escaped = str
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return str;
}

function needsQuote(str: string): boolean {
  if (str === '') return true;
  if (/^(true|false|null|~|yes|no|on|off)$/i.test(str)) return true;
  if (/^-?\d+(\.\d+)?$/.test(str)) return true;
  if (/[:#[\]{}&*!|>%@`,"']/.test(str)) return true;
  if (/[\n\r\t]/.test(str)) return true;
  if (/^\s|\s$/.test(str)) return true;
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI command
// ─────────────────────────────────────────────────────────────────────────────

export interface MigrateOptions {
  path?: string;
  caPath?: string;
  dockerSocket?: boolean;
  output?: string;
  force?: boolean;
  runtime?: string;
}

/** Resolves the docker-compose file for a project directory (or an explicit file). */
export function resolveComposeFile(target?: string): string {
  const resolved = path.resolve(target ?? process.cwd());
  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Path does not exist: ${resolved}`);
  }
  if (stat.isFile()) return resolved;
  for (const name of ['docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']) {
    const candidate = path.join(resolved, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`No docker-compose file found in ${resolved}`);
}

/** Best-effort check that Huddle's internal network already exists. */
function huddleNetworkExists(internalNet: string, runtime?: string): boolean | undefined {
  try {
    const rt = resolveRuntime(runtime);
    // execFileSync (arg array, no shell) instead of execSync: no shell is
    // involved, so there is no command-injection surface via the runtime/network name.
    execFileSync(rt.name, ['network', 'inspect', internalNet], { stdio: 'ignore' });
    return true;
  } catch {
    return undefined; // runtime unavailable or network missing — don't block.
  }
}

export async function runMigrate(opts: MigrateOptions): Promise<void> {
  const composeFile = resolveComposeFile(opts.path);
  const projectDir = path.dirname(composeFile);
  const caPath = opts.caPath ?? DEFAULT_CA_PATH;

  console.log(`${bold('Migrating')} ${cyan(composeFile)} to run behind Huddle...\n`);

  const raw = fs.readFileSync(composeFile, 'utf8');
  let compose: ComposeDoc;
  try {
    compose = parseYaml(raw);
  } catch (err) {
    throw new Error(`Could not parse ${composeFile}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const result = buildOverride(compose, { caPath, dockerSocket: opts.dockerSocket });

  console.log(`Marked network:  ${bold(result.markedNetwork)}`);
  console.log(`Wired services:  ${result.services.length ? result.services.map(bold).join(', ') : dim('(none)')}`);
  for (const w of result.warnings) console.log(yellow(`[!] ${w}`));
  for (const b of result.blockers) console.log(red(`[x] ${b}`));
  console.log();

  // Fail closed: these blockers mean the migrated service would keep a direct
  // route to the internet, so writing the override and reporting success would
  // be misleading. Refuse unless the operator explicitly overrides with --force.
  if (result.blockers.length > 0 && !opts.force) {
    throw new Error(
      `Refusing to write the override: the migration would leave a direct internet path ` +
        `(${result.blockers.length} blocker(s) above). Fix your compose file, or re-run with ` +
        `--force to generate it anyway.`,
    );
  }

  const overrideText =
    '# Generated by `huddle migrate` — do NOT edit by hand; re-run the command instead.\n' +
    '# Merge this on top of your docker-compose.yml so the marked services reach the\n' +
    '# internet only through the Huddle proxy. Your own compose file stays untouched.\n' +
    dumpYaml(result.override);

  const outPath = opts.output ? path.resolve(opts.output) : path.join(projectDir, OVERRIDE_FILENAME);
  if (fs.existsSync(outPath) && !opts.force) {
    throw new Error(`${outPath} already exists. Re-run with --force to overwrite.`);
  }
  fs.writeFileSync(outPath, overrideText);
  console.log(green(`[OK] Wrote override: ${outPath}`));
  console.log();

  // Best-effort readiness hint.
  if (huddleNetworkExists(INTERNAL_NET, opts.runtime) === undefined) {
    console.log(yellow(`[!] Could not confirm the "${INTERNAL_NET}" network exists. Run \`huddle init\` first.`));
    console.log();
  }

  printNextSteps(composeFile, outPath, caPath, !!opts.dockerSocket);
}

function printNextSteps(composeFile: string, outPath: string, caPath: string, dockerSocket: boolean): void {
  const composeBase = path.basename(composeFile);
  const overrideBase = path.basename(outPath);

  console.log(bold('Next steps (this command only GENERATED the override — it did not start anything):'));
  console.log();
  console.log('  1. Make sure Huddle is running:');
  console.log(cyan('       huddle init'));
  console.log();
  console.log('  2. Fetch the Huddle CA inside the container. Add to your devcontainer.json:');
  console.log(
    cyan(
      `       "postCreateCommand": "curl -fsS http://huddle:24842/api/tls/ca.crt -o ${caPath} || echo 'CA not fetched (HTTPS tunnelled, no MITM)'"`,
    ),
  );
  console.log(dim(`     (Adjust ${caPath} to your remoteUser's home if it differs; pass --ca-path to change it.)`));
  console.log();
  console.log('  3. Reference the override so the IDE merges it. In devcontainer.json:');
  console.log(cyan(`       "dockerComposeFile": ["${composeBase}", "${overrideBase}"]`));
  console.log(dim('     Or start it yourself:'));
  console.log(cyan(`       docker compose -f ${composeBase} -f ${overrideBase} up -d`));
  console.log();
  if (dockerSocket) {
    console.log(yellow('  Note (--docker-socket): the socket mount is GENERATED but NOT yet served.'));
    console.log(
      dim(
        '     Huddle does not yet pre-provision the per-container filtered socket for IDE-started\n' +
          '     containers (issue #66 follow-up). Until it does, the mount source will not exist and\n' +
          '     DOCKER_HOST will point at a missing socket. Only enable this once that lands.',
      ),
    );
    console.log();
  }
  console.log(dim('See docs/migrate-devcontainers.md for the full guide and the marked-network convention.'));
}
