// ── SSH access for devcontainers and sbx sandboxes (Stage 2) ──────────────────
// One RSA-2048 keypair and one fixed host port per target, minted the first
// time that target starts. node-forge has no OpenSSH-wire-format exporter, so
// the public key is hand-encoded here; the private key stays PEM (that's what
// an `ssh -i` client wants).

import forge from 'node-forge';
import { db } from './db';

export type SshTargetKind = 'devcontainer' | 'sbx';

export interface SshAccess {
  targetId: string;
  kind: SshTargetKind;
  port: number;
  privateKey: string;
  publicKey: string;
}

const SSH_PORT_MIN = 24850;
const SSH_PORT_MAX = 24899;

/** Big-endian bytes of a forge BigInteger, with no sign-related padding. */
function bigIntToBytes(n: forge.jsbn.BigInteger): Buffer {
  let hex = n.toString(16);
  if (hex.length % 2 !== 0) hex = '0' + hex;
  return Buffer.from(hex, 'hex');
}

/** SSH "string" framing: 4-byte big-endian length prefix + raw bytes. */
function sshString(bytes: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/**
 * SSH "mpint" framing: an sshString of the value's bytes, with a leading 0x00
 * prepended when the high bit of the first byte would otherwise be set —
 * mpint values are interpreted as SIGNED big-endian integers, and an RSA
 * exponent/modulus must always encode positive.
 */
function mpint(n: forge.jsbn.BigInteger): Buffer {
  const bytes = bigIntToBytes(n);
  const needsPad = bytes.length > 0 && (bytes[0] & 0x80) !== 0;
  return sshString(needsPad ? Buffer.concat([Buffer.from([0x00]), bytes]) : bytes);
}

/** Encode an RSA public key as the OpenSSH `authorized_keys` line format. */
export function encodeOpenSshPublicKey(publicKey: forge.pki.rsa.PublicKey): string {
  const blob = Buffer.concat([
    sshString(Buffer.from('ssh-rsa', 'ascii')),
    mpint(publicKey.e),
    mpint(publicKey.n),
  ]);
  return `ssh-rsa ${blob.toString('base64')}`;
}

function generateSshKeypair(): { privateKeyPem: string; publicKeyLine: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  return {
    privateKeyPem: forge.pki.privateKeyToPem(keys.privateKey),
    publicKeyLine: encodeOpenSshPublicKey(keys.publicKey),
  };
}

interface SshAccessRow {
  target_id: string;
  kind: string;
  port: number;
  private_key: string;
  public_key: string;
  created: number;
}

function fromRow(row: SshAccessRow): SshAccess {
  return {
    targetId: row.target_id,
    kind: row.kind as SshTargetKind,
    port: row.port,
    privateKey: row.private_key,
    publicKey: row.public_key,
  };
}

/**
 * The lowest free port in [24850, 24899] not already claimed by another
 * target's ssh_access row. Throws once all 50 are taken.
 */
export function allocateSshPort(): number {
  const taken = new Set(
    (db.prepare('SELECT port FROM ssh_access').all() as { port: number }[]).map((r) => r.port)
  );
  for (let port = SSH_PORT_MIN; port <= SSH_PORT_MAX; port++) {
    if (!taken.has(port)) return port;
  }
  throw new Error(`ssh port pool exhausted (${SSH_PORT_MIN}-${SSH_PORT_MAX} all in use)`);
}

/**
 * Mint fresh SSH access for a target: a new keypair and a newly allocated
 * port, overwriting whatever that target held before (ON CONFLICT, mirroring
 * mintSandboxIdentity — a re-provisioned target is not the same identity as
 * the one it replaces). Called once, right before the target is created —
 * the port gets baked into the container's port binding / sandbox sshd
 * config at that moment, so it must exist before that happens.
 */
export function provisionSshAccess(targetId: string, kind: SshTargetKind): SshAccess {
  const { privateKeyPem, publicKeyLine } = generateSshKeypair();
  const port = allocateSshPort();
  const created = Math.floor(Date.now() / 1000);
  db.prepare(
    `INSERT INTO ssh_access (target_id, kind, port, private_key, public_key, created)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(target_id) DO UPDATE SET
       kind = excluded.kind, port = excluded.port,
       private_key = excluded.private_key, public_key = excluded.public_key, created = excluded.created`
  ).run(targetId, kind, port, privateKeyPem, publicKeyLine, created);
  return { targetId, kind, port, privateKey: privateKeyPem, publicKey: publicKeyLine };
}

/** Full row including the plaintext private key — the one legitimate reader of it. */
export function getSshAccess(targetId: string): SshAccess | undefined {
  const row = db.prepare('SELECT * FROM ssh_access WHERE target_id = ?').get(targetId) as SshAccessRow | undefined;
  return row ? fromRow(row) : undefined;
}

export function hasSshAccess(targetId: string): boolean {
  return db.prepare('SELECT 1 FROM ssh_access WHERE target_id = ?').get(targetId) !== undefined;
}

/** Drop a target's row (and free its port) — call when the target is removed. */
export function dropSshAccess(targetId: string): void {
  db.prepare('DELETE FROM ssh_access WHERE target_id = ?').run(targetId);
}
