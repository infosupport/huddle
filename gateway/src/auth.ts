import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { IncomingMessage } from 'http';
import { runtimeEnv } from './runtime-env';

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
  return path.join(path.dirname(runtimeEnv.dbPath), 'operator-token');
}

// De bootstrap-volgorde hierboven, één keer. Beide tokens delen hem; wat ze niet
// delen is wat er ná generatie gebeurt (zie `announce`), en dat is precies het
// verschil tussen een token dat een mens moet overtypen en een token dat alleen
// tussen twee processen leeft.
function loadOrCreateToken(
  envValue: string | undefined,
  file: string,
  label: string,
  announce: (token: string) => void,
): string {
  const env = envValue?.trim();
  if (env) return env;

  try {
    const stored = fs.readFileSync(file, 'utf8').trim();
    if (stored) return stored;
  } catch {
    // nog geen file — genereren hieronder
  }

  const generated = crypto.randomBytes(32).toString('base64url');
  try {
    fs.writeFileSync(file, generated, { mode: 0o600 });
  } catch (err) {
    console.warn(`[auth] could not persist ${label} to ${file}: ${(err as Error).message}`);
  }
  announce(generated);
  return generated;
}

let cachedToken: string | null = null;

// Het canonieke operator-token. Gecached zodat we niet elke request van schijf
// lezen; de eerste aanroep bepaalt (en persisteert/logt) de waarde.
export function getOperatorToken(): string {
  if (cachedToken) return cachedToken;
  cachedToken = loadOrCreateToken(
    process.env.HUDDLE_OPERATOR_TOKEN,
    tokenFilePath(),
    'operator token',
    (generated) => console.log(
      `\n[auth] Operator token generated. Log in to the portal (http://localhost:3000) with:\n\n    ${generated}\n\n` +
      `Set HUDDLE_OPERATOR_TOKEN to choose a fixed token.\n`
    ),
  );
  return cachedToken;
}

// Alleen voor tests: reset de module-cache zodat een nieuwe env/file gelezen wordt.
export function __resetOperatorTokenCache(): void {
  cachedToken = null;
}

// ── Gateway authentication for the control channel ──────────────────────────
//
// A SECOND token, deliberately not the operator's.
//
// When the gateway moves out of the same process (docs/ADR-huddle-node-split.md)
// it needs to ask Huddle Node for firewall policy and hand back what it
// observed. That is a narrow, machine-to-machine conversation. The operator
// token is not narrow at all: it opens container terminals, execs, grants sudo
// and rewrites policy. Handing the network-exposed half of Huddle the key to all
// of that would mean a gateway compromise is a total compromise.
//
// So the two are strictly separate in both directions. The gateway token is
// accepted only on /control/*, and the operator token is not accepted there —
// which keeps "who may do this" answerable by looking at the token alone.
//
// Never logged, unlike the operator token: no human ever types it. `huddle init`
// reads it from the data dir and passes it to the container.

function gatewayTokenFilePath(): string {
  if (process.env.HUDDLE_GATEWAY_TOKEN_FILE) return process.env.HUDDLE_GATEWAY_TOKEN_FILE;
  return path.join(path.dirname(runtimeEnv.dbPath), 'gateway-token');
}

let cachedGatewayToken: string | null = null;

export function getGatewayToken(): string {
  if (cachedGatewayToken) return cachedGatewayToken;
  cachedGatewayToken = loadOrCreateToken(
    process.env.HUDDLE_GATEWAY_TOKEN,
    gatewayTokenFilePath(),
    'gateway token',
    () => { /* machine-to-machine: nothing to announce */ },
  );
  return cachedGatewayToken;
}

export function __resetGatewayTokenCache(): void {
  cachedGatewayToken = null;
}

// Is this request the gateway talking to the control channel? Bearer only — a
// cookie would mean a browser could be walked into making the call, and no
// browser has any business on /control/*.
export function isGatewayAuthenticated(headers: IncomingMessage['headers']): boolean {
  const auth = headers['authorization'];
  if (typeof auth !== 'string') return false;
  const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
  if (!m) return false;
  return timingSafeEqualStr(m[1].trim(), getGatewayToken());
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
