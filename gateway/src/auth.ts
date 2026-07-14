import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { IncomingMessage } from 'http';

// ── Operator-authenticatie voor de control plane ────────────────────────────
// Root-cause van de "missing auth"-cluster (findings #4/#5/#9/#10/#11/#13): de
// enige toegangscontrole op :3000 was een source-IP-gate. Omdat de gateway een
// container is die via `-p 3000:3000` gepubliceerd wordt, arriveren de operator
// (browser + CLI) én een LAN-/sibling-aanvaller met HETZELFDE bridge-gateway-IP
// — source-IP kan ze principieel niet scheiden. Alleen een gedeeld operator-
// token doet dat. Dit is bewust minimaal (geen sessie-store): de cookie/bearer
// dráágt het token; een timing-safe vergelijking is de check.
//
// Bootstrap-volgorde van het token:
//   1. env HUDDLE_OPERATOR_TOKEN (door `huddle init` gezet) — leidend.
//   2. een persistente file in de data-dir (/data/operator-token) zodat het
//      token herstart-bestendig is voor compose/handmatige deploys.
//   3. anders: genereer er één, persisteer hem en log hem zodat de operator kan
//      inloggen (`docker logs huddle`).

const SESSION_COOKIE = 'huddle_session';

function tokenFilePath(): string {
  if (process.env.HUDDLE_OPERATOR_TOKEN_FILE) return process.env.HUDDLE_OPERATOR_TOKEN_FILE;
  const dbPath = process.env.DB_PATH || '/data/huddle.db';
  return path.join(path.dirname(dbPath), 'operator-token');
}

let cachedToken: string | null = null;

// Het canonieke operator-token. Gecached zodat we niet elke request van schijf
// lezen; de eerste aanroep bepaalt (en persisteert/logt) de waarde.
export function getOperatorToken(): string {
  if (cachedToken) return cachedToken;

  const env = process.env.HUDDLE_OPERATOR_TOKEN?.trim();
  if (env) {
    cachedToken = env;
    return env;
  }

  const file = tokenFilePath();
  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (stored) {
      cachedToken = stored;
      return stored;
    }
  } catch {
    // nog geen file — genereren hieronder
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (err) {
    console.warn(`[auth] kon operator-token niet persisteren naar ${file}: ${(err as Error).message}`);
  }
  cachedToken = generated;
  console.log(
    `\n[auth] Operator-token gegenereerd. Log in op de portal (http://localhost:3000) met:\n\n    ${generated}\n\n` +
    `Zet HUDDLE_OPERATOR_TOKEN om een vast token te kiezen.\n`
  );
  return generated;
}

// Alleen voor tests: reset de module-cache zodat een nieuwe env/file gelezen wordt.
export function __resetOperatorTokenCache(): void {
  cachedToken = null;
}

// Constant-tijd stringvergelijking: hash beide naar een vaste lengte en
// vergelijk de digests, zodat noch de lengte noch een vroege mismatch lekt.
export function timingSafeEqualStr(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Parse de Cookie-header naar een simpele map. Bewust geen dep: één header,
// `key=value; key2=value2`. Waarden worden URL-gedecodeerd.
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    if (!k) continue;
    let v = part.slice(eq + 1).trim();
    try { v = decodeURIComponent(v); } catch { /* laat rauw */ }
    out[k] = v;
  }
  return out;
}

// Haal het gepresenteerde token uit een request: `Authorization: Bearer <t>`
// (CLI/curl) of de httpOnly session-cookie (browser). Bearer wint.
export function extractPresentedToken(headers: IncomingMessage['headers']): string | null {
  const auth = headers['authorization'];
  if (typeof auth === 'string') {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m) return m[1].trim();
  }
  const cookies = parseCookies(headers['cookie'] as string | undefined);
  return cookies[SESSION_COOKIE] ?? null;
}

// Is deze request geauthenticeerd als operator?
export function isAuthenticated(headers: IncomingMessage['headers']): boolean {
  const presented = extractPresentedToken(headers);
  if (!presented) return false;
  return timingSafeEqualStr(presented, getOperatorToken());
}

// Set-Cookie-waarde voor een geslaagde login. httpOnly (geen JS-toegang),
// SameSite=Strict (browser stuurt hem NIET mee op cross-site requests/WS →
// dood aan CSRF en Cross-Site WebSocket Hijacking, finding #4), Path=/. Geen
// Secure-flag omdat de portal over http://localhost draait.
export function sessionCookie(token: string): string {
  const value = encodeURIComponent(token);
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

// Origin-allowlist voor de WebSocket-upgrade (defense-in-depth naast SameSite).
// Een browser stuurt op een WS-handshake altijd een Origin-header; een same-
// origin portal-pagina zet Origin == de eigen host, een kwaadaardige pagina zet
// haar eigen origin. We eisen dat de Origin-host gelijk is aan de Host-header
// (same-origin). Ontbreekt Origin (niet-browser client zoals de CLI), dan laten
// we de upgrade toe — die authenticeert alsnog via het bearer/cookie-token.
export function isAllowedOrigin(
  origin: string | undefined,
  hostHeader: string | undefined,
): boolean {
  if (!origin) return true; // niet-browser client; auth-check blijft gelden
  let originHost: string;
  try {
    originHost = new URL(origin).host.toLowerCase();
  } catch {
    return false; // onparseerbare Origin → weiger
  }
  const host = (hostHeader ?? '').toLowerCase();
  return originHost === host;
}
