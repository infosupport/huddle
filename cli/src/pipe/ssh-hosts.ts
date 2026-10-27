// ── Host pipe ops `ssh.key` and `ssh.host`: SSH into a devcontainer, no key setup ──
// Like `sbx setup ssh` does for Docker Sandboxes: Huddle keeps its own key pair in
// ~/.huddle/ssh (made here, on the host, so the private key never leaves it) and
// one ssh config entry per devcontainer, `<name>.huddle`, in ~/.huddle/ssh/hosts.
// ~/.ssh/config includes those at its top, so the IDE (JetBrains Toolbox), and
// `ssh <name>.huddle` in a terminal, connect without asking for a key.
//
// The gateway only ever gets the public key (`ssh.key`), which it puts in the
// container's authorized_keys. `ssh.host` writes the entry with the container's
// host key pinned, so the connection is verified without a fingerprint prompt.

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG_DIR } from '../config';
import { PipeError, ensurePrivateDir } from './protocol';

export const SSH_DIR = path.join(CONFIG_DIR, 'ssh');
const KEY_FILE = 'id_ed25519';

/** The line Huddle puts at the top of ~/.ssh/config. Hosts in an included file stay in it. */
export const INCLUDE_LINE = 'Include ~/.huddle/ssh/hosts/*.conf';

// Docker container names ([a-zA-Z0-9][a-zA-Z0-9_.-]*) plus `.huddle`; also a file name here.
const ALIAS_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}\.huddle$/;
const USER_RE = /^[a-z_][a-z0-9_-]{0,31}$/;
const HOST_KEY_RE = /^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$/;

export interface SshDirs {
  /** ~/.huddle/ssh */
  huddle: string;
  /** ~/.ssh */
  user: string;
}

const DEFAULT_DIRS: SshDirs = { huddle: SSH_DIR, user: path.join(os.homedir(), '.ssh') };

function sshString(b: Buffer | string): Buffer {
  const buf = typeof b === 'string' ? Buffer.from(b) : b;
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length);
  return Buffer.concat([len, buf]);
}

/** A new ed25519 key pair in OpenSSH's formats (unencrypted private key, `ssh-ed25519 …` public key). */
export function generateEd25519(comment: string): { privateKey: string; publicKey: string } {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = privateKey.export({ format: 'jwk' });
  const seed = Buffer.from(jwk.d!, 'base64url');
  const pub = Buffer.from(jwk.x!, 'base64url');
  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);
  const check = crypto.randomBytes(4);
  let priv = Buffer.concat([check, check, sshString('ssh-ed25519'), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const pad = (8 - (priv.length % 8)) % 8;
  priv = Buffer.concat([priv, Buffer.from(Array.from({ length: pad }, (_, i) => i + 1))]);
  const body = Buffer.concat([
    Buffer.from('openssh-key-v1\0'),
    sshString('none'), sshString('none'), sshString(''),
    Buffer.from([0, 0, 0, 1]),
    sshString(pubBlob),
    sshString(priv),
  ]).toString('base64');
  return {
    privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${body.match(/.{1,70}/g)!.join('\n')}\n-----END OPENSSH PRIVATE KEY-----\n`,
    publicKey: `ssh-ed25519 ${pubBlob.toString('base64')} ${comment}`,
  };
}

/** Huddle's public key, after making the key pair if there is none. */
function ensureKey(dir: string): string {
  ensurePrivateDir(dir);
  const keyPath = path.join(dir, KEY_FILE);
  const pubPath = `${keyPath}.pub`;
  if (fs.existsSync(keyPath) && fs.existsSync(pubPath)) return fs.readFileSync(pubPath, 'utf8').trim();
  const { privateKey, publicKey } = generateEd25519(`huddle@${os.hostname()}`);
  fs.rmSync(keyPath, { force: true });
  fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
  fs.writeFileSync(pubPath, `${publicKey}\n`, { mode: 0o644 });
  return publicKey;
}

/** Puts INCLUDE_LINE at the top of ~/.ssh/config (making it when there is none). */
export function ensureInclude(userDir: string): void {
  const file = path.join(userDir, 'config');
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    fs.mkdirSync(userDir, { recursive: true, mode: 0o700 });
  }
  if (text.split(/\r?\n/).some((l) => l.trim() === INCLUDE_LINE)) return;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // At the top: an Include after a Host block would only apply inside that block.
  const head = `# Added by Huddle: SSH into devcontainers as <name>.huddle${eol}${INCLUDE_LINE}${eol}`;
  fs.writeFileSync(file, text ? `${head}${eol}${text}` : head, { mode: 0o600 });
}

function prepare(dirs: SshDirs): string {
  try {
    const publicKey = ensureKey(dirs.huddle);
    ensurePrivateDir(path.join(dirs.huddle, 'hosts'));
    ensureInclude(dirs.user);
    return publicKey;
  } catch (err) {
    throw new PipeError('internal', `could not prepare SSH: ${(err as Error).message ?? err}`);
  }
}

/** The `ssh.key` op: Huddle's public key. */
export function sshKey(_args: Record<string, unknown>, dirs: SshDirs = DEFAULT_DIRS): { publicKey: string } {
  return { publicKey: prepare(dirs) };
}

/**
 * The `ssh.host` op: (re)writes the entry for one devcontainer,
 * `{ alias, port, user, hostKey }`, or removes it with `{ alias, remove: true }`.
 */
export function sshHost(args: Record<string, unknown>, dirs: SshDirs = DEFAULT_DIRS): { publicKey: string | null } {
  const { alias, port, user, hostKey, remove } = args;
  if (typeof alias !== 'string' || !ALIAS_RE.test(alias)) throw new PipeError('bad_request', 'alias must be <container name>.huddle');
  const hosts = path.join(dirs.huddle, 'hosts');
  const conf = path.join(hosts, `${alias}.conf`);
  const known = path.join(hosts, `${alias}.known_hosts`);
  if (remove === true) {
    fs.rmSync(conf, { force: true });
    fs.rmSync(known, { force: true });
    return { publicKey: null };
  }
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) throw new PipeError('bad_request', 'port must be 1-65535');
  if (typeof user !== 'string' || !USER_RE.test(user)) throw new PipeError('bad_request', 'invalid user');
  if (typeof hostKey !== 'string' || !HOST_KEY_RE.test(hostKey.trim())) throw new PipeError('bad_request', 'hostKey must be an ssh-ed25519 public key');
  const publicKey = prepare(dirs);
  try {
    fs.writeFileSync(known, `${alias} ${hostKey.trim()}\n`, { mode: 0o600 });
    fs.writeFileSync(conf, [
      '# Generated by Huddle; rewritten on every Connect IDE.',
      `Host ${alias}`,
      '  HostName localhost',
      `  Port ${port}`,
      `  User ${user}`,
      `  IdentityFile ~/.huddle/ssh/${KEY_FILE}`,
      '  IdentitiesOnly yes',
      `  HostKeyAlias ${alias}`,
      `  UserKnownHostsFile ~/.huddle/ssh/hosts/${alias}.known_hosts`,
      '  StrictHostKeyChecking yes',
      '',
    ].join('\n'), { mode: 0o600 });
  } catch (err) {
    throw new PipeError('internal', `could not write the SSH entry: ${(err as Error).message ?? err}`);
  }
  return { publicKey };
}
