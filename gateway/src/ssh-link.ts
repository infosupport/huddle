import { inspectContainer, execInContainer, execContainerOutput, isContainerIp, devcontainerIp } from './docker';
import { getSshRelayPort, listSshRelayPorts, setSshRelayPort, deleteSshRelayPort } from './db';
import { getSshPublicKey } from './host-config';
import { ensureSshRelay, closeSshRelay, type SshRelayDeps } from './ssh-relay';
import {
  SSH_RELAY_PORT_MIN,
  SSH_RELAY_PORT_MAX,
  SSH_USER,
  pickFreePort,
  sessionEnvFromContainer,
  buildSshdConfig,
  buildEnsureSshdScript,
  buildSshGatewayLink,
} from './ssh-access';

// ── "Connect via SSH" orchestration ──────────────────────────────────────────
// One idempotent call behind the portal button: allocate (or reuse) the relay
// port, start the relay, (re)configure sshd in the container with the
// operator's current public key, and return a jetbrains-gateway:// link to
// localhost:<port>. Re-running it after a container restart brings sshd back.

/** The gateway container; `huddle init` publishes the SSH relay ports on it. */
const HUDDLE_CONTAINER = 'huddle';

const relayDeps: SshRelayDeps = { isContainerIp, resolveTarget: devcontainerIp };

export class SshLinkError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

const ENSURE_SSHD_ERRORS: Record<number, string> = {
  3: 'openssh-server is not in this image and could not be installed (is deb.debian.org allowed?). Try again, or rebuild on the current base image.',
  4: 'sshd rejected the generated configuration (see /tmp/huddle-sshd-check.log in the container).',
  5: 'sshd did not start (see /tmp/huddle-sshd.log in the container).',
};

export async function prepareSshLink(name: string): Promise<string> {
  const inspect = await inspectContainer(name);
  const labels: Record<string, string> = inspect?.Config?.Labels ?? {};
  const projectPath = labels['com.intellij.devcontainer.workspace.path'];
  if (!projectPath) throw new SshLinkError(404, 'workspace path label not found');
  const ide = labels['com.devcontainer.ide'];
  if (ide === 'vscode') throw new SshLinkError(404, 'The SSH link opens a JetBrains IDE; this is a VS Code devcontainer');
  if (!inspect?.State?.Running) throw new SshLinkError(409, 'Container is not running');

  const keys = getSshPublicKey();
  if (!keys) throw new SshLinkError(409, 'No SSH public key configured. Add yours under Settings → SSH access.');

  const port = allocatePort(name);
  const self = await inspectContainer(HUDDLE_CONTAINER);
  if (!self?.HostConfig?.PortBindings?.[`${port}/tcp`]) {
    throw new SshLinkError(409, `SSH port ${port} is not published on the Huddle container. Run \`huddle restart\` on the host once to publish ports ${SSH_RELAY_PORT_MIN}-${SSH_RELAY_PORT_MAX}.`);
  }
  await ensureSshRelay(name, port, relayDeps);

  const sshdConfig = buildSshdConfig(sessionEnvFromContainer(inspect?.Config?.Env));
  const result = await execInContainer(name, ['sh', '-c', buildEnsureSshdScript(sshdConfig)], `${keys}\n`);
  if (result.exitCode !== 0) {
    throw new SshLinkError(500, ENSURE_SSHD_ERRORS[result.exitCode ?? -1] ?? `Setting up sshd failed (exit ${result.exitCode})`);
  }

  return buildSshGatewayLink({
    host: 'localhost',
    port,
    user: SSH_USER,
    projectPath,
    idePath: await findIdePath(inspect.Id, ide === 'rider' ? 'rider' : 'idea'),
  });
}

function allocatePort(name: string): number {
  const existing = getSshRelayPort(name);
  if (existing !== null) return existing;
  const port = pickFreePort(listSshRelayPorts().map(r => r.port));
  if (port === null) {
    throw new SshLinkError(409, `All SSH ports (${SSH_RELAY_PORT_MIN}-${SSH_RELAY_PORT_MAX}) are in use. Remove devcontainers you no longer need.`);
  }
  setSshRelayPort(name, port);
  return port;
}

// The backend already in the shared RemoteDev volume (same lookup as the config
// script). Undefined → the link asks Gateway to deploy one.
async function findIdePath(containerId: string, filter: 'rider' | 'idea'): Promise<string | undefined> {
  const dist = '/.jbdevcontainer/JetBrains/RemoteDev/dist';
  try {
    const out = await execContainerOutput(containerId, [
      'sh', '-c', `ls ${dist}/ 2>/dev/null | grep -i ${filter} | sort -t- -k2 -V | tail -1`,
    ]);
    const dir = out.trim().split('\n').pop()?.trim();
    return dir && /^[\w.+-]+$/.test(dir) ? `${dist}/${dir}` : undefined;
  } catch {
    return undefined;
  }
}

/** Restore relays after a gateway restart, for devcontainers that still exist. */
export async function restoreSshRelays(existing: Set<string>): Promise<void> {
  for (const { container_name, port } of listSshRelayPorts()) {
    if (!existing.has(container_name)) { deleteSshRelayPort(container_name); continue; }
    try {
      await ensureSshRelay(container_name, port, relayDeps);
    } catch (err: any) {
      console.warn(`[ssh-relay] restore failed for ${container_name}:`, err.message);
    }
  }
}

/** Drop the relay and its port when a devcontainer is removed. */
export async function removeSshRelay(name: string): Promise<void> {
  await closeSshRelay(name);
  deleteSshRelayPort(name);
}
