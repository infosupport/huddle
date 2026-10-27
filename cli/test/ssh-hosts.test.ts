import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { INCLUDE_LINE, ensureInclude, generateEd25519, sshHost, sshKey } from '../src/pipe/ssh-hosts';

const HOST_KEY = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOMqqnkVzrm0SdG6UOoqKLsabgH5C9okWi0dh2l9GKJl';

let tmp: string;
let dirs: { huddle: string; user: string };

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ssh-'));
  fs.chmodSync(tmp, 0o700);
  dirs = { huddle: path.join(tmp, 'huddle', 'ssh'), user: path.join(tmp, 'dotssh') };
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('generateEd25519', () => {
  it('writes a private key OpenSSH reads back to the same public key', () => {
    const { privateKey, publicKey } = generateEd25519('huddle@test');
    const file = path.join(tmp, 'k');
    fs.writeFileSync(file, privateKey, { mode: 0o600 });
    const derived = execFileSync('ssh-keygen', ['-y', '-f', file], { encoding: 'utf8' }).trim();
    expect(derived.split(' ').slice(0, 2)).toEqual(publicKey.split(' ').slice(0, 2));
  });
});

describe('ssh.key', () => {
  it('makes the key pair once, private key owner-only, and returns the public key', () => {
    const { publicKey } = sshKey({}, dirs);
    expect(publicKey).toMatch(/^ssh-ed25519 \S+ huddle@/);
    expect(fs.statSync(path.join(dirs.huddle, 'id_ed25519')).mode & 0o777).toBe(0o600);
    expect(sshKey({}, dirs).publicKey).toBe(publicKey);
  });

  it('puts the Include at the top of an existing ~/.ssh/config, once', () => {
    fs.mkdirSync(dirs.user);
    fs.writeFileSync(path.join(dirs.user, 'config'), 'Host work\n  User me\n');
    sshKey({}, dirs);
    sshKey({}, dirs);
    const text = fs.readFileSync(path.join(dirs.user, 'config'), 'utf8');
    expect(text.split('\n').filter(l => l === INCLUDE_LINE)).toHaveLength(1);
    expect(text.indexOf(INCLUDE_LINE)).toBeLessThan(text.indexOf('Host work'));
    expect(text).toContain('Host work\n  User me\n');
  });

  it('makes ~/.ssh/config when there is none and keeps CRLF files CRLF', () => {
    ensureInclude(dirs.user);
    expect(fs.readFileSync(path.join(dirs.user, 'config'), 'utf8')).toContain(INCLUDE_LINE);
    const crlf = path.join(tmp, 'crlf');
    fs.mkdirSync(crlf);
    fs.writeFileSync(path.join(crlf, 'config'), 'Host a\r\n  User b\r\n');
    ensureInclude(crlf);
    expect(fs.readFileSync(path.join(crlf, 'config'), 'utf8')).not.toMatch(/[^\r]\n/);
  });
});

describe('ssh.host', () => {
  it('writes the entry with Huddle\'s key and the pinned host key, and removes it', () => {
    const { publicKey } = sshHost({ alias: 'my-dc.huddle', port: 2201, user: 'vscode', hostKey: HOST_KEY }, dirs);
    expect(publicKey).toMatch(/^ssh-ed25519 /);
    const conf = fs.readFileSync(path.join(dirs.huddle, 'hosts', 'my-dc.huddle.conf'), 'utf8');
    expect(conf).toContain('Host my-dc.huddle\n');
    expect(conf).toContain('  Port 2201\n');
    expect(conf).toContain('  User vscode\n');
    expect(conf).toContain('  IdentityFile ~/.huddle/ssh/id_ed25519\n');
    expect(conf).toContain('  StrictHostKeyChecking yes\n');
    expect(fs.readFileSync(path.join(dirs.huddle, 'hosts', 'my-dc.huddle.known_hosts'), 'utf8')).toBe(`my-dc.huddle ${HOST_KEY}\n`);

    sshHost({ alias: 'my-dc.huddle', remove: true }, dirs);
    expect(fs.readdirSync(path.join(dirs.huddle, 'hosts'))).toEqual([]);
  });

  it('refuses anything that could inject into the ssh config', () => {
    const ok = { alias: 'dc.huddle', port: 2200, user: 'vscode', hostKey: HOST_KEY };
    expect(() => sshHost({ ...ok, alias: '../x.huddle' }, dirs)).toThrow(/alias/);
    expect(() => sshHost({ ...ok, alias: 'dc\n  ProxyCommand x.huddle' }, dirs)).toThrow(/alias/);
    expect(() => sshHost({ ...ok, alias: 'dc' }, dirs)).toThrow(/alias/);
    expect(() => sshHost({ ...ok, port: 0 }, dirs)).toThrow(/port/);
    expect(() => sshHost({ ...ok, user: 'root\n  X y' }, dirs)).toThrow(/user/);
    expect(() => sshHost({ ...ok, hostKey: `${HOST_KEY}\nevil` }, dirs)).toThrow(/hostKey/);
  });
});
