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

// True als `remoteAddr` als een devcontainer-bron behandeld moet worden (en dus
// de management-API NIET mag bereiken). Fail-closed: alles wat we niet positief
// als "veilige" bron kunnen vaststellen (loopback of een IPv4-adres buiten de
// devcontainer-subnetten) wordt als devcontainer beschouwd. Zo kan een container
// de gate niet omzeilen via IPv6 of een niet-parseerbaar bronadres.
export function isDevcontainerSource(
  remoteAddr: string | null | undefined,
  subnets: IpRange[],
): boolean {
  // Geen bronadres te bepalen → fail-closed.
  if (!remoteAddr) return true;
  const ip = remoteAddr.replace(/^::ffff:/, '');
  // Loopback = de huddle-host zelf (o.a. de -p 127.0.0.1 port-forward via de
  // docker-proxy en lokale healthchecks) → nooit een devcontainer.
  if (ip === '127.0.0.1' || ip === '::1') return false;
  // Raw IPv6 (of ander niet-IPv4 adres): niet te matchen tegen de IPv4-subnet-
  // lijst → fail-closed i.p.v. doorlaten (dit was de IPv6-bypass).
  if (!ip.includes('.')) return true;
  const ipInt = ipv4ToInt(ip);
  // Onparseerbaar IPv4 → fail-closed.
  if (ipInt < 0) return true;
  return subnets.some(([base, mask]) => ((ipInt & mask) >>> 0) === base);
}
