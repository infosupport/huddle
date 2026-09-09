// An address a test upstream can live on that the proxy will actually forward to.
//
// Not loopback, and that is the whole point. The proxy refuses every request
// addressed to Huddle itself — the container name, `localhost`, and the entire
// 127.0.0.0/8 block (src/proxy-self.ts) — because "localhost" in a
// devcontainer's request resolves in the GATEWAY's namespace and is never what
// the caller meant. A suite that stands its upstream on 127.0.0.1 is therefore
// testing the self-host guard, not whatever it meant to test, and gets a 403.
//
// So bind the upstream on a real interface address instead. Returns null when
// this machine has none (a loopback-only CI box), and the suites skip rather
// than pretend.

import os from 'os';

export function forwardableHost(): string | null {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}
