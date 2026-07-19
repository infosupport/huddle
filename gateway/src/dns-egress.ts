import fs from 'fs';
import dgram from 'dgram';

// De huddle-gateway is de enige egress-node: hij moet externe hostnames
// (api.anthropic.com, registries, ...) kunnen resolven. Hij hangt echter óók aan
// de `--internal` devcontainer-netwerken, en Podman zet de aardvark-DNS van die
// netwerken (de netwerk-gateway, bv. 10.89.x.1) in /etc/resolv.conf bij elke
// `network connect`. Die aardvark kent alléén container-namen en antwoordt op een
// externe naam met NXDOMAIN — een gezaghebbend "bestaat niet".
//
// De gateway-image is Alpine (musl). Musl's resolver bevraagt ALLE nameservers
// TEGELIJK (parallel) en gebruikt het eerste antwoord dat binnenkomt. De
// on-host aardvark antwoordt vrijwel meteen NXDOMAIN en wint zo de race van de
// tragere egress-resolver → élke externe lookup faalt met ENOTFOUND en de proxy
// geeft 502. Herschikken helpt niet (musl negeert de volgorde); de kapotte
// resolvers moeten wég. De gateway heeft ze niet nodig — hij resolvet nooit
// container-namen (dat gaat op IP), alleen externe hosts.
//
// Podman regenereert resolv.conf bij iedere connect/disconnect, dus we draaien
// dit na elke netwerkwijziging van de gateway.

const RESOLV_CONF = '/etc/resolv.conf';
// Elke egress-capable resolver kan deze naam beantwoorden; de internal-net
// aardvark antwoordt er NXDOMAIN op. Zo onderscheiden we werkende resolvers.
const SENTINEL = 'api.anthropic.com';
const PROBE_TIMEOUT_MS = 1500;

function buildAQuery(name: string): Buffer {
  const header = Buffer.from([
    0x12, 0x34, // id
    0x01, 0x00, // flags: standard query, recursion desired
    0x00, 0x01, // qdcount
    0x00, 0x00, // ancount
    0x00, 0x00, // nscount
    0x00, 0x00, // arcount
  ]);
  const q: number[] = [];
  for (const label of name.split('.')) {
    q.push(label.length);
    for (const ch of label) q.push(ch.charCodeAt(0));
  }
  q.push(0x00);       // root
  q.push(0x00, 0x01); // qtype A
  q.push(0x00, 0x01); // qclass IN
  return Buffer.concat([header, Buffer.from(q)]);
}

// True als de nameserver de sentinel écht kan resolven (rcode 0 + >=1 answer).
// NXDOMAIN, SERVFAIL, timeout of socketfout → false.
function probe(server: string): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { sock.close(); } catch { /* al dicht */ }
      resolve(ok);
    };
    const timer = setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    sock.on('message', (msg) => {
      if (msg.length < 12) return finish(false);
      const rcode = msg[3] & 0x0f;
      const ancount = msg.readUInt16BE(6);
      finish(rcode === 0 && ancount > 0);
    });
    sock.on('error', () => finish(false));
    sock.send(buildAQuery(SENTINEL), 53, server, (err) => {
      if (err) finish(false);
    });
  });
}

// Serialiseer sanitize-runs: de startup-settling en de connect/disconnect-hooks
// kunnen tegelijk vuren; zonder lock racen twee read-modify-write-cycli op
// resolv.conf. Kettingen op één promise zodat runs na elkaar lopen.
let inFlight: Promise<void> = Promise.resolve();
export function sanitizeResolvConf(): Promise<void> {
  inFlight = inFlight.then(doSanitize, doSanitize);
  return inFlight;
}

/**
 * Verwijdert uit /etc/resolv.conf de nameservers die externe namen NIET kunnen
 * resolven (de internal-net aardvark-servers), zodat musl alleen nog werkende
 * egress-resolvers bevraagt. Fail-safe: bij een leesfout, minder dan twee
 * nameservers, of als géén enkele resolver werkt (dan zou verwijderen alles
 * slopen), blijft het bestand ongewijzigd.
 */
async function doSanitize(): Promise<void> {
  let content: string;
  try {
    content = fs.readFileSync(RESOLV_CONF, 'utf8');
  } catch (err: any) {
    console.warn('[dns-egress] could not read resolv.conf:', err.message);
    return;
  }

  const lines = content.split('\n');
  const nameservers = lines
    .map((l) => l.trim().match(/^nameserver\s+(\S+)/)?.[1])
    .filter((s): s is string => !!s);

  if (nameservers.length < 2) return; // niks te winnen met filteren

  const results = await Promise.all(
    nameservers.map(async (ns) => ({ ns, ok: await probe(ns) })),
  );
  const working = results.filter((r) => r.ok).map((r) => r.ns);
  const broken = results.filter((r) => !r.ok).map((r) => r.ns);

  // Niets gedropt (allemaal werken), of niets werkt (dan zou droppen alle DNS
  // slopen — laat staan en faal veilig): in beide gevallen bestand ongewijzigd.
  if (broken.length === 0 || working.length === 0) return;

  // Herbouw het bestand: behoud alle niet-nameserver-regels op hun plek en
  // vervang het nameserver-blok door alléén de werkende resolvers (in volgorde).
  let injected = false;
  const rebuilt: string[] = [];
  for (const line of lines) {
    if (/^\s*nameserver\s+\S+/.test(line)) {
      if (!injected) {
        for (const ns of working) rebuilt.push(`nameserver ${ns}`);
        injected = true;
      }
      continue; // originele nameserver-regel(s) overslaan
    }
    rebuilt.push(line);
  }

  try {
    fs.writeFileSync(RESOLV_CONF, rebuilt.join('\n'));
    console.log(
      `[dns-egress] resolv.conf cleaned: egress=${working.join(',')} ` +
      `removed=${broken.join(',')}`,
    );
  } catch (err: any) {
    console.warn('[dns-egress] could not write resolv.conf:', err.message);
  }
}

// `huddle init` koppelt het tweede netwerk (devcontainer-net) pas ná de
// container-start aan, dus die vervuiling landt kort ná onze eerste sanitize.
// We draaien daarom nog een paar keer over de eerste ~15s zodat we de connect
// oppikken wanneer hij ook valt. Elke run is een no-op als resolv.conf al schoon
// is. Runtime-wijzigingen (nieuwe devcontainers) dekken de connect/disconnect-
// hooks in docker.ts al direct af.
const SETTLING_DELAYS_MS = [1000, 3000, 6000, 10000, 15000];
export function scheduleSettlingSanitize(): void {
  for (const ms of SETTLING_DELAYS_MS) {
    setTimeout(() => { void sanitizeResolvConf(); }, ms).unref();
  }
}
