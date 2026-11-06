import { describe, it, expect, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import forge from 'node-forge';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-ca-'));
process.env.CA_DIR = DIR;
const ca = await import('../src/tls-ca');

afterAll(() => fs.rmSync(DIR, { recursive: true, force: true }));

describe('leaf certificates', () => {
  it('dragen de key id van de CA, zodat strikte verifiers (Python 3.13) ze accepteren', () => {
    ca.initCa();
    const root = forge.pki.certificateFromPem(ca.getCaCertPem());
    const leaf = forge.pki.certificateFromPem(ca.signLeafCert('api.example.com').certPem);

    const caSki = (root.getExtension('subjectKeyIdentifier') as any).subjectKeyIdentifier as string;
    const aki = forge.util.bytesToHex((leaf.getExtension('authorityKeyIdentifier') as any).value);
    // SEQUENCE { [0] keyIdentifier }: de laatste bytes zijn de key id zelf.
    expect(caSki).toMatch(/^[0-9a-f]{40}$/);
    expect(aki.endsWith(caSki)).toBe(true);
    expect(leaf.getExtension('subjectKeyIdentifier')).toBeTruthy();
    expect(root.verify(leaf)).toBe(true);
  });
});
