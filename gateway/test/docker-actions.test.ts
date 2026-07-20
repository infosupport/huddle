import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── Fijnmazige Docker-rechten ────────────────────────────────────────────────
// Twee soorten acties: 'temporary' (mutaties; vereisen actieve grant-timer ÉN
// aan-geschakelde toggle) en 'always' (read-only; alleen de toggle telt).
// classifyRequest moet elk pad dat de proxy-dispatch kent op precies één actie
// afbeelden; onbekende paden → null → deny.

// db.ts gemockt (native better-sqlite3-binding ontbreekt in verse DMZ-dev-
// containers, zie rules.test.ts) — met muteerbare state per test.
const state = {
  grant: null as { until: number } | null,
  policies: new Map<string, boolean>(),
};

vi.mock('../src/db', () => ({
  getGrant: () => state.grant,
  getActionPolicy: (_c: string, action: string) => state.policies.get(action) ?? null,
  isHostPortApproved: () => false,
}));

const { classifyRequest, authorizeAction, DOCKER_ACTIONS, getEffectivePolicies } =
  await import('../src/docker-actions');

const CN = 'devcontainer-abc';
const future = () => Math.floor(Date.now() / 1000) + 600;
const past = () => Math.floor(Date.now() / 1000) - 600;

beforeEach(() => {
  state.grant = null;
  state.policies.clear();
});

describe('classifyRequest', () => {
  it.each([
    ['GET', '/_ping', 'system.ping'],
    ['HEAD', '/_ping', 'system.ping'],
    ['GET', '/version', 'system.version'],
    ['GET', '/info', 'system.version'],
    ['GET', '/events', 'system.events'],
    ['GET', '/containers/json', 'container.list'],
    ['GET', '/containers/abc/json', 'container.inspect'],
    ['GET', '/containers/abc/top', 'container.inspect'],
    ['GET', '/containers/abc/archive', 'container.inspect'],
    ['GET', '/containers/abc/logs', 'container.logs'],
    ['GET', '/containers/abc/stats', 'container.stats'],
    ['GET', '/images/json', 'image.list'],
    ['GET', '/images/abc/json', 'image.inspect'],
    ['GET', '/images/ghcr.io/team/app:1.2/json', 'image.inspect'],
    ['GET', '/exec/abc/json', 'container.exec'],
    ['GET', '/networks', 'network.list'],
    ['GET', '/networks/abc', 'network.inspect'],
    ['GET', '/volumes', 'volume.list'],
    ['GET', '/volumes/abc', 'volume.inspect'],
    ['POST', '/containers/create', 'container.create'],
    ['POST', '/containers/abc/start', 'container.start'],
    ['POST', '/containers/abc/stop', 'container.stop'],
    ['POST', '/containers/abc/kill', 'container.stop'],
    ['POST', '/containers/abc/restart', 'container.restart'],
    ['POST', '/containers/abc/update', 'container.update'],
    ['POST', '/containers/abc/wait', 'container.inspect'],
    ['POST', '/containers/abc/exec', 'container.exec'],
    ['POST', '/exec/abc/start', 'container.exec'],
    ['POST', '/exec/abc/resize', 'container.exec'],
    ['POST', '/build', 'image.build'],
    ['POST', '/images/create', 'image.pull'],
    ['POST', '/images/registry.example.com/team/app/push', 'image.push'],
    ['POST', '/images/myimage/tag', 'image.tag'],
    ['POST', '/volumes/create', 'volume.create'],
    ['POST', '/volumes/prune', 'volume.prune'],
    ['POST', '/networks/create', 'network.create'],
    ['POST', '/networks/abc/connect', 'network.connect'],
    ['POST', '/networks/abc/disconnect', 'network.disconnect'],
    ['PUT', '/containers/abc/archive', 'container.exec'],
    ['DELETE', '/containers/abc', 'container.remove'],
    ['DELETE', '/images/registry.example.com/team/app:latest', 'image.remove'],
    ['DELETE', '/volumes/abc', 'volume.remove'],
    ['DELETE', '/networks/abc', 'network.remove'],
  ])('%s %s → %s', (method, p, expected) => {
    expect(classifyRequest(method, p)).toBe(expected);
  });

  it.each([
    ['GET', '/secrets'],
    ['GET', '/swarm'],
    ['POST', '/containers/abc/rename'],
    ['POST', '/commit'],
    ['POST', '/session'],
    ['DELETE', '/'],
    ['PATCH', '/containers/json'],
    ['PUT', '/volumes/abc'],
  ])('onbekend pad %s %s → null', (method, p) => {
    expect(classifyRequest(method, p)).toBeNull();
  });
});

describe('authorizeAction — temporary acties', () => {
  it('weigert standaard (secure by default), zelfs met actieve grant', () => {
    state.grant = { until: future() };
    expect(authorizeAction(CN, 'container.create')).toMatch(/disabled/);
    expect(authorizeAction(CN, 'image.push')).toMatch(/disabled/);
  });

  it('weigert met aan-toggle maar zonder actieve grant-timer', () => {
    state.policies.set('container.create', true);
    expect(authorizeAction(CN, 'container.create')).toMatch(/access timer/);
  });

  it('weigert met aan-toggle maar verlopen grant', () => {
    state.grant = { until: past() };
    state.policies.set('container.start', true);
    expect(authorizeAction(CN, 'container.start')).toMatch(/access timer/);
  });

  it('staat toe met actieve grant én aan-toggle', () => {
    state.grant = { until: future() };
    state.policies.set('container.create', true);
    expect(authorizeAction(CN, 'container.create')).toBeNull();
  });

  it('expliciet uitgezette toggle blijft geweigerd met actieve grant', () => {
    state.grant = { until: future() };
    state.policies.set('container.exec', false);
    expect(authorizeAction(CN, 'container.exec')).toMatch(/disabled/);
  });
});

describe('authorizeAction — always acties', () => {
  it('weigert standaard, ook read-only (secure by default)', () => {
    expect(authorizeAction(CN, 'container.list')).toMatch(/disabled/);
    expect(authorizeAction(CN, 'system.ping')).toMatch(/disabled/);
  });

  it('staat read-only acties toe zonder grant zodra de toggle aan staat', () => {
    state.policies.set('container.list', true);
    state.policies.set('system.ping', true);
    state.policies.set('volume.inspect', true);
    expect(authorizeAction(CN, 'container.list')).toBeNull();
    expect(authorizeAction(CN, 'system.ping')).toBeNull();
    expect(authorizeAction(CN, 'volume.inspect')).toBeNull();
  });

  it('respecteert een weer uit-geschakelde toggle', () => {
    state.policies.set('container.logs', false);
    expect(authorizeAction(CN, 'container.logs')).toMatch(/disabled/);
  });

  it('onbekende actie → path not allowed', () => {
    expect(authorizeAction(CN, 'container.nonsense')).toBe('path not allowed');
  });
});

describe('catalogus & effectieve policies', () => {
  it('elke actie uit de catalogus is uniek en heeft een geldige kind/group', () => {
    const ids = DOCKER_ACTIONS.map(a => a.action);
    expect(new Set(ids).size).toBe(ids.length);
    for (const a of DOCKER_ACTIONS) {
      expect(['temporary', 'always', 'mount']).toContain(a.kind);
      expect(['containers', 'images', 'volumes', 'networks', 'system', 'mounts']).toContain(a.group);
    }
  });

  it('alle acties staan standaard uit (secure by default)', () => {
    // Elke actie — inclusief de mount-gates — start uit; de operator zet per
    // devcontainer expliciet aan wat mag.
    for (const def of DOCKER_ACTIONS) {
      expect(def.defaultEnabled, `actie ${def.action} onverwachte default`).toBe(false);
    }
  });

  it('getEffectivePolicies levert alle acties met defaults en overrides', () => {
    state.policies.set('image.push', true);
    state.policies.set('container.list', true);
    const eff = getEffectivePolicies(CN);
    expect(Object.keys(eff).length).toBe(DOCKER_ACTIONS.length);
    expect(eff['image.push']).toBe(true);        // override wint van default-uit
    expect(eff['container.list']).toBe(true);    // override wint van default-uit
    expect(eff['container.create']).toBe(false); // default
  });

  it('elke request-actie is bereikbaar via ten minste één API-pad', () => {
    // Regressiewacht: een request-geclassificeerde actie die classifyRequest
    // nooit oplevert is dode configuratie in het portal. 'mount'-acties zijn
    // config-gates (gecheckt in validateHostConfig, niet via classifyRequest)
    // en horen hier dus niet bij.
    const reachable = new Set<string>();
    const samples: Array<[string, string]> = [
      ['GET', '/_ping'], ['GET', '/version'], ['GET', '/events'],
      ['GET', '/containers/json'], ['GET', '/containers/x/json'], ['GET', '/containers/x/logs'],
      ['GET', '/containers/x/stats'], ['GET', '/images/json'], ['GET', '/images/x/json'],
      ['GET', '/networks'], ['GET', '/networks/x'], ['GET', '/volumes'], ['GET', '/volumes/x'],
      ['POST', '/containers/create'], ['POST', '/containers/x/start'], ['POST', '/containers/x/stop'],
      ['POST', '/containers/x/restart'], ['POST', '/containers/x/update'], ['POST', '/containers/x/exec'],
      ['POST', '/build'], ['POST', '/images/create'], ['POST', '/images/x/push'], ['POST', '/images/x/tag'],
      ['POST', '/volumes/create'], ['POST', '/volumes/prune'],
      ['POST', '/networks/create'], ['POST', '/networks/x/connect'], ['POST', '/networks/x/disconnect'],
      ['DELETE', '/containers/x'], ['DELETE', '/images/x'], ['DELETE', '/volumes/x'], ['DELETE', '/networks/x'],
    ];
    for (const [m, p] of samples) {
      const a = classifyRequest(m, p);
      if (a) reachable.add(a);
    }
    for (const def of DOCKER_ACTIONS) {
      if (def.kind === 'mount') continue;
      expect(reachable, `actie ${def.action} onbereikbaar`).toContain(def.action);
    }
  });
});
