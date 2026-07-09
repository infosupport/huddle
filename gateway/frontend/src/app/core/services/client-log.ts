import { ErrorHandler, Injectable } from '@angular/core';

// ── Frontend-fouten doorsturen naar de gateway (→ container logs) ────────────
// Runtime-fouten in de browser zijn anders onzichtbaar bij het debuggen van een
// draaiende huddle-container. Alles gaat via POST /api/client-log, dat ze op
// stderr van de gateway zet (zichtbaar in `docker logs huddle`).

// Zelfde melding max. 1× per 10s — voorkomt log-loops wanneer een fout in een
// render- of change-detection-cyclus blijft terugkomen.
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
    }).catch(() => { /* logging mag nooit zelf fouten veroorzaken */ });
  } catch { /* idem */ }
}

@Injectable()
export class RemoteErrorHandler implements ErrorHandler {
  handleError(error: unknown): void {
    // Altijd óók naar de browser-console (default-gedrag behouden).
    console.error(error);
    const e = error as { message?: string; stack?: string } | null;
    sendClientLog('error', e?.message ?? String(error), e?.stack);
  }
}

// Vangt wat buiten Angular's ErrorHandler om gaat (script-fouten, promises).
export function installGlobalClientLogging(): void {
  window.addEventListener('error', (ev) => {
    sendClientLog('error', ev.message || 'window.onerror', (ev.error as Error | undefined)?.stack);
  });
  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as { message?: string; stack?: string } | null;
    sendClientLog('error', `unhandledrejection: ${r?.message ?? String(ev.reason)}`, r?.stack);
  });
}
