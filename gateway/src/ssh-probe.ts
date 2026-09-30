// ── Host-side SSH reachability probe ─────────────────────────────────────────
// Publishing a port and having sshd listening inside the box are two separate
// facts, and neither proves the third: that a client gets an SSH banner. The
// failure this exists to catch is exactly "accept, then abort" — a userspace
// forwarder accepting on the host and resetting when the guest dial fails,
// which is what `kex_exchange_identification: read: Connection aborted` is.
// A plain connect() succeeds in that case; only reading the banner does not.

import net from 'node:net';

export interface SshBannerResult {
  ok: boolean;
  banner: string;
  error: string;
}

const BANNER_TIMEOUT_MS = 6_000;

/** One attempt: connect to 127.0.0.1:port and wait for a line starting with "SSH-". */
export function probeSshBanner(port: number, timeoutMs = BANNER_TIMEOUT_MS): Promise<SshBannerResult> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const done = (r: SshBannerResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(r);
    };
    socket.setTimeout(timeoutMs);
    socket.on('data', (buf) => {
      const banner = buf.toString('utf8').split('\n')[0].trim();
      if (banner.startsWith('SSH-')) done({ ok: true, banner, error: '' });
      else done({ ok: false, banner, error: `expected an SSH banner, got: ${banner.slice(0, 120)}` });
    });
    socket.on('timeout', () =>
      done({ ok: false, banner: '', error: `connected but no SSH banner within ${timeoutMs}ms` }));
    socket.on('error', (err) =>
      done({ ok: false, banner: '', error: (err as Error).message }));
    // Closed before any data: the "accept then abort" signature.
    socket.on('close', () =>
      done({
        ok: false, banner: '',
        error: 'connection closed before any SSH banner arrived — the host port forwards, but nothing inside the sandbox answered on :22',
      }));
  });
}

/** probeSshBanner with a couple of retries: the publish has only just happened. */
export async function probeSshBannerWithRetry(port: number, attempts = 3, delayMs = 1_000): Promise<SshBannerResult> {
  let last: SshBannerResult = { ok: false, banner: '', error: 'not attempted' };
  for (let i = 0; i < attempts; i++) {
    last = await probeSshBanner(port);
    if (last.ok) return last;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, delayMs));
  }
  return last;
}
