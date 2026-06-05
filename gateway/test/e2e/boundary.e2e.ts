import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  E2E_ENABLED, E2E_NAME, E2E_IMAGE,
  dockerAvailable, huddleReachable,
  spawnDevcontainer, removeDevcontainer,
  execIn, curlStatusIn,
  clearRulesForDomain, allowDomain, setGrant, revokeGrant, sleep,
} from './helpers';

// ── LIVE security-boundary suite (T1–T11 stijl) ─────────────────────────────
// Spint een echte devcontainer op via de draaiende huddle-stack en exec't erin.
// Opt-in: HUDDLE_E2E=1, en alleen op een host met Docker + draaiende huddle.
// Zie test/e2e/README.md.

const TEST_DOMAIN = 'example.com';

describe.skipIf(!E2E_ENABLED)('live security boundary', () => {
  beforeAll(async () => {
    if (!dockerAvailable()) throw new Error('docker CLI niet beschikbaar op deze host');
    if (!(await huddleReachable())) throw new Error('huddle-API niet bereikbaar op de HUDDLE_URL — draait de stack?');
    await removeDevcontainer();        // schone start
    await spawnDevcontainer();
  });

  afterAll(async () => {
    await revokeGrant(E2E_NAME);
    await clearRulesForDomain(TEST_DOMAIN);
    await removeDevcontainer();
  });

  // ── Firewall: blokkeren → toestaan → opnieuw ───────────────────────────────
  describe('per-domein firewall', () => {
    it('blokkeert een niet-toegestaan domein (curl → 403)', async () => {
      await clearRulesForDomain(TEST_DOMAIN);
      await sleep(1000);
      const code = curlStatusIn(E2E_NAME, `http://${TEST_DOMAIN}/`);
      expect(code).toBe('403');
    });

    it('staat hetzelfde domein toe na approval (curl → 200)', async () => {
      await allowDomain(TEST_DOMAIN, E2E_NAME);
      let code = '';
      for (let i = 0; i < 3; i++) {
        code = curlStatusIn(E2E_NAME, `http://${TEST_DOMAIN}/`);
        if (code === '200') break;
        await sleep(1500);
      }
      expect(code).toBe('200');
    });
  });

  // ── Docker-socket: geweigerd zonder grant → toegestaan met grant ───────────
  describe('docker-socket gate', () => {
    it('weigert docker zonder actieve grant', async () => {
      await revokeGrant(E2E_NAME);
      await sleep(500);
      const r = execIn(E2E_NAME, 'docker ps');
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/denied by policy/i);
    });

    it('staat docker toe binnen een actieve grant', async () => {
      await setGrant(E2E_NAME, 5);
      await sleep(500);
      const r = execIn(E2E_NAME, 'docker ps');
      expect(r.status).toBe(0); // exit 0; lijst is gefilterd op eigen children
    });

    it('weigert een HostConfig-escape (host-path bind) óók met grant', async () => {
      // grant staat nog actief van de vorige test
      const r = execIn(E2E_NAME, `docker run --rm -v /:/host ${E2E_IMAGE} true`);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/not permitted/i);
    });

    it('weigert --privileged óók met grant', async () => {
      const r = execIn(E2E_NAME, `docker run --rm --privileged ${E2E_IMAGE} true`);
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/privileged.*not permitted/i);
    });

    it('weigert inspect van een vreemde container (huddle)', async () => {
      const r = execIn(E2E_NAME, 'docker inspect huddle');
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/not owned|not permitted/i);
    });
  });

  // ── Huddle self-traffic via de proxy ───────────────────────────────────────
  describe('huddle self-traffic', () => {
    it('management-API is onbereikbaar vanuit de devcontainer (→ 403)', () => {
      const code = curlStatusIn(E2E_NAME, 'http://huddle:3000/api/rules');
      expect(code).toBe('403');
    });

    it('sudo-audit ingest is wél bereikbaar (→ 200)', () => {
      const r = execIn(
        E2E_NAME,
        `curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' ` +
        `-d '{"container":"${E2E_NAME}","entry":"e2e-test"}' http://huddle:3000/api/audit/sudo`,
      );
      expect(r.stdout.trim()).toBe('200');
    });
  });
});
