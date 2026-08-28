import { describe, it, expect, beforeAll, vi } from 'vitest';

// ── Docker-socket-proxy: request-filter ──────────────────────────────────────
// De socket-layout is verhuisd naar de gateway (socket-relay.test.ts): de socket
// moet op de ENGINE-host staan en Huddle Node draait daar niet altijd. Wat hier
// overblijft is het filter zelf — welke Docker-calls een devcontainer mag doen.

// socket-proxy importeert db.ts alleen voor de grant-checks; mocken houdt de
// native better-sqlite3-binding buiten deze test (die ontbreekt in een verse
// DMZ-devcontainer, zie rules.test.ts / grants.test.ts).
vi.mock('../src/db', () => ({
  getGrant: () => null,
  getActionPolicy: () => null,
  isHostPortApproved: () => false,
}));

function connect(sockPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const c = net.createConnection(sockPath, () => { c.end(); resolve(); });
    c.on('error', reject);
  });
}

// ── withLabelFilter: filter-formaat ──────────────────────────────────────────
// De Docker-client stuurt `filters` in het legacy map-formaat
// (`{"label":{"foo=bar":true},"status":{"running":true}}`). Als we alleen `label`
// naar een array omzetten en de andere sleutels als map laten staan, ontstaat een
// gemengde vorm die de daemon met "invalid filter" afwijst en o.a.
// `docker compose up` breekt. Deze tests borgen dat élke sleutel naar het
// (universeel geaccepteerde) array-formaat genormaliseerd wordt.
describe('withLabelFilter', () => {
  let withLabelFilter: typeof import('../src/socket-proxy').withLabelFilter;

  beforeAll(async () => {
    withLabelFilter = (await import('../src/socket-proxy')).withLabelFilter;
  });

  function filtersOf(url: string): Record<string, unknown> {
    const qs = new URLSearchParams(url.split('?')[1]);
    return JSON.parse(qs.get('filters') ?? '{}');
  }

  it('normaliseert legacy map-filters (compose) naar array-formaat', () => {
    const raw = '/v1.55/containers/json?all=1&filters=' +
      encodeURIComponent('{"label":{"com.docker.compose.project=x":true},"status":{"running":true}}');
    const out = filtersOf(withLabelFilter(raw, 'huddle.parent=dc-a'));
    expect(out).toEqual({
      label: ['com.docker.compose.project=x', 'huddle.parent=dc-a'],
      status: ['running'],
    });
    // Geen enkele sleutel mag als map achterblijven (dat = "invalid filter").
    for (const v of Object.values(out)) expect(Array.isArray(v)).toBe(true);
  });

  it('behoudt bestaande array-filters en voegt het label toe', () => {
    const raw = '/v1.55/containers/json?filters=' +
      encodeURIComponent('{"label":["a=b"]}');
    expect(filtersOf(withLabelFilter(raw, 'huddle.parent=dc-a'))).toEqual({
      label: ['a=b', 'huddle.parent=dc-a'],
    });
  });

  it('werkt zonder bestaande filters', () => {
    expect(filtersOf(withLabelFilter('/v1.55/containers/json', 'huddle.parent=dc-a')))
      .toEqual({ label: ['huddle.parent=dc-a'] });
  });
});
