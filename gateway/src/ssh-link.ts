import { inspectContainer, execInContainer, execContainerOutput, isContainerIp, devcontainerIp } from './docker';
import { getSshRelayPort, listSshRelayPorts, setSshRelayPort, deleteSshRelayPort } from './db';
import { hostPipe, HostPipeError } from './host-pipe';
import { ensureSshRelay, closeSshRelay, type SshRelayDeps } from './ssh-relay';
import {
  SSH_RELAY_PORT_MIN,
  SSH_RELAY_PORT_MAX,
  SSH_USER,
  pickFreePort,
  sessionEnvFromContainer,
  HOST_KEY_PUB,
  normalizeSshPublicKeys,
  buildSshdConfig,
  buildEnsureSshdScript,
  sshAlias,
  buildToolboxSshLink,
} from './ssh-access';

// ── "Connect via SSH" orchestration ──────────────────────────────────────────
// One idempotent call behind the portal button: allocate (or reuse) the relay
// port, start the relay, (re)configure sshd in the container with Huddle's own
// public key (the host agent makes the key pair on the host), let the host agent
// write the `<name>.huddle` ssh alias with the container's host key pinned, and
// return a JetBrains Toolbox link to that alias. Nobody has to set up a key.
// Re-running it after a container restart brings sshd back.

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

  const { publicKey } = await onHost<{ publicKey: string }>('ssh.key', {});
  let keys: string;
  try { keys = normalizeSshPublicKeys(publicKey); } catch { keys = ''; }
  if (!keys || keys.includes('\n')) throw new SshLinkError(500, 'The host agent returned no valid SSH public key.');

  const port = allocatePort(name);
  const self = await inspectContainer(HUDDLE_CONTAINER);
  if (!self?.HostConfig?.PortBindings?.[`${port}/tcp`]) {
    throw new SshLinkError(409, `SSH port ${port} is not published on the Huddle container. Run \`huddle restart\` on the host once to publish ports ${SSH_RELAY_PORT_MIN}-${SSH_RELAY_PORT_MAX}.`);
  }
  await ensureSshRelay(name, port, relayDeps);

  const sshdConfig = buildSshdConfig(sessionEnvFromContainer(inspect?.Config?.Env));
  const result = await execInContainer(name, ['sh', '-c', buildEnsureSshdScript(sshdConfig, inspect.Id)], `${keys}\n`);
  if (result.exitCode !== 0) {
    throw new SshLinkError(500, ENSURE_SSHD_ERRORS[result.exitCode ?? -1] ?? `Setting up sshd failed (exit ${result.exitCode})`);
  }

  const hostKey = (await execContainerOutput(inspect.Id, ['cat', HOST_KEY_PUB])).trim().split(' ').slice(0, 2).join(' ');
  const alias = sshAlias(name);
  await onHost('ssh.host', { alias, port, user: SSH_USER, hostKey });
  return buildToolboxSshLink(alias, projectPath);
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

// The host agent does the host side (key pair, ssh alias). Without it no IDE
// on the host could find the key, so say how to start it.
async function onHost<T>(op: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await hostPipe.call<T>(op, args);
  } catch (err) {
    if (err instanceof HostPipeError && err.code === 'host_pipe_offline') {
      throw new SshLinkError(409, 'The Huddle host agent is not running, and it sets up SSH on this machine. Run `huddle pipe start` (or `huddle restart`) on the host.');
    }
    throw new SshLinkError(500, `Setting up SSH on the host failed: ${(err as Error).message}`);
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

/** Drop the relay, its port and the host's ssh alias when a devcontainer is removed. */
export async function removeSshRelay(name: string): Promise<void> {
  await closeSshRelay(name);
  const hadPort = getSshRelayPort(name) !== null;
  deleteSshRelayPort(name);
  // Best effort: a leftover alias is rewritten on the next Connect IDE anyway.
  if (hadPort) await hostPipe.call('ssh.host', { alias: sshAlias(name), remove: true }).catch(() => undefined);
}
