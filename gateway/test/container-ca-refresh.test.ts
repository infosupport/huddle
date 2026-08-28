import { describe, it, expect, vi } from 'vitest';

// ── Reinstalling the root CA in a running devcontainer ──────────────────────
//
// The CA used to live in the gateway's data volume, so a container that trusted
// it once trusted it forever. After the Node/Gateway split it lives on Huddle
// Node's host, and the first boot against a fresh data dir mints a new root —
// at which point every devcontainer created earlier fails HTTPS through the
// proxy with CERT_SIGNATURE_FAILURE. refreshContainerCa is what closes that gap,
// so what matters is that it can tell "already current" from "reinstalled" and
// that it never reports success it did not have.
//
// The exec boundary is injected (ContainerExec, as in sudo-grant), so this runs
// without a Docker daemon. tls-ca is stubbed because minting a real 2048-bit RSA
// root takes seconds and none of the assertions below depend on its contents.
vi.mock('../src/tls-ca', () => ({
  getCaCertPem: () => '-----BEGIN CERTIFICATE-----\nQ0EK\n-----END CERTIFICATE-----\n',
}));

const { refreshContainerCa } = await import('../src/docker');

describe('refreshContainerCa', () => {
  it('reports no change when the container already trusts this root', async () => {
    // Exit 3 is the script's own "the cert on disk is byte-identical" branch.
    const exec = vi.fn().mockResolvedValue({ exitCode: 3 });
    await expect(refreshContainerCa('id', 'dc-a', exec)).resolves.toBe(false);
  });

  it('reports a change when it installed a different root', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    await expect(refreshContainerCa('id', 'dc-a', exec)).resolves.toBe(true);
  });

  it('throws on a failed exec rather than claiming the container is covered', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 1, stdout: 'mv: read-only file system' });
    await expect(refreshContainerCa('id', 'dc-a', exec)).rejects.toThrow(/read-only file system/);
  });

  it('runs as one root shell script carrying the CA, keyed on the container id', async () => {
    const exec = vi.fn().mockResolvedValue({ exitCode: 0 });
    await refreshContainerCa('container-id-abc', 'dc-a', exec);
    const [id, cmd] = exec.mock.calls[0];
    expect(id).toBe('container-id-abc');
    expect(cmd[0]).toBe('sh');
    const script = cmd[2] as string;
    // The PEM travels base64-encoded: it is multi-line and would otherwise have
    // to survive shell quoting intact.
    const b64 = Buffer.from('-----BEGIN CERTIFICATE-----\nQ0EK\n-----END CERTIFICATE-----\n', 'utf8').toString('base64');
    expect(script).toContain(b64);
    // Compare before touching anything — the keystore import below it is slow.
    expect(script).toContain('cmp -s');
    // Both trust stores: the system one, and the JBR's own (the JetBrains
    // backend ignores the system store and NODE_EXTRA_CA_CERTS entirely).
    expect(script).toContain('update-ca-certificates');
    expect(script).toContain('/usr/local/share/ca-certificates/huddle-ca.crt');
    expect(script).toContain('keytool');
  });
});
