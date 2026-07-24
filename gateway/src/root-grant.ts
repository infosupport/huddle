// Root-grant lifecycle: geeft de default `vscode`-user tijdelijk passwordless
// sudo, als vervanging van de aparte `noot`-user + wachtwoord.
//
// Anders dan de docker-grant (die per request passief wordt gecheckt) is sudo
// STATEFUL in de container: het sudoers-bestand blijft staan tot we het actief
// verwijderen. Daarom plannen we een revoke-timer op de vervaltijd.
import {
  setRootGrant,
  getRootGrant,
  deleteRootGrant,
  getAllRootGrants,
} from './db';
import { grantVscodeRoot, revokeVscodeRoot } from './docker';

const timers = new Map<string, NodeJS.Timeout>();
// setTimeout-delays boven ~24.8 dagen overflowen een 32-bit int; clamp erop en
// herplan dan opnieuw.
const MAX_DELAY_MS = 2_000_000_000;

function clearTimer(container: string): void {
  const t = timers.get(container);
  if (t) { clearTimeout(t); timers.delete(container); }
}

function scheduleRevoke(container: string, until: number): void {
  clearTimer(container);
  const delay = until * 1000 - Date.now();
  if (delay <= 0) { expireIfDue(container); return; }
  const t = setTimeout(() => expireIfDue(container), Math.min(delay, MAX_DELAY_MS));
  if (typeof t.unref === 'function') t.unref();
  timers.set(container, t);
}

// Timer-driven expiry: re-read the DB (the grant may have been EXTENDED since
// this timer was armed — e.g. an extend that landed during a prior revoke's
// await). Only revoke if it is genuinely still past-due.
function expireIfDue(container: string): void {
  const g = getRootGrant(container);
  if (!g) { clearTimer(container); return; }        // already revoked/deleted
  if (g.until * 1000 - Date.now() > 0) {
    scheduleRevoke(container, g.until);             // extended → keep, re-arm
    return;
  }
  void doRevoke(container);
}

// Unconditional revoke (explicit portal revoke, or a confirmed expiry).
async function doRevoke(container: string): Promise<void> {
  clearTimer(container);
  deleteRootGrant(container);
  await revokeVscodeRoot(container);
}

// Ken een tijdgebonden root-grant toe en pas hem toe in de container.
export async function applyRootGrant(container: string, minutes: number): Promise<number> {
  const until = Math.floor(Date.now() / 1000) + minutes * 60;
  setRootGrant(container, until);
  await grantVscodeRoot(container);
  scheduleRevoke(container, until);
  return until;
}

export async function revokeRootGrant(container: string): Promise<void> {
  await doRevoke(container);
}

export function rootGrantStatus(container: string): { until: number } | null {
  const g = getRootGrant(container);
  if (!g) return null;
  return { until: g.until };
}

// Bij Huddle-herstart: verlopen grants intrekken, actieve grants opnieuw
// toepassen (de container kan opnieuw zijn opgebouwd) en hun timer herplannen.
export async function initRootGrants(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const [container, { until }] of Object.entries(getAllRootGrants())) {
    if (until <= now) {
      await doRevoke(container);
      continue;
    }
    try { await grantVscodeRoot(container); } catch { /* container mogelijk weg */ }
    scheduleRevoke(container, until);
  }
}
