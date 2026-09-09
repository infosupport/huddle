import crypto from 'crypto';

const PREFIX = 'huddle_tok_';

// Hoe lang een placeholder inwisselbaar blijft. Dekt een lange dev-sessie; het
// echte OAuth-token heeft z'n eigen (kortere) levensduur. Bij store-time gelezen
// (niet bij import) zodat de TTL overschrijfbaar/testbaar is via env.
function ttlMs(): number {
  const v = Number(process.env.HUDDLE_TOKEN_PLACEHOLDER_TTL_MS);
  return Number.isFinite(v) && process.env.HUDDLE_TOKEN_PLACEHOLDER_TTL_MS ? v : 12 * 60 * 60 * 1000;
}

interface TokenMapping {
  realToken: string;
  containerId: string;
  expiresAt: number;
}

const tokenMap = new Map<string, TokenMapping>();
const containerLatest = new Map<string, string>();

// Constant-tijd vergelijking van twee containerId-strings (voorkomt dat de
// binding-check via timing te omzeilen is).
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Sla het echte token op achter een placeholder, GEBONDEN aan de container die
// het aanvroeg (finding #12). Een null container-id levert een placeholder op
// die nooit inwisselbaar is (fail-closed) i.p.v. de oude gedeelde 'unknown'-
// bucket waarmee elke onbekende caller andermans token kon inwisselen.
export function storeTokenExchange(containerId: string | null, realToken: string): string {
  if (containerId) {
    const prev = containerLatest.get(containerId);
    if (prev) tokenMap.delete(prev);
  }
  const placeholder = PREFIX + crypto.randomBytes(32).toString('hex');
  // containerId '' bij null → matcht nooit een echte (niet-lege) caller-id.
  tokenMap.set(placeholder, { realToken, containerId: containerId ?? '', expiresAt: Date.now() + ttlMs() });
  if (containerId) containerLatest.set(containerId, placeholder);
  return placeholder;
}

// Wissel een placeholder in voor het echte token — alleen wanneer de caller
// dezelfde container is die de placeholder kreeg, en de TTL niet verlopen is.
export function resolveToken(placeholder: string, callerContainerId: string | null): string | null {
  const entry = tokenMap.get(placeholder);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tokenMap.delete(placeholder);
    return null;
  }
  // Ongebonden (leeg opgeslagen) of ongeïdentificeerde caller → nooit inwisselen.
  if (!entry.containerId || !callerContainerId) return null;
  if (!safeEqual(entry.containerId, callerContainerId)) return null;
  return entry.realToken;
}

export function isPlaceholderToken(token: string): boolean {
  return token.startsWith(PREFIX);
}

/**
 * Does Huddle manage OAuth tokens on this listener? Only where it owns the
 * identity the placeholder is bound to — the devcontainer proxy.
 *
 * NOT in sbx mode. Docker Sandboxes already runs proxy-managed credentials:
 * the sandbox holds a sentinel, not a real token —
 *
 *   ~/.claude/.credentials.json → {"claudeAiOauth":{"accessToken":
 *     "sk-ant-oat01-proxy-managed","refreshToken":"sk-ant-ort01-proxy-managed",…}}
 *
 * — and the sbx proxy substitutes the real credential on the way out. That is
 * also why sbx MITMs the Anthropic hosts itself (measured: platform.claude.com
 * gets a `Docker Sandboxes Proxy CA` leaf) instead of tunnelling them to Huddle.
 * Layering Huddle's own rewriting on top gives two managers for one credential:
 * Huddle would hand the sandbox a `huddle_tok_…` placeholder that overwrites
 * sbx's sentinel and that Huddle cannot even redeem afterwards, because on the
 * sbx port every request is unattributable (containerId is always null, ADR
 * §1.3) and `resolveToken` refuses to redeem an unbound placeholder.
 *
 * The security property is unchanged: the real token never reaches the sandbox
 * either way — it is just held by the layer that owns the identity.
 */
export function managesTokenExchange(isSbxProxy: boolean): boolean {
  return !isSbxProxy;
}
