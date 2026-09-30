import { operatorToken } from './config';
import { DEFAULT_NODE_PORT, nodeProbeUrls } from './node';

// Huddle Node, on the host, on loopback. Not 3000 and not a container address:
// after the Node/Gateway split the API this talks to is the host process, and
// the gateway container has no API at all (docs/ADR-huddle-node-split.md).
//
// The loopback LITERALS, not `localhost` — nodeProbeUrls() is where that reason
// is written down. Both are kept, not just the first: Node binds one address and
// which one depends on the host, so the only honest default is to try each and
// keep whichever answers.
//
// An explicit --url or HUDDLE_URL replaces the list entirely — the operator named
// an address, and silently talking to a different one would be worse than failing.
//
// HUDDLE_PORT, when set, still has to flow through here: it is the same env var
// `huddle init`/`huddle node` read for a custom port (init.ts's HOST_PORT), so a
// custom port that stuck for the command that started Huddle Node must also
// stick for every command that talks to it afterwards — otherwise every command
// after `HUDDLE_PORT=<n> huddle init` probes the default port and never finds it.
const port = process.env.HUDDLE_PORT?.trim() || DEFAULT_NODE_PORT;
let candidates: string[] = (process.env.HUDDLE_URL
  ? [process.env.HUDDLE_URL]
  : nodeProbeUrls(port)
).map(normalizeBaseUrl);
let baseUrl = candidates[0];

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export function setBaseUrl(url: string): void {
  candidates = [normalizeBaseUrl(url)];
  baseUrl = candidates[0];
}

/**
 * The first candidate that answers, remembered for the rest of the process.
 *
 * A refused connection is not a failure here — it is how we find out which
 * loopback address Node bound. Anything the server actually answers, including a
 * 500, ends the search: it proves we found Huddle.
 */
async function reachHuddle(path: string, init: RequestInit): Promise<Response> {
  const order = [baseUrl, ...candidates.filter((c) => c !== baseUrl)];
  let detail = '';
  for (const candidate of order) {
    try {
      const res = await fetch(`${candidate}${path}`, init);
      baseUrl = candidate;
      return res;
    } catch (err) {
      detail = err instanceof Error ? err.message : String(err);
    }
  }
  throw new ApiError(`Cannot reach Huddle API at ${order.join(' or ')}: ${detail}`);
}

export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Operator-auth: stuur het token als Bearer mee zodat de CLI de control-plane
  // -auth passeert. Zonder token krijgen we een 401 met een duidelijke hint.
  const token = operatorToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  const res = await reachHuddle(path, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  const raw = await res.text();
  const payload = parsePayload(raw);

  if (!res.ok) {
    if (res.status === 401) {
      throw new ApiError(
        `${method} ${path} -> 401: operator authentication required. ` +
        `Set HUDDLE_OPERATOR_TOKEN (find it in the huddle container logs, or re-run \`huddle init\`).`,
        401,
      );
    }
    const msg = errorMessage(payload) ?? res.statusText;
    throw new ApiError(`${method} ${path} -> ${res.status}: ${msg}`, res.status);
  }

  return payload as T;
}

export const get = <T>(path: string) => apiCall<T>('GET', path);
export const post = <T>(path: string, body: unknown) => apiCall<T>('POST', path, body);
export const put = <T>(path: string, body: unknown) => apiCall<T>('PUT', path, body);
export const del = <T>(path: string) => apiCall<T>('DELETE', path);

function normalizeBaseUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed) throw new Error('Huddle URL must not be empty');
  return trimmed.replace(/\/+$/, '');
}

function parsePayload(raw: string): unknown {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function errorMessage(payload: unknown): string | undefined {
  if (!payload || typeof payload !== 'object') return typeof payload === 'string' ? payload : undefined;
  const obj = payload as { error?: unknown; message?: unknown };
  if (typeof obj.message === 'string') return obj.message;
  if (typeof obj.error === 'string') return obj.error;
  return undefined;
}
