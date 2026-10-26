// ── Inbound SSH into a devcontainer (JetBrains Toolbox "Connect IDE") ───────
// The devcontainer networks are Internal, so a container port can never be
// published. Instead the gateway — already attached to every dc-net-* network —
// runs a plain TCP relay per container (ssh-relay.ts) on a port published to the
// host's loopback only. The SSH protocol itself is end-to-end between the IDE on
// the host and sshd inside the container. The key pair is Huddle's own, made and
// kept on the host by the host agent (cli/src/pipe/ssh-hosts.ts); the gateway
// only ever sees its public key, and never the content.
//
// This module holds the pure parts (config, link, key validation, port choice)
// so they can be unit-tested without Docker.

/** Host-loopback port range for the SSH relays. Must match `huddle init` (cli/src/init.ts). */
export const SSH_RELAY_PORT_MIN = 2200;
export const SSH_RELAY_PORT_MAX = 2219;

/** The only account that may log in over SSH. `noot` (admin) never does. */
export const SSH_USER = 'vscode';

// Root-owned paths, so the (untrusted) container user cannot add keys or change
// the daemon config. sshd's StrictModes rejects anything user-writable anyway.
const SSHD_CONFIG = '/etc/ssh/huddle_sshd_config';
const HOST_KEY = '/etc/ssh/huddle_host_ed25519_key';
/** The container's host key, pinned in the host's known_hosts for its alias. */
export const HOST_KEY_PUB = `${HOST_KEY}.pub`;
// Container ID the host key was generated for. A snapshot copies /etc/ssh into
// every container started from it; the ID mismatch makes each one regenerate.
const HOST_KEY_OWNER = '/etc/ssh/huddle_host_key.owner';
const AUTHORIZED_KEYS_DIR = '/etc/ssh/huddle_authorized_keys';
const PID_FILE = '/run/huddle-sshd.pid';

// Container env forwarded into SSH sessions. sshd starts sessions with a clean
// environment, so without this the IDE backend has no proxy, no CA trust and no
// Docker socket. XDG_DATA_HOME is deliberately left out: it points at a
// root-owned JetBrains dir that the SSH user cannot write.
export const SSH_SESSION_ENV_KEYS = [
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE',
  'DOCKER_HOST', 'JAVA_TOOL_OPTIONS',
];

const KEY_TYPES = [
  'ssh-ed25519', 'ssh-rsa',
  'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521',
  'sk-ssh-ed25519@openssh.com', 'sk-ecdsa-sha2-nistp256@openssh.com',
];
const KEY_LINE = new RegExp(`^(${KEY_TYPES.map(t => t.replace(/[.@]/g, '\\$&')).join('|')}) [A-Za-z0-9+/]+={0,3}( [\\x20-\\x7e]*)?$`);
const MAX_KEYS_BYTES = 16 * 1024;

/**
 * Validate and normalise public key(s) for authorized_keys (Huddle's own, from
 * the host agent): one key per line, each
 * `<type> <base64> [comment]`. Lines starting with authorized_keys options
 * (`command=`, `from=`, …) do not match and are rejected. Returns the normalised
 * text or throws with a readable reason.
 */
export function normalizeSshPublicKeys(raw: string): string {
  if (typeof raw !== 'string') throw new Error('sshPublicKey must be a string');
  if (Buffer.byteLength(raw, 'utf8') > MAX_KEYS_BYTES) throw new Error('sshPublicKey is too long');
  const lines = raw.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    if (!KEY_LINE.test(line)) {
      throw new Error(`sshPublicKey line ${i + 1} is not an OpenSSH public key (expected e.g. "ssh-ed25519 AAAA… comment")`);
    }
  }
  return lines.join('\n');
}

/** First free port in [min, max] that is not in `used`, or null when the range is full. */
export function pickFreePort(used: Iterable<number>, min = SSH_RELAY_PORT_MIN, max = SSH_RELAY_PORT_MAX): number | null {
  const taken = new Set(used);
  for (let p = min; p <= max; p++) if (!taken.has(p)) return p;
  return null;
}

/**
 * Pick the session env from the container's own Env (`KEY=value` strings).
 * Values with a quote, backslash or control character are dropped instead of
 * being escaped into sshd_config.
 */
export function sessionEnvFromContainer(containerEnv: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of containerEnv ?? []) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq);
    const value = entry.slice(eq + 1);
    if (!SSH_SESSION_ENV_KEYS.includes(key)) continue;
    if (/["\\\x00-\x1f\x7f]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Hardened sshd config. Everything that would let the container reach back into
 * the host is off: agent forwarding (host credentials, finding #15), remote and
 * unix-socket forwarding (a listener in the container tunnelled to the host's
 * network would bypass the egress proxy), tunnels and X11. Local forwarding
 * stays on: JetBrains Gateway talks to its backend through it, and it only goes
 * host → container.
 */
export function buildSshdConfig(env: Record<string, string>): string {
  const setEnv = Object.entries(env).map(([k, v]) => `SetEnv "${k}=${v}"`);
  return [
    '# Generated by Huddle — do not edit; rewritten on every SSH link request.',
    'Port 22',
    `HostKey ${HOST_KEY}`,
    `PidFile ${PID_FILE}`,
    `AuthorizedKeysFile ${AUTHORIZED_KEYS_DIR}/%u`,
    `AllowUsers ${SSH_USER}`,
    'PermitRootLogin no',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'PermitEmptyPasswords no',
    // With PAM the locked-password check is skipped, so the dev user (whose
    // password is locked) can still log in with a key.
    'UsePAM yes',
    'PermitUserEnvironment no',
    'AllowAgentForwarding no',
    'AllowTcpForwarding local',
    'AllowStreamLocalForwarding no',
    'GatewayPorts no',
    'PermitTunnel no',
    'X11Forwarding no',
    // PAM (pam_motd) already shows the motd; sshd would print it a second time.
    'PrintMotd no',
    // JetBrains Gateway uploads files (and, on first use, the backend) over SFTP.
    'Subsystem sftp internal-sftp',
    ...setEnv,
    '',
  ].join('\n');
}

/**
 * Root script that (re)configures and starts sshd in the container. The public
 * key(s) arrive on stdin — read FIRST, before apt-get could consume stdin.
 * Exit codes: 3 = openssh-server missing and not installable, 4 = config invalid,
 * 5 = sshd did not start.
 */
export function buildEnsureSshdScript(sshdConfig: string, containerId: string): string {
  if (!/^[a-f0-9]{12,64}$/.test(containerId)) throw new Error(`invalid container id: ${containerId}`);
  const cfgB64 = Buffer.from(sshdConfig, 'utf8').toString('base64');
  return `set -e
umask 022
KEYS=$(cat)
if [ ! -x /usr/sbin/sshd ]; then
  export DEBIAN_FRONTEND=noninteractive
  if ! { apt-get update -qq && apt-get install -y --no-install-recommends openssh-server; } >/tmp/huddle-sshd-install.log 2>&1 </dev/null; then
    echo "openssh-server is not installed and could not be installed (see /tmp/huddle-sshd-install.log in the container)" >&2
    exit 3
  fi
fi
mkdir -p /run/sshd ${AUTHORIZED_KEYS_DIR}
chmod 755 ${AUTHORIZED_KEYS_DIR}
if [ ! -f ${HOST_KEY} ] || [ "$(cat ${HOST_KEY_OWNER} 2>/dev/null)" != '${containerId}' ]; then
  rm -f ${HOST_KEY} ${HOST_KEY}.pub
  ssh-keygen -q -t ed25519 -N '' -f ${HOST_KEY}
  echo '${containerId}' > ${HOST_KEY_OWNER}
fi
printf '%s\\n' "$KEYS" > ${AUTHORIZED_KEYS_DIR}/${SSH_USER}
chown root:root ${AUTHORIZED_KEYS_DIR}/${SSH_USER}
chmod 644 ${AUTHORIZED_KEYS_DIR}/${SSH_USER}
echo '${cfgB64}' | base64 -d > ${SSHD_CONFIG}
chmod 644 ${SSHD_CONFIG}
/usr/sbin/sshd -t -f ${SSHD_CONFIG} 2>/tmp/huddle-sshd-check.log || { cat /tmp/huddle-sshd-check.log >&2; exit 4; }
if [ -f ${PID_FILE} ] && kill -0 "$(cat ${PID_FILE})" 2>/dev/null; then
  kill -HUP "$(cat ${PID_FILE})"
else
  /usr/sbin/sshd -f ${SSHD_CONFIG} -E /tmp/huddle-sshd.log || exit 5
fi
`;
}

/**
 * The host's ssh alias for a devcontainer: `ssh <name>.huddle` and the IDE link
 * reach it through the entry the host agent writes (op `ssh.host`).
 */
export function sshAlias(containerName: string): string {
  return `${containerName}.huddle`;
}

/**
 * JetBrains Toolbox link that opens an IDE over SSH to `sshHost` (an ssh config
 * alias), optionally in a POSIX project folder. encodeURIComponent, not
 * URLSearchParams: the latter turns spaces into '+', which Toolbox reads literally.
 */
export function buildToolboxSshLink(sshHost: string, folder?: string): string {
  const params: [string, string][] = [['h', sshHost], ['launchIde', 'true']];
  if (folder && folder.startsWith('/')) params.push(['projectHint', folder]);
  return 'jetbrains://gateway/ssh/environment?' + params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
}
