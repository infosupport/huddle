import { describe, it, expect } from 'vitest';
import crypto from 'crypto';
import forge from 'node-forge';
import { buildJksTruststore, buildJavaTruststoreScript, JAVA_TOOL_OPTIONS, MAVEN_SETTINGS_XML, pemToDer } from '../src/java-truststore';

// Java-tools (Maven, Gradle, IntelliJ met een gedownloade JDK) lezen de systeem-CA
// niet. De gateway maakt daarom zelf een JKS-truststore met de Huddle-CA (#44):
// in de container zit geen keytool.
function selfSignedPem(): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date(Date.now() + 86400000);
  const attrs = [{ name: 'commonName', value: 'Huddle Test CA' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey);
  return forge.pki.certificateToPem(cert);
}

describe('buildJksTruststore', () => {
  const pem = selfSignedPem();
  const jks = buildJksTruststore(pem, 'changeit', 0);

  it('heeft de JKS-header en één trusted-cert entry met het DER-certificaat', () => {
    expect(jks.readUInt32BE(0)).toBe(0xfeedfeed);
    expect(jks.readUInt32BE(4)).toBe(2);
    expect(jks.readUInt32BE(8)).toBe(1);
    expect(jks.readUInt32BE(12)).toBe(2); // tag: trusted certificate
    expect(jks.includes(pemToDer(pem)[0])).toBe(true);
  });

  it('sluit af met de keystore-digest over wachtwoord + "Mighty Aphrodite" + inhoud', () => {
    const body = jks.subarray(0, jks.length - 20);
    const expected = crypto.createHash('sha1')
      .update(Buffer.from('\0c\0h\0a\0n\0g\0e\0i\0t', 'latin1'))
      .update('Mighty Aphrodite')
      .update(body)
      .digest();
    expect(jks.subarray(jks.length - 20).equals(expected)).toBe(true);
  });

  it('weigert een PEM zonder certificaat', () => {
    expect(() => buildJksTruststore('geen cert')).toThrow();
  });

  it('script schrijft de truststore zonder keytool; JAVA_TOOL_OPTIONS wijst ernaar met type en wachtwoord', () => {
    const script = buildJavaTruststoreScript(pem);
    expect(script).not.toMatch(/^\s*keytool\b/m);
    expect(script).toMatch(/base64 -d > \/usr\/local\/share\/ca-certificates\/huddle-ca\.jks/);
    expect(JAVA_TOOL_OPTIONS).toMatch(/trustStoreType=JKS/);
    expect(JAVA_TOOL_OPTIONS).toMatch(/trustStorePassword=changeit/);
  });

  it('zet Maven-proxy in ~/.m2/settings.xml, maar overschrijft een bestaande niet', () => {
    const script = buildJavaTruststoreScript(pem);
    expect(script).toMatch(/if \[ ! -e \/home\/vscode\/\.m2\/settings\.xml \]/);
    expect(MAVEN_SETTINGS_XML).toMatch(/<host>huddle<\/host><port>80<\/port>/);
    expect(MAVEN_SETTINGS_XML).toMatch(/<protocol>https<\/protocol>/);
  });
});
