import fs from 'fs';
import path from 'path';
import forge from 'node-forge';

// Persistente root-CA voor het MITM-intercepten van HTTPS-verkeer naar
// devcontainers. Wordt eenmalig gegenereerd in /data (volume) en daarna
// hergebruikt zodat clients de CA maar één keer hoeven te trusten.

const CA_DIR = process.env.CA_DIR ?? '/data';
const CA_KEY_PATH = path.join(CA_DIR, 'ca.key');
const CA_CRT_PATH = path.join(CA_DIR, 'ca.crt');

interface LoadedCa {
  caKey: forge.pki.rsa.PrivateKey;
  caCert: forge.pki.Certificate;
  caCertPem: string;
}

let loaded: LoadedCa | null = null;

// In-memory cache van leaf-certificaten per hostname. Eén jaar geldigheid is
// ruim genoeg; bij gateway-restart wordt de cache opnieuw opgebouwd, dat geeft
// geen problemen want de root-CA blijft hetzelfde.
const leafCache = new Map<string, { certPem: string; keyPem: string }>();

function generateNewCa(): LoadedCa {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16);
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs: forge.pki.CertificateField[] = [
    { name: 'commonName', value: 'Huddle DMZ Proxy Root CA' },
    { name: 'organizationName', value: 'Huddle' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, pathLenConstraint: 1, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    caKey: keys.privateKey,
    caCert: cert,
    caCertPem: forge.pki.certificateToPem(cert),
  };
}

function persist(ca: LoadedCa): void {
  fs.mkdirSync(CA_DIR, { recursive: true });
  fs.writeFileSync(CA_KEY_PATH, forge.pki.privateKeyToPem(ca.caKey), { mode: 0o600 });
  fs.writeFileSync(CA_CRT_PATH, ca.caCertPem);
}

export function initCa(): void {
  if (loaded) return;
  if (fs.existsSync(CA_KEY_PATH) && fs.existsSync(CA_CRT_PATH)) {
    try {
      const keyPem = fs.readFileSync(CA_KEY_PATH, 'utf8');
      const certPem = fs.readFileSync(CA_CRT_PATH, 'utf8');
      loaded = {
        caKey: forge.pki.privateKeyFromPem(keyPem),
        caCert: forge.pki.certificateFromPem(certPem),
        caCertPem: certPem,
      };
      console.log('[tls-ca] loaded existing CA from disk');
      return;
    } catch (err: any) {
      console.warn('[tls-ca] failed to load existing CA, regenerating:', err.message);
    }
  }
  console.log('[tls-ca] generating new root CA (2048-bit RSA, valid 10 years)...');
  loaded = generateNewCa();
  persist(loaded);
  console.log('[tls-ca] CA written to', CA_CRT_PATH);
}

export function getCaCertPem(): string {
  if (!loaded) throw new Error('CA not initialized — call initCa() first');
  return loaded.caCertPem;
}

// Genereer (of haal uit cache) een leaf-cert voor één hostname. Het cert heeft
// SAN-DNS=<hostname> zodat TLS-clients het accepteren bij naam-validatie.
export function signLeafCert(hostname: string): { certPem: string; keyPem: string } {
  if (!loaded) throw new Error('CA not initialized — call initCa() first');
  const cached = leafCache.get(hostname);
  if (cached) return cached;

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = Date.now().toString(16) + Math.floor(Math.random() * 0xffff).toString(16);
  cert.validity.notBefore = new Date(Date.now() - 60_000); // 1 min clock-skew tolerantie
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 1);

  cert.setSubject([{ name: 'commonName', value: hostname }]);
  cert.setIssuer(loaded.caCert.subject.attributes);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
    { name: 'subjectAltName', altNames: [{ type: 2, value: hostname }] }, // type 2 = DNS
  ]);
  cert.sign(loaded.caKey, forge.md.sha256.create());

  const out = {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
  leafCache.set(hostname, out);
  return out;
}

// Voor tests / debugging — leegt de leaf-cache, root-CA blijft staan.
export function clearLeafCache(): void {
  leafCache.clear();
}
