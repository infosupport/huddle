import { operatorToken } from './config';

let baseUrl = normalizeBaseUrl(process.env.HUDDLE_URL ?? 'http://localhost:3000');

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
  baseUrl = normalizeBaseUrl(url);
}

export async function apiCall<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  // Operator-auth: stuur het token als Bearer mee zodat de CLI de control-plane
  // -auth passeert. Zonder token krijgen we een 401 met een duidelijke hint.
  const token = operatorToken();
  if (token) headers['authorization'] = `Bearer ${token}`;

  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ApiError(`Cannot reach Huddle API at ${baseUrl}: ${detail}`);
  }

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
