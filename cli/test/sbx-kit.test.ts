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

  it('writes LF only, also from a CRLF certificate', () => {
    const { dir } = sbxKit({ caPem: PEM.replace(/\n/g, '\r\n') }, path.join(tmp, 'kits'));
    for (const f of ['spec.yaml', 'files/home/.huddle-ca/huddle-ca.crt', 'files/home/.huddle-ca/install.sh']) {
      expect(fs.readFileSync(path.join(dir, f), 'utf8')).not.toContain('\r');
    }
  });

  it('refuses anything but one PEM certificate', () => {
    const root = path.join(tmp, 'kits');
    expect(() => sbxKit({}, root)).toThrow(/PEM/);
    expect(() => sbxKit({ caPem: `${PEM}"\nsetup: x` }, root)).toThrow(/PEM/);
    expect(() => sbxKit({ caPem: '-----BEGIN PRIVATE KEY-----\nAA==\n-----END PRIVATE KEY-----\n' }, root)).toThrow(/PEM/);
  });
});
