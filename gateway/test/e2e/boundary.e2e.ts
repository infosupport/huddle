import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  E2E_ENABLED, E2E_NAME, E2E_IMAGE,
  dockerAvailable, assertHuddleReachable,
  spawnDevcontainer, removeDevcontainer,
  execIn, curlStatusIn,
  clearRulesForDomain, allowDomain, setGrant, revokeGrant, setActionPolicy, sleep,
} from './helpers';

// ── LIVE security-boundary suite (T1–T11 stijl) ─────────────────────────────
// Spint een echte devcontainer op via de draaiende huddle-stack en exec't erin.
// Opt-in: HUDDLE_E2E=1, en alleen op een host met Docker + draaiende huddle.
// Zie test/e2e/README.md.
//
// Parallelisatie-strategie:
//   - De drie describe-blokken raken onafhankelijke state en draaien concurrent
//     (sequence.concurrent: true in vitest.e2e.config.ts):
//       • per-domein firewall  → firewall-regels voor TEST_DOMAIN
//       • docker-socket gate   → grant-state voor E2E_NAME
//       • huddle self-traffic  → read-only, geen gedeelde state
//   - Binnen docker-socket gate: de grant/toggle-tests sequentieel (ze muteren
//     grant- en policy-state), daarna de escape-tests concurrent.

const TEST_DOMAIN = 'example.com';

describe.skipIf(!E2E_ENABLED)('live security boundary', () => {
  beforeAll(async () => {
    if (!dockerAvailable()) throw new Error('docker CLI niet beschikbaar op deze host');
    await assertHuddleReachable();
    await removeDevcontainer();
    await spawnDevcontainer();
  });

  afterAll(async () => {
    await revokeGrant(E2E_NAME);
    await clearRulesForDomain(TEST_DOMAIN);
    await removeDevcontainer();
  });

  // ── Firewall: blokkeren → toestaan ────────────────────────────────────────
  // Raakt alleen firewall-regels voor TEST_DOMAIN — geen overlap met grant-state.
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

  // ── Docker-socket gate ────────────────────────────────────────────────────
  // Raakt alleen grant-state — geen overlap met firewall-regels.
  describe('docker-socket gate', () => {
    // Secure by default: álle acties (ook read-only) staan uit tot de
    // operator ze aanzet. Read-only ('always') werkt daarna zonder timer;
    // mutaties ('temporary') vereisen bovendien een actieve grant.
    it('standaard staat alles uit — ook read-only wordt geweigerd', async () => {
      await revokeGrant(E2E_NAME);
      await sleep(500);
      const r = execIn(E2E_NAME, 'docker ps');
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/disabled/i);
    });

    it('read-only werkt zonder grant zodra de toggle aan staat', async () => {
      await setActionPolicy(E2E_NAME, 'system.ping', true);
      await setActionPolicy(E2E_NAME, 'container.list', true);
      const r = execIn(E2E_NAME, 'docker ps');
      expect(r.status).toBe(0);
    });

    it('weigert mutaties met aan-toggle maar zonder actieve grant', async () => {
      await setActionPolicy(E2E_NAME, 'volume.create', true);
      const r = execIn(E2E_NAME, 'docker volume create e2e-no-grant-probe');
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toMatch(/access timer/i);
    });

    it('staat mutaties toe binnen een actieve grant (incl. eigen-volume delete)', async () => {
      await setActionPolicy(E2E_NAME, 'volume.remove', true);
      await setGrant(E2E_NAME, 5);
      await sleep(500);
      // create + rm bewijst ook de huddle.parent-labelinjectie: rm van een
      // eigen volume mag, van andermans volume niet.
      const r = execIn(E2E_NAME, 'docker volume create e2e-grant-probe && docker volume rm e2e-grant-probe');
      expect(r.status).toBe(0);
    });

    // Alle onderstaande tests vereisen een actieve grant en zijn onderling
    // onafhankelijk — ze draaien concurrent via describe.concurrent.
    describe.concurrent('escape-pogingen met actieve grant', () => {
      beforeAll(async () => {
        // Toggles aan die de escape-pogingen nodig hebben om überhaupt bij de
        // harde security-checks (HostConfig/ownership) aan te komen.
        for (const action of ['system.ping', 'container.create', 'container.start', 'container.inspect', 'volume.create']) {
          await setActionPolicy(E2E_NAME, action, true);
        }
        await setGrant(E2E_NAME, 15);
        await sleep(500);
      });

      it('weigert een HostConfig-escape (host-path bind)', async () => {
        const r = execIn(E2E_NAME, `docker run --rm -v /:/host ${E2E_IMAGE} true`);
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/not permitted/i);
      });

      it('weigert een named local bind-backed volume (host-path escape)', async () => {
        const create = execIn(E2E_NAME, `docker volume create --driver local --opt type=none --opt device=/ --opt o=bind hostroot`);
        expect(`${create.stdout}${create.stderr}`).toMatch(/not permitted/i);
        const run = execIn(E2E_NAME, `docker run --rm -v hostroot:/host ${E2E_IMAGE} cat /host/etc/hostname`);
        expect(run.status).not.toBe(0);
      });

      it('weigert een volume-mount met inline DriverConfig (host-path escape)', async () => {
        const r = execIn(
          E2E_NAME,
          `docker run --rm --mount 'type=volume,dst=/host,volume-driver=local,volume-opt=type=none,volume-opt=device=/,volume-opt=o=bind' ${E2E_IMAGE} cat /host/etc/hostname`,
        );
        expect(r.status).not.toBe(0);
        expect(`${r.stdout}${r.stderr}`).toMatch(/not permitted/i);
      });

      it('weigert --privileged', async () => {
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
  });

  // ── Huddle self-traffic via de proxy ──────────────────────────────────────
  // Read-only, geen gedeelde state — beide tests draaien concurrent.
  describe.concurrent('huddle self-traffic', () => {
    // Devcontainer → management-API kent twee paden, elk met een eigen slot:
    //   1. via de egress-proxy (default: curlrc/http_proxy wijst naar huddle:80)
    //      → de self-traffic-gate van de proxy weigert alles behalve de
    //        audit-ingest met 403, de request bereikt de API nooit;
    //   2. direct naar :3000 (iptables staat al het TCP-verkeer naar het
    //      huddle-IP toe) → daar is het operator-token de barrière: 401.
    it('proxy blokkeert self-traffic naar de management-API (→ 403)', () => {
      const code = curlStatusIn(E2E_NAME, 'http://huddle:3000/api/rules');
      expect(code).toBe('403');
    });

    it('directe management-API-call zonder operator-token krijgt 401', () => {
      const code = curlStatusIn(E2E_NAME, 'http://huddle:3000/api/rules', `--noproxy '*'`);
      expect(code).toBe('401');
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
