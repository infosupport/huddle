import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// De folder-index: `huddle indexfolder` scant de host en zet de gevonden mappen
// hier neer, zodat de portal (die in een container draait en de host-filesystem
// niet kan zien) ze als keuze kan aanbieden. Bewust in SQLite en niet in
// config.json: dit is een scan van DEZE machine, geen team-configuratie.
//
// better-sqlite3 is native; in een DMZ-devcontainer zonder gebouwde binding
// skippen we (zelfde probe als grants.test.ts).
let sqliteAvailable = true;
try {
  const mod = await import('better-sqlite3');
  new mod.default(':memory:').close();
} catch (e) {
  sqliteAvailable = false;
  console.warn(
    `[indexed-folders.test] SKIPPED — better-sqlite3 binding niet bruikbaar: ${(e as Error).message}`
  );
}

let db: typeof import('../src/db').db;
let listIndexedFolders: typeof import('../src/db').listIndexedFolders;
let upsertIndexedFolder: typeof import('../src/db').upsertIndexedFolder;
let getIndexedFolderByPath: typeof import('../src/db').getIndexedFolderByPath;
let deleteIndexedFolder: typeof import('../src/db').deleteIndexedFolder;
let clearIndexedFolders: typeof import('../src/db').clearIndexedFolders;
let countIndexedFolders: typeof import('../src/db').countIndexedFolders;

const add = (path: string, source = 'cli') =>
  upsertIndexedFolder({ path, label: path.split('/').filter(Boolean).pop() ?? path, source });

describe.skipIf(!sqliteAvailable)('indexed folders', () => {
  beforeAll(async () => {
    const dbMod = await import('../src/db');
    db = dbMod.db;
    listIndexedFolders = dbMod.listIndexedFolders;
    upsertIndexedFolder = dbMod.upsertIndexedFolder;
    getIndexedFolderByPath = dbMod.getIndexedFolderByPath;
    deleteIndexedFolder = dbMod.deleteIndexedFolder;
    clearIndexedFolders = dbMod.clearIndexedFolders;
    countIndexedFolders = dbMod.countIndexedFolders;
    dbMod.initDb();
  });
  beforeEach(() => { db.exec('DELETE FROM indexed_folders'); });

  it('voegt toe en telt', () => {
    expect(add('T:/projects/huddle')).toBe('added');
    expect(add('T:/projects/other')).toBe('added');
    expect(countIndexedFolders()).toBe(2);
  });

  it('behandelt twee spellingen van één Windows-map als één entry', () => {
    // Windows is case-insensitive: 't:/projects/x' en 'T:/Projects/X' zijn
    // dezelfde map. Zonder NOCASE-index zou de picker duplicaten tonen.
    expect(add('T:/projects/huddle')).toBe('added');
    expect(add('t:/Projects/Huddle')).toBe('updated');
    expect(countIndexedFolders()).toBe(1);
    expect(getIndexedFolderByPath('T:/PROJECTS/HUDDLE')).toBeDefined();
  });

  it('sorteert case-insensitief op pad', () => {
    add('T:/projects/zebra');
    add('T:/projects/Apple');
    add('T:/projects/mango');
    expect(listIndexedFolders().map((f) => f.label)).toEqual(['Apple', 'mango', 'zebra']);
  });

  it('verwijdert één entry', () => {
    add('T:/projects/huddle');
    const id = getIndexedFolderByPath('T:/projects/huddle')!.id;
    deleteIndexedFolder(id);
    expect(countIndexedFolders()).toBe(0);
  });

  it('leegt de hele index zonder root', () => {
    add('T:/a');
    add('/home/me/b');
    expect(clearIndexedFolders()).toBe(2);
    expect(countIndexedFolders()).toBe(0);
  });

  it('leegt met root alleen die subtree — niet de buren', () => {
    add('T:/projects/app');
    add('T:/projects/app/sub');
    add('T:/projects/app-tools');   // zelfde prefix, andere map: moet blijven
    add('T:/elsewhere');
    expect(clearIndexedFolders('T:/projects/app')).toBe(2);
    expect(listIndexedFolders().map((f) => f.path).sort()).toEqual(['T:/elsewhere', 'T:/projects/app-tools']);
  });

  it('leegt een hele drive als root — de root eindigt zelf al op een slash', () => {
    add('T:/projects/app');
    add('T:/elsewhere');
    add('C:/keep-me');
    expect(clearIndexedFolders('T:/')).toBe(2);
    expect(listIndexedFolders().map((f) => f.path)).toEqual(['C:/keep-me']);
  });

  it('leegt vanaf de posix-root zonder de dubbele slash', () => {
    add('/home/me/b');
    add('/srv/data');
    expect(clearIndexedFolders('/')).toBe(2);
    expect(countIndexedFolders()).toBe(0);
  });

  it('escapet LIKE-wildcards in de root — een map met % of _ wist niet te veel', () => {
    add('T:/pro%ject/app');
    add('T:/proXject/app');   // zou matchen als '%' als wildcard doorging
    expect(clearIndexedFolders('T:/pro%ject')).toBe(1);
    expect(listIndexedFolders().map((f) => f.path)).toEqual(['T:/proXject/app']);
  });

  it('werkt bij re-indexeren de source bij i.p.v. een tweede rij te maken', () => {
    add('T:/projects/huddle', 'manual');
    expect(add('T:/projects/huddle', 'cli')).toBe('updated');
    expect(getIndexedFolderByPath('T:/projects/huddle')!.source).toBe('cli');
    expect(countIndexedFolders()).toBe(1);
  });
});
