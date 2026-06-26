import crypto from 'crypto';

const PREFIX = 'huddle_tok_';

interface TokenMapping {
  realToken: string;
  containerId: string;
}

const tokenMap = new Map<string, TokenMapping>();
const containerLatest = new Map<string, string>();

export function storeTokenExchange(containerId: string, realToken: string): string {
  const prev = containerLatest.get(containerId);
  if (prev) tokenMap.delete(prev);
  const placeholder = PREFIX + crypto.randomBytes(32).toString('hex');
  tokenMap.set(placeholder, { realToken, containerId });
  containerLatest.set(containerId, placeholder);
  return placeholder;
}

export function resolveToken(placeholder: string): string | null {
  return tokenMap.get(placeholder)?.realToken ?? null;
}

export function isPlaceholderToken(token: string): boolean {
  return token.startsWith(PREFIX);
}
