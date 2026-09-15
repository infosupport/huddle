import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { hostRoots, listHostFolders, hostFolderProblem, MAX_FOLDER_ENTRIES } from '../src/host-browse';

// Live bladeren op de host, dat de folder-index (#69) vervangt: Huddle Node
// draait op de host, dus de portal kan gewoon kijken in plaats van een
// momentopname te raadplegen die de operator uit een shell moest vullen.
let root = '';

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-browse-'));
  for (const dir of ['app', 'app/src', 'lib', 'node_modules', '.git']) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, 'README.md'), '# not a folder\n');
});

afterAll(() => { fs.rmSync(root, { recursive: true, force: true }); });

describe('listHostFolders', () => {
  it('geeft alleen de directe submappen, gesorteerd', () => {
    const listing = listHostFolders(root);
    expect(listing.folders.map((f) => f.name)).toEqual(['.git', 'app', 'lib', 'node_modules']);
    expect(listing.truncated).toBe(false);
  });

  it('laat bestanden weg maar verborgen mappen niet', () => {
    const names = listHostFolders(root).folders.map((f) => f.name);
    expect(names).not.toContain('README.md');
    // Een map die de operator in zijn eigen verkenner ziet, moet hier ook staan.
    expect(names).toContain('.git');
  });

  // Eén niveau per aanroep is de hele afspraak: dat maakt bladeren in een
  // driveroot betaalbaar en zorgt dat er geen diepte-parameter is om fout te
  // zetten.
  it('daalt niet zelf af — daar is de volgende aanroep voor', () => {
    const app = listHostFolders(root).folders.find((f) => f.name === 'app');
    expect(app).toBeDefined();
    expect(listHostFolders(app!.path).folders.map((f) => f.name)).toEqual(['src']);
  });

  it('geeft paden terug met forward slashes, zoals de portal ze verwerkt', () => {
    for (const f of listHostFolders(root).folders) expect(f.path).not.toContain('\\');
  });

  // Een map die je niet mag of kan lezen is een normale toestand (permissies, een
  // losgekoppelde schijf); de dialoog moet dan leeg blijven, niet omvallen.
  it('geeft een lege listing voor een map die niet te lezen is', () => {
    const listing = listHostFolders(path.join(root, 'bestaat-niet'));
    expect(listing.folders).toEqual([]);
  });
});

describe('hostFolderProblem', () => {
  it('vindt niets mis met een echte map', () => {
    expect(hostFolderProblem(root)).toBeNull();
  });

  it('klaagt over een pad dat niet bestaat', () => {
    expect(hostFolderProblem(path.join(root, 'weg'))).toMatch(/does not exist/);
  });

  it('klaagt over een bestand', () => {
    expect(hostFolderProblem(path.join(root, 'README.md'))).toMatch(/not a folder/);
  });
});

describe('hostRoots', () => {
  it('geeft minstens één beginpunt om vanaf te bladeren', () => {
    const roots = hostRoots();
    expect(roots.length).toBeGreaterThan(0);
    for (const r of roots) expect(r.name.length).toBeGreaterThan(0);
  });

  it('noemt de home-map, want daar staan de projecten meestal', () => {
    const home = os.homedir().replace(/\\/g, '/');
    expect(hostRoots().some((r) => r.path === home)).toBe(true);
  });

  it('noemt elk beginpunt één keer', () => {
    const paths = hostRoots().map((r) => r.path.toLowerCase());
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('grote mappen', () => {
  it('kapt af op MAX_FOLDER_ENTRIES en zegt dat erbij', () => {
    const big = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-big-'));
    try {
      for (let i = 0; i < MAX_FOLDER_ENTRIES + 5; i++) fs.mkdirSync(path.join(big, `d${i}`));
      const listing = listHostFolders(big);
      expect(listing.folders.length).toBe(MAX_FOLDER_ENTRIES);
      expect(listing.truncated).toBe(true);
    } finally {
      fs.rmSync(big, { recursive: true, force: true });
    }
  });
});
