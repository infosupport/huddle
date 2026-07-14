import { describe, it, expect } from 'vitest';

// SQL-injectie-afweer voor updateFolderMapping (finding #9). db.ts instantieert
// bij import de native better-sqlite3-binding; die ontbreekt in een verse DMZ-
// devcontainer (nodejs.org geblokkeerd → node-gyp kan geen headers halen), dus
// probe eerst en sla anders over. In CI / de huddle-image draait dit volledig.
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(`[folder-mapping.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`);
}

const d = sqliteAvailable ? describe : describe.skip;

const { validateFolderMappingKeys } = sqliteAvailable
  ? await import('../src/db')
  : ({ validateFolderMappingKeys: (() => []) as any });

d('validateFolderMappingKeys (#9 SQL-injectie)', () => {
  it('staat bekende kolommen toe', () => {
    expect(validateFolderMappingKeys({ name: 'x', read_only: 1 }).sort()).toEqual(['name', 'read_only']);
  });

  it('weigert een geprepareerde injectie-sleutel', () => {
    // De klassieke payload uit de review: een balans-sluitende sleutel die een
    // subquery injecteert. Moet fail-closed gooien i.p.v. te interpoleren.
    expect(() =>
      validateFolderMappingKeys({
        'container_path = (SELECT password FROM container_credentials LIMIT 1), name': 'x',
      }),
    ).toThrow(/unknown folder-mapping field/i);
  });

  it('weigert elke onbekende sleutel', () => {
    expect(() => validateFolderMappingKeys({ id: 5 })).toThrow(/unknown/i);
    expect(() => validateFolderMappingKeys({ evil: 1 })).toThrow(/unknown/i);
  });
});
