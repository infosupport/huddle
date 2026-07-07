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

// Waarom de gate een bron wel/niet als devcontainer classificeerde. Puur voor
// diagnose/logging; de beslissing zelf zit in `blocked`.
export type GateReason =
  | 'no-remote-addr'              // geen bronadres → fail-closed
  | 'loopback'                    // huddle-host zelf → toegestaan
  | 'non-ipv4-fail-closed'        // raw IPv6 e.d. → fail-closed
  | 'unparseable-ipv4-fail-closed'// rommel-IPv4 → fail-closed
  | 'in-devcontainer-subnet'      // matcht een geblokkeerd subnet → geblokkeerd
  | 'ipv4-outside-subnets';       // IPv4 buiten alle subnetten → toegestaan

export interface GateDecision {
  blocked: boolean;
  reason: GateReason;
  rawAddr: string | null | undefined; // exact wat de socket rapporteerde
  ip: string | null;                  // genormaliseerd (::ffff: afgepeld)
  matchedSubnet: IpRange | null;      // het subnet dat matchte (indien blocked)
}

// Volledige classificatie van een bronadres tegen de devcontainer-subnetten,
// inclusief reden en matchend subnet. `isDevcontainerSource` hieronder is de
// boolean-only variant die de rest van de code gebruikt; deze functie levert de
// details die de debug-logging nodig heeft.
export function classifyDevcontainerSource(
  remoteAddr: string | null | undefined,
  subnets: IpRange[],
): GateDecision {
  // Geen bronadres te bepalen → fail-closed.
  if (!remoteAddr) return { blocked: true, reason: 'no-remote-addr', rawAddr: remoteAddr, ip: null, matchedSubnet: null };
  const ip = remoteAddr.replace(/^::ffff:/, '');
  // Loopback = de huddle-host zelf (o.a. de -p 127.0.0.1 port-forward via de
  // docker-proxy en lokale healthchecks) → nooit een devcontainer.
  if (ip === '127.0.0.1' || ip === '::1') return { blocked: false, reason: 'loopback', rawAddr: remoteAddr, ip, matchedSubnet: null };
  // Raw IPv6 (of ander niet-IPv4 adres): niet te matchen tegen de IPv4-subnet-
  // lijst → fail-closed i.p.v. doorlaten (dit was de IPv6-bypass).
  if (!ip.includes('.')) return { blocked: true, reason: 'non-ipv4-fail-closed', rawAddr: remoteAddr, ip, matchedSubnet: null };
  const ipInt = ipv4ToInt(ip);
  // Onparseerbaar IPv4 → fail-closed.
  if (ipInt < 0) return { blocked: true, reason: 'unparseable-ipv4-fail-closed', rawAddr: remoteAddr, ip, matchedSubnet: null };
  const matched = subnets.find(([base, mask]) => ((ipInt & mask) >>> 0) === base) ?? null;
  if (matched) return { blocked: true, reason: 'in-devcontainer-subnet', rawAddr: remoteAddr, ip, matchedSubnet: matched };
  return { blocked: false, reason: 'ipv4-outside-subnets', rawAddr: remoteAddr, ip, matchedSubnet: null };
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
  return classifyDevcontainerSource(remoteAddr, subnets).blocked;
}

// Rendert een [base, mask] range terug naar CIDR-notatie (bv. "172.18.0.0/16")
// voor leesbare logging.
export function rangeToCidr([base, mask]: IpRange): string {
  const dotted = [(base >>> 24) & 0xff, (base >>> 16) & 0xff, (base >>> 8) & 0xff, base & 0xff].join('.');
  let bits = 0;
  let m = mask >>> 0;
  while (m & 0x80000000) { bits++; m = (m << 1) >>> 0; }
  return `${dotted}/${bits}`;
}
