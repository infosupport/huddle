import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { sbxKit } from '../src/pipe/sbx-kit';

const PEM = '-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIUQ==\n-----END CERTIFICATE-----\n';

let tmp: string;
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-kit-'));
  fs.chmodSync(tmp, 0o700);
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('sbx.kit', () => {
  it('writes a v2 mixin that installs the CA as root and points the variables at the system bundle', () => {
    const root = path.join(tmp, 'kits');
    const { dir } = sbxKit({ caPem: PEM }, root);
    expect(dir).toBe(path.join(root, 'huddle-ca'));
    const spec = fs.readFileSync(path.join(dir, 'spec.yaml'), 'utf8');
    expect(spec).toContain('schemaVersion: "2"\nkind: mixin\nname: huddle-ca\n');
    expect(spec).toContain('NODE_EXTRA_CA_CERTS: /etc/ssl/certs/ca-certificates.crt');
    expect(spec).toMatch(/command: "sh \/home\/agent\/\.huddle-ca\/install\.sh"\n\s+user: "0"/);
    // sbx wants startup's command as a list: a string fails `sbx create` ("cannot unmarshal !!str into []string").
    expect(spec).toContain('startup:\n    - command: ["sh", "/home/agent/.huddle-ca/jbr-watch.sh"]\n');
    const home = path.join(dir, 'files', 'home', '.huddle-ca');
    expect(fs.readFileSync(path.join(home, 'huddle-ca.crt'), 'utf8')).toBe(PEM);
    expect(fs.readFileSync(path.join(home, 'install.sh'), 'utf8')).toContain('update-ca-certificates');
    expect(fs.readFileSync(path.join(home, 'jbr-watch.sh'), 'utf8')).toContain('-alias huddle-ca');
    // Rewritten, not appended to, on the next create.
    sbxKit({ caPem: PEM }, root);
    expect(fs.readFileSync(path.join(home, 'huddle-ca.crt'), 'utf8')).toBe(PEM);
  });

  it('writes a v3 mixin on request: the files in an image layer outside /home/agent, the install hook gets the sbx proxy CA', () => {
    const root = path.join(tmp, 'kits');
    const { dir, format } = sbxKit({ caPem: PEM, format: 3 }, root);
    expect(format).toBe(3);
    const spec = fs.readFileSync(path.join(dir, 'huddle-ca.yaml'), 'utf8');
    expect(spec).toMatch(/^# syntax=docker\/sandbox-kit:3\nschemaVersion: "3"\nkind: mixin\n/);
    expect(spec).toContain('COPY share/ /usr/local/share/huddle-ca/');
    expect(spec).toContain('ENV NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt SSL_CERT_FILE=');
    expect(spec).toContain('- type: com.docker.sandbox/lifecycle@1');
    expect(spec).toMatch(/command: "sh \/usr\/local\/share\/huddle-ca\/install\.sh"\n\s+user: "0"\n\s+env: \[PROXY_CA_CERT_B64\]/);
    expect(spec).toContain('startup:\n        - command: ["sh", "/usr/local/share/huddle-ca/jbr-watch.sh"]\n');
    const share = path.join(dir, 'share');
    expect(fs.readFileSync(path.join(share, 'huddle-ca.crt'), 'utf8')).toBe(PEM);
    expect(fs.readFileSync(path.join(share, 'install.sh'), 'utf8')).toContain('install -m 0644 /usr/local/share/huddle-ca/huddle-ca.crt ');
    expect(fs.readFileSync(path.join(share, 'jbr-watch.sh'), 'utf8')).toContain('CA=/usr/local/share/huddle-ca/huddle-ca.crt');
    // No v2 leftovers for sbx to trip over, and back again.
    expect(fs.existsSync(path.join(dir, 'spec.yaml'))).toBe(false);
    sbxKit({ caPem: PEM }, root);
    expect(fs.readdirSync(dir).sort()).toEqual(['files', 'spec.yaml']);
  });

  it('writes LF only, also from a CRLF certificate', () => {
    const { dir } = sbxKit({ caPem: PEM.replace(/\n/g, '\r\n') }, path.join(tmp, 'kits'));
    for (const f of ['spec.yaml', 'files/home/.huddle-ca/huddle-ca.crt', 'files/home/.huddle-ca/install.sh']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('\r');
    }
  });

  it('refuses anything but one PEM certificate', () => {
    const root = path.join(tmp, 'kits');
    expect(() => sbxKit({}, root)).toThrow(/PEM/);
    expect(() => sbxKit({ caPem: PEM, format: 4 }, root)).toThrow(/format/);
    expect(() => sbxKit({ caPem: `${PEM}"\nsetup: x` }, root)).toThrow(/PEM/);
    expect(() => sbxKit({ caPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n' }, root)).toThrow(/PEM/);
  });
});
