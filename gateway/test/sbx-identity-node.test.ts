import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';

// De Node-helft van docs/ADR-sbx-identity.md: Huddle Node slaat het geheim en
// geeft het uit. Niet: hoe de gateway het herkent (dat is de feed + proxy).
//
// sbx is een HOST-binary en die staat hier niet, dus ops is gemockt. Wat we
// testen is de VOLGORDE waarin Huddle sbx aanstuurt en wat het onderweg laat
// zien — precies de twee dingen die stukgaan zonder dat een echte sbx meepraat.

interface OpsCall {
  fn: 'setProxy' | 'create' | 'exec' | 'remove';
  url?: string;
  name?: string;
}

const calls: OpsCall[] = [];
let createCode = 0;
let createDelayMs = 0;
let createThrows: string | null = null;
let removeCode = 0;
let setProxyFailsOnce = false;

vi.mock('../src/sandbox/ops', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/sandbox/ops')>();
  return {
    ...actual,
    setProxy: async (p: { which: string; url: string }) => {
      calls.push({ fn: 'setProxy', url: p.url });
      if (setProxyFailsOnce) {
        setProxyFailsOnce = false;
        throw new Error('sbx settings set failed');
      }
    },
    create: async (p: { name: string }) => {
      calls.push({ fn: 'create', name: p.name });
      if (createDelayMs) await new Promise((r) => setTimeout(r, createDelayMs));
      if (createThrows) throw new Error(createThrows);
      return createCode;
    },
    exec: async (p: { name: string }) => {
      calls.push({ fn: 'exec', name: p.name });
      return 0;
    },
    remove: async (p: { name: string }) => {
      calls.push({ fn: 'remove', name: p.name });
      return removeCode;
    },
  };
});

// De CA komt uit een echt bestand; de installatiestap zelf is hier niet de test.
vi.mock('../src/tls-ca', () => ({ getCaCertPem: () => '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----\n' }));
// Folder mappings lezen de host-config van de gebruiker; een sandbox zonder
// settings-folders houdt de steplijst kort.
vi.mock('../src/host-config', () => ({ listFolderMappings: () => [] }));

let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[sbx-identity-node.test] SKIPPED — better-sqlite3 not usable: ${(e as Error).message}`);
}

let dbMod: typeof import('../src/db');
let sbx: typeof import('../src/sbx');
let identity: typeof import('../src/sbx-identity');
let registry: typeof import('../src/sandbox/registry');

beforeAll(async () => {
  if (!sqliteAvailable) return;
  dbMod = await import('../src/db');
  dbMod.initDb();
  sbx = await import('../src/sbx');
  identity = await import('../src/sbx-identity');
  registry = await import('../src/sandbox/registry');
});

beforeEach(() => {
  if (!sqliteAvailable) return;
  calls.length = 0;
  createCode = 0;
  createDelayMs = 0;
  createThrows = null;
  removeCode = 0;
  setProxyFailsOnce = false;
  dbMod.db.exec('DELETE FROM sandbox_identity');
});

/** Alle rijen uit sandbox_identity, als naam → { secret, hash }. */
function rows(): Record<string, { secret: string; secret_hash: string }> {
  const all = dbMod.db.prepare('SELECT name, secret, secret_hash FROM sandbox_identity').all() as {
    name: string;
    secret: string;
    secret_hash: string;
  }[];
  return Object.fromEntries(all.map((r) => [r.name, { secret: r.secret, secret_hash: r.secret_hash }]));
}

/** De URL's die daadwerkelijk aan sbx zijn gegeven, op volgorde. */
function proxyUrls(): string[] {
  return calls.filter((c) => c.fn === 'setProxy').map((c) => c.url!);
}

const d = sqliteAvailable ? describe : describe.skip;

d('startSandbox mints and spends a per-sandbox secret', () => {
  it('gives every sandbox its own 256-bit secret, and stores its SHA-256', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    await sbx.startSandbox({ name: 'box-b', workspace: '/w/b' });

    const r = rows();
    expect(Object.keys(r).sort()).toEqual(['box-a', 'box-b']);
    expect(r['box-a'].secret).not.toBe(r['box-b'].secret);
    // 32 bytes base64url — geen padding, geen vaste lengte om te raden.
    expect(Buffer.from(r['box-a'].secret, 'base64url')).toHaveLength(32);
    for (const name of ['box-a', 'box-b']) {
      expect(r[name].secret_hash).toBe(identity.hashSandboxSecret(r[name].secret));
    }
  });

  it('re-creating a name mints a FRESH secret, never the old one', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    const first = rows()['box-a'].secret;
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    expect(rows()['box-a'].secret).not.toBe(first);
  });

  it('hands sbx the credentialed URL — redaction is at display, not at use', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    const secret = rows()['box-a'].secret;
    const u = new URL(proxyUrls()[0]);
    expect(decodeURIComponent(u.username)).toBe('box-a');
    expect(decodeURIComponent(u.password)).toBe(secret);
  });
});

d('nothing that is displayed carries the secret', () => {
  it('keeps it out of every step command and out of upstreamUrl', async () => {
    const res = await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    const secret = rows()['box-a'].secret;

    const shown = JSON.stringify(res);
    expect(shown).not.toContain(secret);
    // Ook het losse wachtwoord uit de PARKEER-url mag niet meeliften.
    for (const url of proxyUrls()) {
      const pw = decodeURIComponent(new URL(url).password);
      expect(shown).not.toContain(pw);
    }
    expect(res.upstreamUrl).toContain('***');
    const setStep = res.steps.find((s) => s.label.startsWith('set sandbox upstream proxy'))!;
    expect(setStep.command).toMatch(/^sbx settings set proxy\.sandbox http:\/\/\*\*\*:\*\*\*@/);
  });

  it('redacts a credential sbx echoes back in its own error text', async () => {
    const ops = await import('../src/sandbox/ops');
    const echoed = ops.redactCredentials(
      "failed to set proxy.sandbox: invalid url \"http://box-a:s3cr3t@localhost:32768/\""
    );
    expect(echoed).not.toContain('s3cr3t');
    expect(echoed).toContain('//***:***@localhost:32768/');
  });
});

d('the global setting is parked after a create', () => {
  it('leaves it on a credential that maps to no sandbox', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });

    const last = new URL(proxyUrls().at(-1)!);
    expect(decodeURIComponent(last.username)).toBe(identity.UNCLAIMED_SANDBOX);
    // Het parkeergeheim staat nergens opgeslagen: wie ermee aankomt is niemand.
    const stored = Object.values(rows()).map((r) => r.secret);
    expect(stored).not.toContain(decodeURIComponent(last.password));
  });

  it('parks it even when the create fails, and keeps no secret for a box that does not exist', async () => {
    createCode = 1;
    const res = await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });

    expect(res.ok).toBe(false);
    expect(rows()).toEqual({});
    expect(decodeURIComponent(new URL(proxyUrls().at(-1)!).username)).toBe(identity.UNCLAIMED_SANDBOX);
  });

  it('drops the secret when create throws', async () => {
    createThrows = 'Docker login required on the host';
    const res = await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    expect(res.ok).toBe(false);
    expect(rows()).toEqual({});
  });

  it('does not park — and mints nothing — when the FIRST settings set fails', async () => {
    setProxyFailsOnce = true;
    const res = await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });

    expect(res.ok).toBe(false);
    expect(rows()).toEqual({});
    expect(calls.some((c) => c.fn === 'create')).toBe(false);
  });
});

d('concurrent creates are serialised', () => {
  it('never interleaves one box’s settings set with another’s create', async () => {
    // Zonder slot zet B de globale sleutel terwijl A nog aan het aanmaken is:
    // beide boxen krijgen dan dezelfde identiteit, of ze wisselen om.
    createDelayMs = 25;
    await Promise.all([
      sbx.startSandbox({ name: 'box-a', workspace: '/w/a' }),
      sbx.startSandbox({ name: 'box-b', workspace: '/w/b' }),
    ]);

    const seq = calls.filter((c) => c.fn === 'setProxy' || c.fn === 'create');
    const firstBox = seq[1].name!;
    const secondBox = firstBox === 'box-a' ? 'box-b' : 'box-a';
    expect(seq.map((c) => (c.fn === 'create' ? `create:${c.name}` : 'set'))).toEqual([
      'set',
      `create:${firstBox}`,
      'set',
      'set',
      `create:${secondBox}`,
      'set',
    ]);

    // En de URL vlak vóór elke create draagt de naam van precies die box.
    for (let i = 0; i < seq.length; i++) {
      if (seq[i].fn !== 'create') continue;
      expect(decodeURIComponent(new URL(seq[i - 1].url!).username)).toBe(seq[i].name);
    }
    const r = rows();
    expect(r['box-a'].secret).not.toBe(r['box-b'].secret);
  });

  it('a failed start does not wedge the next one', async () => {
    createCode = 1;
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    createCode = 0;
    const res = await sbx.startSandbox({ name: 'box-b', workspace: '/w/b' });
    expect(res.ok).toBe(true);
    expect(Object.keys(rows())).toEqual(['box-b']);
  });
});

d('hasSandboxIdentity', () => {
  it('answers existence without reading the secret — the reconciler asks this one', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    expect(registry.hasSandboxIdentity('box-a')).toBe(true);
    // Een box die Huddle niet heeft aangemaakt heeft geen rij, en blijft van
    // zichzelf: de reconciler mag daar niets aan verbreden.
    expect(registry.hasSandboxIdentity('some-other-box')).toBe(false);
  });

  it('goes false again once the sandbox is removed', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    await sbx.removeSandbox('box-a');
    expect(registry.hasSandboxIdentity('box-a')).toBe(false);
  });
});

d('removeSandbox', () => {
  it('drops the identity — a sandbox does not outlive its credential', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    expect(Object.keys(rows())).toEqual(['box-a']);
    await sbx.removeSandbox('box-a');
    expect(rows()).toEqual({});
  });

  it('keeps the identity when sbx rm fails — the box is still there', async () => {
    await sbx.startSandbox({ name: 'box-a', workspace: '/w/a' });
    removeCode = 1;
    await sbx.removeSandbox('box-a');
    expect(Object.keys(rows())).toEqual(['box-a']);
  });
});
