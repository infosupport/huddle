// ── `huddle container` — devcontainer-side commands that aren't part of
// `huddle start`'s create flow (e.g. SSH access, Stage 2). Thin client, same
// role as sbx.ts: it just calls the gateway's /api/docker/* endpoints.

import { get } from './api';
import { installSshKey } from './ssh';

export async function runContainerSshSetup(opts: { name?: string }): Promise<void> {
  if (!opts.name) {
    console.error('Usage: huddle container ssh-setup <name>');
    process.exit(1);
  }
  const key = await get<{ privateKey: string; publicKey: string; port: number }>(
    `/api/docker/containers/${encodeURIComponent(opts.name)}/ssh-key`
  );
  installSshKey(`devcontainer-${opts.name}`, key, 'vscode');
}
