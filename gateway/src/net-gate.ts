// ── Source-IP gate helpers ──────────────────────────────────────────────────
// Pure IPv4/CIDR logica achter de management-API gate (api.ts). Bewust vrij van
// DB- of Docker-imports zodat het deterministisch te testen is zonder een
// draaiende daemon of native sqlite-binding.

export type IpRange = [base: number, mask: number];

export function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => isNaN(p) || p < 0 || p > 255)) return -1;
  return ((parts[0] * 0x1000000) + (parts[1] * 0x10000) + (parts[2] * 0x100) + parts[3]) >>> 0;
}

// Parse een IPv4 CIDR (bv. "172.18.0.0/16") naar een [base, mask] range, met de
// base genormaliseerd tegen het masker. null voor niet-IPv4 / ongeldige input.
export function cidrToRange(cidr: string): IpRange | null {
  if (!cidr || !cidr.includes('.')) return null;
  const [base, bitsStr] = cidr.split('/');
  const baseInt = ipv4ToInt(base);
  if (baseInt < 0) return null;
  const bits = parseInt(bitsStr ?? '32');
  if (isNaN(bits) || bits < 0 || bits > 32) return null;
  const mask = bits === 0 ? 0 : ((0xFFFFFFFF << (32 - bits)) >>> 0);
  // >>> 0 houdt de base unsigned, consistent met ipv4ToInt en met de compare in
  // isDevcontainerSource (anders verschilt het teken bij subnets ≥ 128.x).
  return [(baseInt & mask) >>> 0, mask];
}

// True als `remoteAddr` binnen één van de geblokkeerde subnets valt.
export function isDevcontainerSource(
  remoteAddr: string | null | undefined,
  subnets: IpRange[],
): boolean {
  if (!remoteAddr) return false;
  const ip = remoteAddr.replace(/^::ffff:/, '');
  if (!ip.includes('.')) return false;
  const ipInt = ipv4ToInt(ip);
  if (ipInt < 0) return false;
  return subnets.some(([base, mask]) => ((ipInt & mask) >>> 0) === base);
}
