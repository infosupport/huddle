import { describe, it, expect, vi } from 'vitest';

// socket-proxy importeert db.ts alleen voor de grant-checks; mocken houdt de
// native better-sqlite3-binding buiten deze test (die ontbreekt in een verse
// DMZ-devcontainer, zie rules.test.ts / grants.test.ts). ownershipFromInspect is
// puur en raakt de db niet.
vi.mock('../src/db', () => ({
  getGrant: () => null,
  isHostPortApproved: () => false,
}));

const { ownershipFromInspect } = await import('../src/socket-proxy');

// ── Container-ownership classificatie (issue #61) ────────────────────────────
// De inspect-policy classificeert een container als 'own', 'foreign' of
// 'missing'. Alleen 'own' wordt naar Docker doorgezet; 'foreign' én 'missing'
// krijgen beide een gesynthetiseerde 404 (zie de inspect-tak in socket-proxy.ts).
// Dat 'foreign' óók een 404 geeft is bewust: zo is een vreemde container niet van
// een niet-bestaande te onderscheiden (geen bestaans-oracle) en ziet Aspire's DCP
// een nog-niet-aangemaakte persistent container als afwezig → maakt 'm aan. Het
// onderscheid 'foreign' vs 'missing' blijft bestaan zodat een probe op een écht
// bestaande vreemde container als verdacht gelogd kan worden. Deze pure functie
// is het beslispunt.
describe('ownershipFromInspect', () => {
  const own = { Config: { Labels: { 'huddle.parent': 'dc-a' } } };

  it('markeert een eigen container als "own"', () => {
    expect(ownershipFromInspect(200, own, 'dc-a')).toBe('own');
  });

  it('markeert een container van een andere devcontainer als "foreign"', () => {
    expect(ownershipFromInspect(200, own, 'dc-b')).toBe('foreign');
  });

  it('markeert een ongelabelde container als "foreign"', () => {
    expect(ownershipFromInspect(200, { Config: { Labels: {} } }, 'dc-a')).toBe('foreign');
    expect(ownershipFromInspect(200, { Config: {} }, 'dc-a')).toBe('foreign');
  });

  it('markeert een 404 (No such container) als "missing"', () => {
    // Dít is de kern van issue #61: een niet-bestaande container mag geen 403
    // "not owned" opleveren, maar als "missing" worden doorgelaten zodat Docker
    // z'n eigen 404 teruggeeft en DCP de persistent container alsnog aanmaakt.
    expect(ownershipFromInspect(404, { message: 'No such container: sqlserver-x' }, 'dc-a')).toBe('missing');
  });

  it('behandelt een onverwachte fout (5xx) veilig als "foreign", niet als "missing"', () => {
    expect(ownershipFromInspect(500, { message: 'boom' }, 'dc-a')).toBe('foreign');
    expect(ownershipFromInspect(500, null, 'dc-a')).toBe('foreign');
  });

  it('behandelt onleesbaar/leeg body op een 200 veilig als "foreign"', () => {
    expect(ownershipFromInspect(200, null, 'dc-a')).toBe('foreign');
  });
});
