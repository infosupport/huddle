import http from 'http';
import fs from 'fs';
import crypto from 'crypto';
import { createContainerProxy } from './socket-proxy';
import { getSetting, listFolderMappings } from './db';
import type { ExecResult } from './sudo-grant';
import { getCaCertPem } from './tls-ca';
import { ensureWorktree } from './worktree';
import { sanitizeResolvConf } from './dns-egress';

const SOCKET_DIR = '/tmp/dc-sockets';

// The CLI passes the detected container engine via HUDDLE_RUNTIME. On (rootless)
// Podman the per-container proxy socket is SELinux-labeled; a SELinux-confined
// devcontainer is then not allowed to access it. `label=disable` on the
// devcontainer lifts that confinement so DOCKER_HOST/the socket work.
// (Docker/Docker Desktop do not need this.)
const CONTAINER_RUNTIME = process.env.HUDDLE_RUNTIME ?? 'docker';
const RUNTIME_SECURITY_OPT: string[] = CONTAINER_RUNTIME === 'podman' ? ['label=disable'] : [];

// ── IP → container name cache (used by proxy) ────────────────────────────────

const CACHE_TTL_MS = 10_000;
let ipToName = new Map<string, string>();
let cacheExpiry = 0;

// ── Generic Docker socket helpers ────────────────────────────────────────────

export function dockerRequest(method: string, path: string, body?: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      method,
      path,
      headers: bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {},
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk: string) => (raw += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker API ${method} ${path} → ${res.statusCode}: ${raw}`));
          return;
        }
        try {
          resolve(raw ? JSON.parse(raw) : {});
        } catch {
          resolve(raw);
        }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ── IP resolution (proxy use) ────────────────────────────────────────────────

async function fetchContainerMap(): Promise<Map<string, string>> {
  const containers: any[] = await dockerRequest('GET', '/containers/json');
  const map = new Map<string, string>();
  for (const c of containers) {
    const name = ((c.Names?.[0] as string) ?? '').replace(/^\//, '');
    // Child containers inherit their parent's allowlist: map their IP to the
    // parent container name so proxy rule lookups use the parent's rules.
    const parentName = (c.Labels?.['huddle.parent'] as string | undefined) ?? name;
    for (const net of Object.values<any>(c.NetworkSettings?.Networks ?? {})) {
      if (net.IPAddress) map.set(net.IPAddress, parentName);
    }
  }
  return map;
}

export async function resolveContainerByIp(rawIp: string): Promise<string | null> {
  const ip = rawIp.replace(/^::ffff:/, '');
  const now = Date.now();
  if (now > cacheExpiry) {
    try {
      ipToName = await fetchContainerMap();
      cacheExpiry = now + CACHE_TTL_MS;
    } catch {
      cacheExpiry = now + 2_000;
    }
  }
  return ipToName.get(ip) ?? null;
}

// ── Management functions ─────────────────────────────────────────────────────

export interface DevcontainerInfo {
  id: string;
  name: string;
  image: string;
  status: string;
  workspacePath: string;
  presentableName: string;
  created: number;
  inNetwork: boolean;
  huddleInNetwork: boolean;
}

// Set of dc-net-* networks the huddle container itself is on. Used to detect per
// devcontainer whether huddle is still attached to its dc-net (after a container
// restart this attachment can break if the network was recreated).
export async function getHuddleNetworks(): Promise<Set<string>> {
  try {
    const inspect = await dockerRequest('GET', '/containers/huddle/json');
    const nets = inspect?.NetworkSettings?.Networks ?? {};
    return new Set(Object.keys(nets));
  } catch {
    return new Set();
  }
}

export async function listDevcontainers(): Promise<DevcontainerInfo[]> {
  const filters = JSON.stringify({ label: ['com.intellij.devcontainer.id'] });
  const [containers, huddleNets] = await Promise.all([
    dockerRequest('GET', `/containers/json?all=1&filters=${encodeURIComponent(filters)}`) as Promise<any[]>,
    getHuddleNetworks(),
  ]);
  return containers.map((c) => {
    const name = ((c.Names?.[0] as string) ?? '').replace(/^\//, '');
    const netName = `dc-net-${name}`;
    const dcNet = c.NetworkSettings?.Networks?.[netName] ?? c.NetworkSettings?.Networks?.['devcontainer-net'];
    return {
      id: c.Id,
      name,
      image: c.Image,
      status: c.Status,
      workspacePath: c.Labels?.['com.intellij.devcontainer.sources.path'] ?? '',
      presentableName: c.Labels?.['com.intellij.devcontainer.presentable.name'] ?? '',
      created: c.Created,
      inNetwork: Boolean(dcNet?.IPAddress),
      huddleInNetwork: huddleNets.has(netName),
    };
  });
}

export async function refreshContainerIptables(containerId: string, containerName: string): Promise<void> {
  // After a huddle restart the container's iptables rules still point to the old huddle IP.
  // Rebuild both the nat DNAT rule and the filter DROP rules with the new huddle IP.
  const script = `
HUDDLE_IP=$(getent hosts huddle 2>/dev/null | awk '{print $1}')
[ -z "$HUDDLE_IP" ] && exit 0
iptables -t nat -L OUTPUT --line-numbers -n 2>/dev/null \
  | awk '/DNAT.*dpt:80/{print $1}' | sort -rn \
  | while read LINE; do iptables -t nat -D OUTPUT "$LINE" 2>/dev/null || true; done
iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || true
iptables -F OUTPUT 2>/dev/null || true
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -A OUTPUT -p tcp -j DROP
`;
  try {
    const exec = await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
      User: 'root',
      Cmd: ['sh', '-c', script],
      AttachStdout: false,
      AttachStderr: false,
    });
    await dockerRequest('POST', `/exec/${exec.Id}/start`, { Detach: true });
    console.log(`[iptables] refreshed rules in ${containerName}`);
  } catch (err: any) {
    console.warn(`[iptables] refresh failed for ${containerName}:`, err.message);
  }
}

export type IdeName = 'rider' | 'intellij' | 'vscode';

export function isIdeName(value: unknown): value is IdeName {
  return value === 'rider' || value === 'intellij' || value === 'vscode';
}

export function getBaseImageName(ide: IdeName): string {
  const envKey = `BASE_IMAGE_${ide.toUpperCase()}`;
  return process.env[envKey] ?? `ghcr.io/infosupport/base-devimage-${ide}`;
}

export async function inspectContainer(name: string): Promise<any> {
  return dockerRequest('GET', `/containers/${encodeURIComponent(name)}/json`);
}

export interface SnapshotImage {
  id: string;
  name: string;
  size: number;
  created: number;
  ide?: IdeName;
}

export async function listSnapshotImages(ide?: IdeName): Promise<SnapshotImage[]> {
  const labelFilters = ['com.devcontainer.snapshot=true'];
  if (ide) labelFilters.push(`com.devcontainer.ide=${ide}`);
  const filters = JSON.stringify({ label: labelFilters });
  const images: any[] = await dockerRequest('GET', `/images/json?filters=${encodeURIComponent(filters)}`);
  return images.map((img) => {
    const labels: Record<string, string> = img.Labels ?? {};
    const labelIde = labels['com.devcontainer.ide'];
    return {
      id: img.Id,
      name: (img.RepoTags?.[0] as string) ?? img.Id.substring(7, 19),
      size: img.Size,
      created: img.Created,
      ide: isIdeName(labelIde) ? labelIde : undefined,
    };
  });
}

// Read the IDE that a running container is configured for, by parsing the JB
// devcontainer model label (`customizations.jetbrains.backend`).
function ideFromContainerLabels(labels: Record<string, string> | undefined): IdeName | undefined {
  const raw = labels?.['com.intellij.devcontainer.model'];
  if (!raw) return undefined;
  try {
    const backend = JSON.parse(raw)?.customizations?.jetbrains?.backend;
    if (backend === 'Rider') return 'rider';
    if (backend === 'IntelliJ') return 'intellij';
  } catch { /* fallthrough */ }
  return undefined;
}

export async function execContainerOutput(containerId: string, cmd: string[]): Promise<string> {
  const execCreate = await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/exec`, {
    AttachStdout: true,
    AttachStderr: false,
    Tty: false,
    Cmd: cmd,
    User: 'root',
  });
  return new Promise((resolve, reject) => {
    const startBody = JSON.stringify({ Detach: false, Tty: false });
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/exec/${execCreate.Id}/start`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(startBody) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks);
          // Docker multiplexed stream: 8-byte header [type,0,0,0, size(4 BE)] + payload
          let stdout = '';
          let offset = 0;
          while (offset + 8 <= raw.length) {
            const streamType = raw[offset];
            const size = raw.readUInt32BE(offset + 4);
            offset += 8;
            if (offset + size > raw.length) break;
            if (streamType === 1) stdout += raw.subarray(offset, offset + size).toString('utf8');
            offset += size;
          }
          resolve(stdout);
        });
      },
    );
    req.on('error', reject);
    req.write(startBody);
    req.end();
  });
}

// Run a command (execve array, NO shell) as root in the container and pipe
// `stdin` to the process. Used by the sudo-grant flow to feed `chpasswd` the
// password via stdin — never as a shell argument (no injection, not visible in
// the process list). Returns the exit code (from exec inspect) so the caller can
// decide fail-closed.
//
// Important: the body of POST /exec/<id>/start contains ONLY the JSON options.
// The daemon parses that body as JSON and rejects trailing bytes after it — so
// stdin must NOT be included there. On an attached exec the daemon hijacks the
// connection into a raw bidirectional stream; stdin goes over that socket and is
// closed with a half-close (FIN) so the process (chpasswd) sees EOF and stops.
export async function execInContainer(containerName: string, cmd: string[], stdin: string): Promise<ExecResult> {
  const execCreate = await dockerRequest('POST', `/containers/${encodeURIComponent(containerName)}/exec`, {
    AttachStdin: stdin.length > 0,
    AttachStdout: true,
    AttachStderr: true,
    Tty: false,
    Cmd: cmd,
    User: 'root',
  });
  await startExec(execCreate.Id, stdin);
  return waitForExecExit(execCreate.Id);
}

// Fail-closed ceiling for a single exec-start. The sudo commands (chpasswd,
// usermod, passwd) return near-instantly, so this only ever trips on a genuine
// stall (unreachable/wedged daemon). Without it a stalled start would hang the
// caller — and, in the expiry sweeper's per-container loop, block every later
// expired grant from being re-locked. A bounded reject lets the caller move on.
const EXEC_START_TIMEOUT_MS = 15_000;

// POST /exec/<id>/start with the JSON options ONLY — stdin must not go in the
// body (the daemon parses the body as JSON and rejects trailing bytes). On a 2xx
// the connection is hijacked into a raw bidirectional stream; on a non-2xx we
// fail closed with the error body so a failed start never looks like "exit null".
function startExec(execId: string, stdin: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const startBody = JSON.stringify({ Detach: false, Tty: false });
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        method: 'POST',
        path: `/exec/${execId}/start`,
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(startBody) },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          rejectStartError(res, reject);
        } else {
          pumpHijackedStream(res, stdin, resolve, reject);
        }
      },
    );
    // Idle-timeout on the underlying socket: fires only if the start neither
    // streams nor completes, converting an indefinite hang into a fail-closed
    // error (surfaced via the 'error' handler below).
    req.setTimeout(EXEC_START_TIMEOUT_MS, () => {
      req.destroy(new Error(`exec start timed out after ${EXEC_START_TIMEOUT_MS}ms`));
    });
    req.on('error', reject);
    req.end(startBody);
  });
}

// Collect a non-2xx exec-start response body and reject with it (fail closed).
function rejectStartError(res: http.IncomingMessage, reject: (err: Error) => void): void {
  let raw = '';
  res.on('data', (c: Buffer) => { raw += c.toString(); });
  res.on('end', () => reject(new Error(`exec start → ${res.statusCode}: ${raw}`)));
  res.on('error', reject);
}

// Feed stdin over the hijacked raw stream and half-close (FIN) so the process
// gets EOF, then drain the multiplexed stdout/stderr until the daemon closes it.
function pumpHijackedStream(
  res: http.IncomingMessage,
  stdin: string,
  resolve: () => void,
  reject: (err: Error) => void,
): void {
  if (stdin.length > 0) {
    res.socket.write(Buffer.from(stdin, 'utf8'));
    res.socket.end();
  }
  res.on('data', () => { /* ignore multiplexed stdout/stderr */ });
  res.on('end', () => resolve());
  res.on('error', reject);
}

// Poll the exec inspect until the process has exited. The stream close usually
// means ExitCode is already set; some daemons/platforms (e.g. WSL2) reap just
// after the stream close, so poll briefly instead of reporting null right away.
async function waitForExecExit(execId: string): Promise<ExecResult> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const info = await dockerRequest('GET', `/exec/${execId}/json`);
    if (typeof info.ExitCode === 'number' && info.Running !== true) {
      return { exitCode: info.ExitCode };
    }
    if (info.Running !== true) break; // done but no numeric code → null
    await new Promise((r) => setTimeout(r, 50));
  }
  const final = await dockerRequest('GET', `/exec/${execId}/json`);
  return { exitCode: typeof final.ExitCode === 'number' ? final.ExitCode : null };
}

export async function commitContainer(containerId: string, imageName: string): Promise<string> {
  const [repo, tag = 'latest'] = imageName.split(':');
  // Inherit the IDE label from the source container so the snapshot is filterable per IDE.
  const inspect = await inspectContainer(containerId);
  const sourceIde = ideFromContainerLabels(inspect?.Config?.Labels);
  const labels: Record<string, string> = {
    'com.devcontainer.snapshot': 'true',
    'com.devcontainer.source': containerId,
    'com.devcontainer.created': new Date().toISOString(),
  };
  if (sourceIde) labels['com.devcontainer.ide'] = sourceIde;
  const result = await dockerRequest(
    'POST',
    `/commit?container=${encodeURIComponent(containerId)}&repo=${encodeURIComponent(repo)}&tag=${encodeURIComponent(tag)}`,
    { Labels: labels }
  );
  return result.Id ?? '';
}

export async function listNetworks(): Promise<any[]> {
  return dockerRequest('GET', '/networks');
}

export async function networkExists(name: string): Promise<boolean> {
  try {
    await dockerRequest('GET', `/networks/${encodeURIComponent(name)}`);
    return true;
  } catch {
    return false;
  }
}

export async function createNetwork(name: string): Promise<void> {
  await dockerRequest('POST', '/networks/create', { Name: name, Internal: true });
}

export async function imageExists(name: string): Promise<boolean> {
  try {
    await dockerRequest('GET', `/images/${encodeURIComponent(name)}/json`);
    return true;
  } catch {
    return false;
  }
}

export async function buildImage(imageName: string, dockerfilePath: string): Promise<void> {
  const dockerfileContent = fs.readFileSync(dockerfilePath);
  // Minimal single-file tar: just the Dockerfile.
  const header = Buffer.alloc(512);
  Buffer.from('Dockerfile').copy(header, 0);
  Buffer.from('0000644\0').copy(header, 100);
  Buffer.from('0000000\0').copy(header, 108);
  Buffer.from('0000000\0').copy(header, 116);
  Buffer.from(dockerfileContent.length.toString(8).padStart(11, '0') + '\0').copy(header, 124);
  Buffer.from(Math.floor(Date.now() / 1000).toString(8).padStart(11, '0') + '\0').copy(header, 136);
  header[156] = 0x30;
  Buffer.from('ustar\0').copy(header, 257);
  Buffer.from('00').copy(header, 263);
  Buffer.from('        ').copy(header, 148);
  let checksum = 0;
  for (let i = 0; i < 512; i++) checksum += header[i];
  Buffer.from(checksum.toString(8).padStart(6, '0') + '\0 ').copy(header, 148);
  const padded = Buffer.alloc(Math.ceil(dockerfileContent.length / 512) * 512);
  dockerfileContent.copy(padded);
  const tarData = Buffer.concat([header, padded, Buffer.alloc(1024)]);

  await new Promise<void>((resolve, reject) => {
    const options: http.RequestOptions = {
      socketPath: '/var/run/docker.sock',
      method: 'POST',
      path: `/build?t=${encodeURIComponent(imageName)}`,
      headers: {
        'content-type': 'application/x-tar',
        'content-length': tarData.length,
      },
    };
    const req = http.request(options, (res) => {
      let output = '';
      res.on('data', (chunk: string) => (output += chunk));
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Docker build ${imageName} → ${res.statusCode}: ${output}`));
          return;
        }
        for (const line of output.split('\n').filter(Boolean)) {
          try {
            const obj = JSON.parse(line);
            if (obj.error) { reject(new Error(`Docker build failed: ${obj.error}`)); return; }
          } catch { /* non-JSON line is fine */ }
        }
        resolve();
      });
    });
    req.on('error', reject);
    req.write(tarData);
    req.end();
  });
}

export async function connectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/connect`, { Container: containerName });
  // When the gateway itself attaches to an (internal) devcontainer-net, Podman
  // puts that net's aardvark DNS at the front of resolv.conf — which fails on
  // external names. Restore the order so egress keeps working (see dns-egress.ts).
  if (containerName === 'huddle') await sanitizeResolvConf();
}

export async function disconnectNetwork(networkName: string, containerName: string): Promise<void> {
  await dockerRequest('POST', `/networks/${encodeURIComponent(networkName)}/disconnect`, { Container: containerName });
  // A disconnect also makes Podman regenerate resolv.conf.
  if (containerName === 'huddle') await sanitizeResolvConf();
}

export async function deleteNetwork(name: string): Promise<void> {
  await dockerRequest('DELETE', `/networks/${encodeURIComponent(name)}`);
}

export async function forceDeleteContainer(containerId: string): Promise<void> {
  await dockerRequest('DELETE', `/containers/${encodeURIComponent(containerId)}?force=true`);
}

export async function startExistingContainer(containerId: string): Promise<void> {
  await dockerRequest('POST', `/containers/${encodeURIComponent(containerId)}/start`, {});
}

export async function cleanupContainerNetwork(containerName: string): Promise<void> {
  const netName = `dc-net-${containerName}`;
  if (!(await networkExists(netName))) return;
  try { await disconnectNetwork(netName, 'huddle'); } catch {}
  try { await deleteNetwork(netName); } catch {}
}

// Seed the shared AI-CLI volumes with the image defaults when the volume is still
// empty. The named volumes hide the COPYs from the Dockerfile, so without this
// step a fresh volume is missing CLAUDE.md/AGENTS.md/agents etc. `cp -rn` never
// overwrites existing files, so an already-logged-in/configured volume stays
// untouched.
function buildFolderMappingSeedScript(containerPaths: string[]): string {
  if (containerPaths.length === 0) return '';
  const pairs = containerPaths
    .map(p => {
      const rel = p.replace(/^\/home\/vscode\//, '');
      const defaultsRel = `${rel}-defaults`;
      return `"${rel}:${defaultsRel}"`;
    })
    .join(' ');
  return `# Seed volume-mounted AI CLI settings from the image defaults when the volume is empty.
for pair in ${pairs}; do
  dest="/home/vscode/\${pair%%:*}"
  src="/home/vscode/\${pair##*:}"
  [ -d "$src" ] || continue
  if [ -z "$(ls -A "$dest" 2>/dev/null)" ]; then
    mkdir -p "$dest"
    cp -rn "$src"/. "$dest"/ 2>/dev/null || true
    chown -R vscode:vscode "$dest" 2>/dev/null || true
  fi
done`;
}

// Docker access goes via the socket in the mounted directory /var/run/huddle
// (see DOCKER_HOST). Symlink the default path for tools that ignore DOCKER_HOST.
// Shared between the JetBrains and VS Code startup scripts.
const DOCKER_SOCK_SYMLINK = `# Docker access goes via the socket in the mounted directory /var/run/huddle
# (see DOCKER_HOST). Symlink the default path for tools that ignore DOCKER_HOST.
ln -sfn /var/run/huddle/docker.sock /var/run/docker.sock 2>/dev/null || true`;

// Create the admin user `noot` in the sudo/wheel group, but LOCKED and without a
// usable password. Deliberately no password is set here: that only happens per
// grant (ephemeral, see sudo-grant.ts) and is locked again afterwards. Idempotent
// — a second run (or a container from before this version with a standing
// password) is also brought to the locked state. Shared between the JetBrains and
// VS Code startup scripts so both stay in sync.
const NOOT_LOCKED_SETUP = `# Admin user 'noot': in the sudo group but LOCKED by default (no standing
# password). Huddle sets a fresh password per grant temporarily and locks again.
export DEBIAN_FRONTEND=noninteractive
command -v sudo >/dev/null 2>&1 || { apt-get update -qq && apt-get install -y --no-install-recommends sudo passwd; }
id noot >/dev/null 2>&1 || useradd -m -s /bin/bash noot
usermod -aG sudo noot 2>/dev/null || usermod -aG wheel noot 2>/dev/null || true
# Lock + expiry: a freshly created account is already locked ('!'), but this also
# covers upgrades of containers that previously had a standing password.
usermod -L noot 2>/dev/null || true
passwd -l noot 2>/dev/null || true
passwd -e noot 2>/dev/null || true`;

// Finding #15 (IDE channel, VS Code Remote + JetBrains Gateway): the attach
// channel goes over `docker exec`/stdio and is seen by NEITHER the egress proxy
// NOR the socket proxy. The real host token NEVER arrives as a file; VS Code has
// the container fetch it on-demand. The actual route (confirmed live) is a git
// `credential.helper` that on attach is set in BOTH /etc/gitconfig AND the
// ~/.gitconfig copied from the host:
//     helper = !… node /tmp/vscode-remote-containers-<id>.js git-credential-helper …
// which calls the host credential helper via the general remote-containers IPC
// socket. (Older VS Code used GIT_ASKPASS + /tmp/vscode-git-*.sock; we still cover
// those too.) We cut it at three levels:
//   1. env-scrub for EVERY shell — /etc/profile.d (login) and /etc/bash.bashrc
//      (interactive non-login; what the VS Code terminal sources by default).
//      Covers the GIT_ASKPASS variant.
//   2. strip the git `credential.helper` pointing at the remote-containers helper
//      from /etc/gitconfig and ~/.gitconfig — THIS is the actual route. Value
//      regex 'vscode-remote-containers' so a helper set by the user themselves
//      stays in place.
//   3. remove the forwarded GPG agent socket(s) (~/.gnupg/S.gpg-agent*) — this
//      disables commit signing with the host GPG key.
//   4. clean up the old askpass sockets (for VS Code versions that still make them).
// Do NOT remove the remote-containers IPC socket itself: it is multiplexed with
// the entire Remote session; if we strip the helper, git has no route to it
// anyway. A guard runs for the whole container lifetime, because the helper/
// sockets only appear on attach (after this script) and return on reconnect.
const IDE_CRED_SCRUB = `# Finding #15: strip the untrusted container of the host credentials forwarded
# by the IDE (git token via credential.helper/askpass, SSH agent, GPG).
SCRUB_VARS='GIT_ASKPASS SSH_AUTH_SOCK SSH_AGENT_PID GPG_AGENT_INFO GPG_TTY VSCODE_GIT_ASKPASS_NODE VSCODE_GIT_ASKPASS_MAIN VSCODE_GIT_ASKPASS_EXTRA_ARGS VSCODE_GIT_IPC_HANDLE'
SCRUB_LINE="unset \$SCRUB_VARS"
printf '%s\\n' "\$SCRUB_LINE" > /etc/profile.d/99-huddle-scrub-ide-creds.sh
chmod 644 /etc/profile.d/99-huddle-scrub-ide-creds.sh
# Interactive non-login shells (e.g. the VS Code terminal) do NOT read
# /etc/profile.d; /etc/bash.bashrc is the place for that.
grep -qF "\$SCRUB_LINE" /etc/bash.bashrc 2>/dev/null || printf '%s\\n' "\$SCRUB_LINE" >> /etc/bash.bashrc
# ~/.gnupg must exist (mode 700) so the inotify watch on it can start, even if
# the IDE only places the GPG socket later.
install -d -m 700 -o vscode -g vscode /home/vscode/.gnupg 2>/dev/null || true
# Credential guard: strip the forwarded git credential helper + clean up the
# GPG agent and old askpass sockets. Idempotent, so a repeated run rewrites
# nothing.
_huddle_cred_guard() {
  for cfg in /etc/gitconfig /home/vscode/.gitconfig; do
    [ -f "\$cfg" ] && git config --file "\$cfg" --unset-all credential.helper 'vscode-remote-containers' 2>/dev/null || true
  done
  rm -f /home/vscode/.gnupg/S.gpg-agent /home/vscode/.gnupg/S.gpg-agent.* 2>/dev/null || true
  find /tmp -maxdepth 1 \\( -name 'vscode-git-*.sock' -o -name 'vscode-ssh-auth-*.sock' \\) -delete 2>/dev/null || true
}
_huddle_cred_guard   # clean up what was already there on attach
if command -v inotifywait >/dev/null 2>&1; then
  # React immediately if the IDE places the helper/sockets (again) (race ~sub-ms).
  ( inotifywait -q -m -e create -e modify -e moved_to --format '%f' /tmp /etc /home/vscode /home/vscode/.gnupg 2>/dev/null | while IFS= read -r f; do
      case "\$f" in gitconfig|.gitconfig|S.gpg-agent|S.gpg-agent.*|vscode-git-*.sock|vscode-ssh-auth-*.sock) _huddle_cred_guard ;; esac
    done ) &
else
  ( while true; do _huddle_cred_guard; sleep 1; done ) &
fi`;

// ── jb-config.sh — same logic as devcontainer-manager.ps1 ───────────────────

function buildJbConfigScript(containerWorkspace: string, containerName: string, ideName: IdeName, caCertPem: string, seedScript: string): string {
  const ideFilter = ideName === 'rider' ? 'rider' : 'idea';
  const caB64 = Buffer.from(caCertPem, 'utf8').toString('base64');
  return `#!/bin/sh
IDEA_DIR=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i ${ideFilter} | sort -t- -k2 -V | tail -1)
IDEA_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$IDEA_DIR"
BUILD=$(awk -F'"' '/"buildNumber"/ {print $4; exit}' "$IDEA_PATH/product-info.json" 2>/dev/null)
CODE=$(awk -F'"' '/"productCode"/ {print $4; exit}' "$IDEA_PATH/product-info.json" 2>/dev/null)
PROJ="${containerWorkspace}"
mkdir -p /.jbdevcontainer/config/JetBrains
if [ -n "$IDEA_DIR" ]; then
  printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"false","idePath":"%s","buildNumber":"%s","productCode":"%s"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" "$IDEA_PATH" "$BUILD" "$CODE" > /.jbdevcontainer/config/JetBrains/host-config.json
else
  # IDE not yet in dist/ (empty shared volume on a new machine).
  # deploy:true lets IntelliJ download and install the backend itself.
  # After that first deploy the IDE is in the volume and everything works normally.
  echo "[jb-config] IDE not found in dist/, writing host-config with deploy:true so IntelliJ installs the backend"
  printf '{"connectionParams":{"type":"docker","projectPath":"%s","deploy":"true"},"forwardPorts":{},"customizations":{"jetbrains":{}}}' "$PROJ" > /.jbdevcontainer/config/JetBrains/host-config.json
  # Background watcher: once IntelliJ has installed the IDE, import the Huddle CA
  # into the JBR keystore after all (the huddle-ca.crt has been created by then).
  ( i=0
    while [ $i -lt 60 ]; do
      INST=$(ls /.jbdevcontainer/JetBrains/RemoteDev/dist/ 2>/dev/null | grep -i ${ideFilter} | sort -t- -k2 -V | tail -1)
      if [ -n "$INST" ]; then
        INST_PATH="/.jbdevcontainer/JetBrains/RemoteDev/dist/$INST"
        j=0
        while [ ! -x "$INST_PATH/jbr/bin/keytool" ] && [ $j -lt 30 ]; do sleep 10; j=$((j+1)); done
        if [ -x "$INST_PATH/jbr/bin/keytool" ] && [ -f "$INST_PATH/jbr/lib/security/cacerts" ]; then
          "$INST_PATH/jbr/bin/keytool" -delete -alias huddle-ca -keystore "$INST_PATH/jbr/lib/security/cacerts" -storepass changeit >/dev/null 2>&1 || true
          "$INST_PATH/jbr/bin/keytool" -importcert -noprompt -trustcacerts -alias huddle-ca \\
            -file /usr/local/share/ca-certificates/huddle-ca.crt \\
            -keystore "$INST_PATH/jbr/lib/security/cacerts" -storepass changeit >/dev/null 2>&1 \\
            && echo "[jb-config] huddle CA imported in JBR-keystore (after deploy)" \\
            || echo "[jb-config] WARNING: JBR-keystore import failed (after deploy)"
        fi
        break
      fi
      sleep 30; i=$((i+1))
    done ) &
fi

CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

${DOCKER_SOCK_SYMLINK}

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \\
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
iptables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o lo -j ACCEPT
iptables -C OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -C OUTPUT -p tcp -j DROP 2>/dev/null || iptables -A OUTPUT -p tcp -j DROP

# Install huddle's MITM CA in the system trust store + set env vars for tools
# that do not read from the system store (node).
mkdir -p /usr/local/share/ca-certificates
echo '${caB64}' | base64 -d > /usr/local/share/ca-certificates/huddle-ca.crt
chmod 644 /usr/local/share/ca-certificates/huddle-ca.crt
command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true
printf 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt\\n' > /etc/profile.d/99-huddle-ca.sh
chmod 644 /etc/profile.d/99-huddle-ca.sh

${IDE_CRED_SCRUB}

# The JetBrains IDE (IntelliJ/Rider) runs on the JBR, its own JVM that validates
# TLS not against the system store or NODE_EXTRA_CA_CERTS but against its own
# cacerts keystore. Without the import below the IDE rejects the MITM leaf cert and
# the handshake dies, so IDE HTTPS (e.g. api.github.com) ends up in the audit log
# only as an empty CONNECT tunnel. Default keystore password: changeit.
# Skip if the IDE is not yet in dist/ (first connect on a new machine); IntelliJ
# imports the CA itself after the first deployment.
if [ -n "$IDEA_DIR" ]; then
JBR_KEYTOOL="$IDEA_PATH/jbr/bin/keytool"
JBR_CACERTS="$IDEA_PATH/jbr/lib/security/cacerts"
if [ -x "$JBR_KEYTOOL" ] && [ -f "$JBR_CACERTS" ]; then
  "$JBR_KEYTOOL" -delete -alias huddle-ca -keystore "$JBR_CACERTS" -storepass changeit >/dev/null 2>&1 || true
  "$JBR_KEYTOOL" -importcert -noprompt -trustcacerts -alias huddle-ca \\
    -file /usr/local/share/ca-certificates/huddle-ca.crt \\
    -keystore "$JBR_CACERTS" -storepass changeit >/dev/null 2>&1 \\
    && echo "[jb-config] huddle CA imported in JBR-keystore" \\
    || echo "[jb-config] WARNING: JBR-keystore import failed"
else
  echo "[jb-config] WARNING: JBR keytool/cacerts not found at $IDEA_PATH/jbr"
fi
fi

${NOOT_LOCKED_SETUP}

# Fix workspace permissions
mkdir -p "${containerWorkspace}" 2>/dev/null || true
chown -R vscode:vscode "${containerWorkspace}" 2>/dev/null || true
chmod -R u+rwX "${containerWorkspace}" 2>/dev/null || true

${seedScript}

# Configure sudo audit logging
mkdir -p /etc/sudoers.d
printf 'Defaults logfile=/tmp/sudo-audit.log\\n' > /etc/sudoers.d/99-huddle-audit
chmod 440 /etc/sudoers.d/99-huddle-audit 2>/dev/null || true

# Start sudo log forwarder (posts new lines to Huddle API via the proxy)
touch /tmp/sudo-audit.log
( tail -F /tmp/sudo-audit.log 2>/dev/null | while IFS= read -r line; do
    [ -z "\$line" ] && continue
    curl -sf -X POST "http://huddle:3000/api/audit/sudo" \\
      -H "Content-Type: application/json" \\
      -d "{\\"container\\":\\"${containerName}\\",\\"entry\\":\\"\$(echo "\$line" | sed 's/\\"/\\\\\\"/g')\\"}" >/dev/null 2>&1 || true
  done ) &

# Start IDE backend in background; skip if the IDE is not yet in dist/
if [ -n "$IDEA_DIR" ]; then
nohup "$IDEA_PATH/bin/remote-dev-server.sh" run "$PROJ" > "$PROJ/rider-client-diagnose.log" 2>&1 &
fi

`;
}

// ── vsc-config.sh — VS Code variant ─────────────────────────────────────────
// Same firewall/sudo/audit setup as the JB flow, but WITHOUT JB host-config and
// WITHOUT remote-dev-server: VS Code installs its own backend (VS Code Server) on
// attach. Keep this in sync with the vscode branch in huddle.ps1.
// Machine-level VS Code Remote settings that harden the IDE channel (finding #15).
// The VS Code Remote channel goes over `docker exec`/stdio and is seen by NEITHER
// the egress proxy NOR the socket proxy — it is a third bridge between host and
// (untrusted) container. Without this policy an in-container terminal (where an AI
// agent runs) inherits the host credentials forwarded by VS Code, and an
// attacker-controlled `tasks.json` runs automatically when the folder is opened.
// These settings close that off:
//   - terminal.integrated.env.linux → nulls the forwarded credential env, so
//     terminals/agents no longer see GIT_ASKPASS / SSH_AUTH_SOCK / GPG etc.
//     (VS Code's own git integration via the extension host keeps working).
//   - task.allowAutomaticTasks=off → no folderOpen autorun.
//   - security.workspace.trust.* → opened folders start in Restricted Mode.
//   - terminal.integrated.allowLocalTerminal=false → block opening a HOST terminal
//     from the remote window (newLocal).
// Fully locking this down requires Huddle to manage the attach itself (managed
// devcontainer.json with copyGitConfig:false); this is the container-side layer.
export function buildVscodeMachineSettings(): Record<string, unknown> {
  return {
    'security.workspace.trust.enabled': true,
    'security.workspace.trust.startupPrompt': 'always',
    'security.workspace.trust.banner': 'always',
    'security.workspace.trust.emptyWindow': false,
    'task.allowAutomaticTasks': 'off',
    'terminal.integrated.allowLocalTerminal': false,
    // null removes the variable from the terminal environment.
    'terminal.integrated.env.linux': {
      GIT_ASKPASS: null,
      VSCODE_GIT_ASKPASS_NODE: null,
      VSCODE_GIT_ASKPASS_MAIN: null,
      VSCODE_GIT_ASKPASS_EXTRA_ARGS: null,
      VSCODE_GIT_IPC_HANDLE: null,
      SSH_AUTH_SOCK: null,
      GPG_AGENT_INFO: null,
      GPG_TTY: null,
    },
  };
}

function buildVscodeConfigScript(containerWorkspace: string, containerName: string, caCertPem: string, seedScript: string): string {
  const caB64 = Buffer.from(caCertPem, 'utf8').toString('base64');
  const settingsB64 = Buffer.from(JSON.stringify(buildVscodeMachineSettings(), null, 2), 'utf8').toString('base64');
  return `#!/bin/sh
CURL_LINE='--proxy-header "X-Container-ID: ${containerName}"'
grep -qF "$CURL_LINE" /home/vscode/.curlrc 2>/dev/null || echo "$CURL_LINE" >> /home/vscode/.curlrc

${DOCKER_SOCK_SYMLINK}

HUDDLE_IP=$(getent hosts huddle | awk '{print $1}')
iptables -t nat -C OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80" 2>/dev/null || \\
  iptables -t nat -A OUTPUT -p tcp --dport 80 ! -d "$HUDDLE_IP" -j DNAT --to-destination "$HUDDLE_IP:80"
iptables -C OUTPUT -o lo -j ACCEPT 2>/dev/null || iptables -A OUTPUT -o lo -j ACCEPT
iptables -C OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT 2>/dev/null || iptables -A OUTPUT -p tcp -d "$HUDDLE_IP" -j ACCEPT
iptables -C OUTPUT -p tcp -j DROP 2>/dev/null || iptables -A OUTPUT -p tcp -j DROP

# Install huddle's MITM CA in the system trust store + set env vars for tools
# that do not read from the system store (node, java).
mkdir -p /usr/local/share/ca-certificates
echo '${caB64}' | base64 -d > /usr/local/share/ca-certificates/huddle-ca.crt
chmod 644 /usr/local/share/ca-certificates/huddle-ca.crt
command -v update-ca-certificates >/dev/null 2>&1 && update-ca-certificates >/dev/null 2>&1 || true
printf 'export NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt\\n' > /etc/profile.d/99-huddle-ca.sh
chmod 644 /etc/profile.d/99-huddle-ca.sh

${IDE_CRED_SCRUB}

${NOOT_LOCKED_SETUP}

# Fix workspace permissions
mkdir -p "${containerWorkspace}" 2>/dev/null || true
chown -R vscode:vscode "${containerWorkspace}" 2>/dev/null || true
chmod -R u+rwX "${containerWorkspace}" 2>/dev/null || true

${seedScript}

# Finding #15: harden the VS Code Remote IDE channel with machine-level settings.
# Attach-to-running-container reads these from ~/.vscode-server/data/Machine/ (and
# the insiders variant). We write them before the attach so they apply immediately.
for VSCODE_HOME in /home/vscode/.vscode-server /home/vscode/.vscode-server-insiders; do
  mkdir -p "$VSCODE_HOME/data/Machine"
  echo '${settingsB64}' | base64 -d > "$VSCODE_HOME/data/Machine/settings.json"
done
chown -R vscode:vscode /home/vscode/.vscode-server /home/vscode/.vscode-server-insiders 2>/dev/null || true

# Configure sudo audit logging
mkdir -p /etc/sudoers.d
printf 'Defaults logfile=/tmp/sudo-audit.log\\n' > /etc/sudoers.d/99-huddle-audit
chmod 440 /etc/sudoers.d/99-huddle-audit 2>/dev/null || true

# Start sudo log forwarder (posts new lines to Huddle API via the proxy)
touch /tmp/sudo-audit.log
( tail -F /tmp/sudo-audit.log 2>/dev/null | while IFS= read -r line; do
    [ -z "\$line" ] && continue
    curl -sf -X POST "http://huddle:3000/api/audit/sudo" \\
      -H "Content-Type: application/json" \\
      -d "{\\"container\\":\\"${containerName}\\",\\"entry\\":\\"\$(echo "\$line" | sed 's/\\"/\\\\\\"/g')\\"}" >/dev/null 2>&1 || true
  done ) &

`;
}

function toLinuxPath(p: string): string {
  if (p.startsWith('/')) return p;
  const normalized = p.replace(/\\/g, '/');
  const match = normalized.match(/^([a-zA-Z]):\/(.*)/);
  if (match) return `/mnt/${match[1].toLowerCase()}/${match[2]}`;
  return p;
}

interface FolderMount { Type: 'bind' | 'volume'; Source: string; Target: string; ReadOnly?: boolean; }

function buildFolderMounts(containerName: string): FolderMount[] {
  const mappings = listFolderMappings();
  const result: FolderMount[] = [];
  for (const m of mappings) {
    if (!m.enabled) continue;
    const target = m.container_path;
    const readOnly = m.read_only === 1;
    if (m.host_path && m.host_path.trim()) {
      result.push({ Type: 'bind', Source: m.host_path.trim(), Target: target, ReadOnly: readOnly });
    } else if (m.volume_name && m.volume_name.trim()) {
      const volName = m.volume_name.trim().replace('{containerName}', containerName);
      result.push({ Type: 'volume', Source: volName, Target: target, ReadOnly: readOnly });
    }
  }
  return result;
}

export interface StartParams {
  imageName: string;
  workspaceDir: string;     // host path, forward slashes; empty string when empty=true
  containerName: string;
  containerWorkspace: string; // /workspaces/<leaf>
  presentableName: string;
  ideName?: IdeName;
  empty?: boolean;
  memory?: string;
  cpus?: string;
}

function parseMemoryBytes(s: string): number {
  if (!s) return 0;
  const m = s.trim().match(/^(\d+(?:\.\d+)?)\s*([gmkGMK]?)b?$/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const unit = (m[2] || '').toLowerCase();
  if (unit === 'g') return Math.floor(n * 1024 * 1024 * 1024);
  if (unit === 'm') return Math.floor(n * 1024 * 1024);
  if (unit === 'k') return Math.floor(n * 1024);
  return Math.floor(n);
}

function parseCpuQuota(s: string): number {
  if (!s) return 0;
  const n = parseFloat(s.trim());
  if (isNaN(n) || n <= 0) return 0;
  return Math.floor(n * 100000);
}

export async function createAndStartContainer(params: StartParams): Promise<string> {
  const { imageName, workspaceDir, containerName, containerWorkspace, presentableName } = params;
  const ideName = params.ideName ?? 'intellij';
  const empty = params.empty === true;
  // VS Code installs its own backend (VS Code Server) on attach: no JB host-config,
  // no RemoteDev distro volume, no remote-dev-server launch.
  const isVscode = ideName === 'vscode';
  const devcontainerId = crypto.randomUUID().replace(/-/g, '');
  const backend = ideName === 'rider' ? 'Rider' : isVscode ? 'VSCode' : 'IntelliJ';
  const modelJson = `{"customizations":{"jetbrains":{"backend":"${backend}"}}}`;
  const metadataJson = '[{"remoteUser":"vscode"}]';

  try {
    const existing = await inspectContainer(containerName);
    const existingIde = existing?.Config?.Labels?.['com.devcontainer.ide'] ?? ideFromContainerLabels(existing?.Config?.Labels);
    throw new Error(
      `Container '${containerName}' already exists${existingIde ? ` (${existingIde})` : ''}. ` +
      `Remove that container first or choose a different name with --name.`
    );
  } catch (err: any) {
    if (!String(err.message).includes(`Docker API GET /containers/${encodeURIComponent(containerName)}/json → 404:`)) {
      throw err;
    }
  }

  const netName = `dc-net-${containerName}`;
  if (!(await networkExists(netName))) {
    await createNetwork(netName);
  }
  try {
    await connectNetwork(netName, 'huddle');
  } catch (err: any) {
    // Already connected is not an error. Docker and Podman word this differently:
    // Docker → "already exists in network", Podman → "network is already connected".
    const msg = String(err.message);
    if (!msg.includes('already exists in network') && !msg.includes('already connected')) throw err;
  }

  if (!(await imageExists(imageName))) {
    const dockerfilePath = `/base-devimage-${ideName}/Dockerfile`;
    if (!fs.existsSync(dockerfilePath)) {
      throw new Error(`Image '${imageName}' not found and ${dockerfilePath} is not mounted`);
    }
    console.log(`[huddle] Building base image '${imageName}' from ${dockerfilePath}...`);
    await buildImage(imageName, dockerfilePath);
    console.log(`[huddle] Base image '${imageName}' built successfully`);
  }

  // Create per-container Docker socket proxy (injects X-Container-Id for OPA policy)
  await createContainerProxy(containerName, SOCKET_DIR);

  // JB-specific env (host-config path, JBR/RemoteDev data, java-proxy) is skipped
  // for VS Code; the proxy and user env stay the same.
  const env = [
    '_CONTAINER_USER=vscode',
    '_CONTAINER_USER_HOME=/home/vscode',
    '_REMOTE_USER=vscode',
    '_REMOTE_USER_HOME=/home/vscode',
    'http_proxy=http://huddle:80',
    'https_proxy=http://huddle:80',
    'HTTP_PROXY=http://huddle:80',
    'HTTPS_PROXY=http://huddle:80',
    // Loopback must never go via the proxy: it cannot reach the container's own
    // loopback. The bracketed form `[::1]` is included explicitly because
    // .NET/Aspire's DCP addresses its targets as `http://[::1]:<port>` and
    // NO_PROXY matches literally against that bracketed host (issue #12).
    'no_proxy=localhost,127.0.0.1,::1,[::1]',
    'NO_PROXY=localhost,127.0.0.1,::1,[::1]',
    // CA trust at the container level so EVERY process trusts the MITM CA — not
    // only login shells that source /etc/profile.d. Without this, tools started by
    // the IDE/non-login shell validate against their own bundle, reject the leaf
    // cert and you see only an empty CONNECT tunnel.
    // NODE_EXTRA_CA_CERTS = standalone huddle cert (Node adds it to its bundle).
    // SSL_CERT_FILE/REQUESTS_CA_BUNDLE = the combined system bundle (huddle + all
    // normal roots) that update-ca-certificates regenerates, so TLS to
    // non-intercepted hosts keeps working.
    'NODE_EXTRA_CA_CERTS=/usr/local/share/ca-certificates/huddle-ca.crt',
    'SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt',
    'REQUESTS_CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt',
    // The docker proxy socket is in the mounted directory /var/run/huddle (see
    // Mounts). DOCKER_HOST lets docker/compose/SDKs find it there; for tools that
    // hardcode the default path the config script also places a symlink at
    // /var/run/docker.sock.
    'DOCKER_HOST=unix:///var/run/huddle/docker.sock',
    ...(isVscode ? [] : [
      'DEVCONTAINER_CONFIG_PATH=/.jbdevcontainer/config/JetBrains/host-config.json',
      'XDG_DATA_HOME=/.jbdevcontainer/data',
      'JAVA_TOOL_OPTIONS=-Dhttp.proxyHost=huddle -Dhttp.proxyPort=80 -Dhttps.proxyHost=huddle -Dhttps.proxyPort=80 -Dhttp.nonProxyHosts=localhost|127.*|[::1]',
    ]),
  ];

  const effectiveSource = empty ? '' : await ensureWorktree(toLinuxPath(workspaceDir), containerName);

  const folderMounts = buildFolderMounts(containerName);

  // The RemoteDev distro volume is JB-only; VS Code does not need it.
  const mounts = [
    ...folderMounts,
    ...(isVscode ? [] : [{
      Type: 'volume',
      Source: 'jb_devcontainers_shared_volume',
      Target: '/.jbdevcontainer/JetBrains/RemoteDev/dist',
    }]),
    ...(empty ? [] : [{
      Type: 'bind',
      Source: effectiveSource,
      Target: containerWorkspace,
    }]),
    {
      // Mount the per-container socket DIRECTORY, not the socket file itself: a
      // file bind pins the inode and after a huddle restart (unlink + new socket)
      // points forever at the dead old socket. Via the directory the container
      // always sees the current socket; DOCKER_HOST (env) and the symlink
      // /var/run/docker.sock (config script) point to it.
      Type: 'bind',
      Source: `${SOCKET_DIR}/${containerName}`,
      Target: '/var/run/huddle',
    },
  ];

  const createBody = {
    Image: imageName,
    Entrypoint: ['/bin/sh'],
    Cmd: ['-c', 'while sleep 1000; do :; done'],
    Env: env,
    Labels: {
      'com.intellij.devcontainer.id': devcontainerId,
      'com.intellij.devcontainer.presentable.name': presentableName,
      'com.intellij.devcontainer.sources.path': empty ? '' : workspaceDir,
      'com.intellij.devcontainer.workspace.path': containerWorkspace,
      'com.intellij.devcontainer.model': modelJson,
      'com.devcontainer.ide': ideName,
      'devcontainer.metadata': metadataJson,
    },
    HostConfig: {
      Mounts: mounts,
      NetworkMode: netName,
      CapAdd: ['NET_ADMIN'],
      ...(RUNTIME_SECURITY_OPT.length ? { SecurityOpt: RUNTIME_SECURITY_OPT } : {}),
      Memory: parseMemoryBytes(params.memory || getSetting('defaultMemory') || '8g'),
      CpuQuota: parseCpuQuota(params.cpus || getSetting('defaultCpus') || '2'),
      CpuPeriod: 100000,
    },
  };

  const created = await dockerRequest('POST', `/containers/create?name=${encodeURIComponent(containerName)}`, createBody);
  const id: string = created.Id;
  await dockerRequest('POST', `/containers/${id}/start`, {});

  const containerPaths = folderMounts.map(m => m.Target);
  const seedScript = buildFolderMappingSeedScript(containerPaths);

  // Run config script via exec — VS Code variant without JB host-config/backend.
  const script = isVscode
    ? buildVscodeConfigScript(containerWorkspace, containerName, getCaCertPem(), seedScript)
    : buildJbConfigScript(containerWorkspace, containerName, ideName, getCaCertPem(), seedScript);
  const execCreate = await dockerRequest('POST', `/containers/${id}/exec`, {
    User: 'root',
    Cmd: ['sh', '-c', script],
  });
  await dockerRequest('POST', `/exec/${execCreate.Id}/start`, { Detach: true });

  // No standing password anymore: 'noot' is created locked. Admin access now goes
  // via an ephemeral sudo grant (POST /api/docker/containers/:name/sudo-grant).

  return id;
}
