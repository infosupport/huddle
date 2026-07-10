import { ErrorHandler, Injectable } from '@angular/core';

// ── Forward frontend errors to the gateway (→ container logs) ────────────────
// Runtime errors in the browser are otherwise invisible when debugging a
// running huddle container. Everything goes through POST /api/client-log, which
// puts them on the gateway's stderr (visible in `docker logs huddle`).

// The same message at most once per 10s — prevents log loops when an error
// keeps recurring in a render or change-detection cycle.
const seen = new Map<string, number>();

export function sendClientLog(level: 'error' | 'warn' | 'info', message: string, stack?: string): void {
  try {
    const key = `${level}:${message}`;
    const now = Date.now();
    if (now - (seen.get(key) ?? 0) < 10_000) return;
    seen.set(key, now);
    fetch('/api/client-log', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      keepalive: true,
      body: JSON.stringify({
        level,
        message: String(message).slice(0, 2000),
        stack: stack ? String(stack).slice(0, 6000) : undefined,
        url: location.href,
      }),
    }).catch(() => { /* logging must never cause errors itself */ });
  } catch { /* same */ }
}

@Injectable()
export class RemoteErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    // Always also to the browser console (keep the default behavior).
    console.error(error);
    const e = error as { message?: string; stack?: string } | null;
    sendClientLog('error', e?.message ?? String(error), e?.stack);
  }
}

// Catches what bypasses Angular's ErrorHandler (script errors, promises).
export function installGlobalClientLogging(): void {
  window.addEventListener('error', (ev) => {
    sendClientLog('error', ev.message || 'window.onerror', (ev.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as { message?: string; stack?: string } | null;
    sendClientLog('error', `unhandledrejection: ${r?.message ?? String(ev.reason)}`, r?.stack);
  });
}
