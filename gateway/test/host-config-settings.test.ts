import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Resource limits en folder mappings staan sinds #98 in de CLI-config
// (~/.huddle/config.json, in de gateway gemount op /huddle-home) i.p.v. SQLite.
// host-config.ts leest HUDDLE_HOME_DIR bij module-load, dus die moet vóór de
// import staan — vandaar de dynamische import hieronder.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-home-'));
const CONFIG = path.join(HOME, 'config.json');
process.env.HUDDLE_HOME_DIR = HOME;

const hc = await import('../src/host-config');

function writeConfig(obj: unknown): void {
  fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2) + '\n');
}
function readConfig(): any {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

beforeEach(() => {
  fs.rmSync(CONFIG, { force: true });
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('resource defaults in config.json', () => {
  it('geeft leeg terug als het bestand niet gemount is', () => {
    expect(hc.hostConfigAvailable()).toBe(false);
    expect(hc.getResourceDefaults()).toEqual({ defaultMemory: '', defaultCpus: '' });
  });

  it('weigert te schrijven zonder gemounte config (persisted=false)', () => {
    expect(hc.setResourceDefaults({ defaultMemory: '4g' })).toBe(false);
  });

  it('schrijft en leest de limieten terug', () => {
    writeConfig({ operatorToken: 'keep-me' });
    expect(hc.setResourceDefaults({ defaultMemory: '4g', defaultCpus: '2' })).toBe(true);
    expect(hc.getResourceDefaults()).toEqual({ defaultMemory: '4g', defaultCpus: '2' });
    // De rest van de config blijft ongemoeid — de CLI leest hetzelfde bestand.
    expect(readConfig().operatorToken).toBe('keep-me');
  });

  it('verwijdert de sleutel bij een lege waarde i.p.v. "" te bewaren', () => {
    writeConfig({ defaultMemory: '4g', defaultCpus: '2' });
    expect(hc.setResourceDefaults({ defaultMemory: '' })).toBe(true);
    expect('defaultMemory' in readConfig()).toBe(false);
    expect(readConfig().defaultCpus).toBe('2');
  });
});

describe('folder mappings in config.json', () => {
  it('geeft een lege lijst bij ontbrekende of kapotte config', () => {
    expect(hc.listFolderMappings()).toEqual([]);
    writeConfig({ folderMappings: 'niet-een-array' });
    expect(hc.listFolderMappings()).toEqual([]);
  });

  it('doet CRUD met stabiele, oplopende ids', () => {
    writeConfig({});
    const id1 = hc.createFolderMapping({
      name: 'tool', hostPath: '~/.tool', volumeName: '', containerPath: '/home/vscode/.tool',
      readOnly: false, enabled: true, sortOrder: 0,
    });
    const id2 = hc.createFolderMapping({
      name: 'cache', hostPath: '', volumeName: 'huddle-cache', containerPath: '/cache',
      readOnly: true, enabled: true, sortOrder: 0,
    });
    expect([id1, id2]).toEqual([1, 2]);

    expect(hc.updateFolderMapping(2, { enabled: false })).toBe(true);
    expect(hc.getFolderMapping(2)?.enabled).toBe(false);

    // Een verwijderde id maakt geen id opnieuw uit: max+1 blijft oplopen.
    expect(hc.deleteFolderMapping(1)).toBe(true);
    expect(hc.listFolderMappings().map(m => m.id)).toEqual([2]);
    expect(hc.createFolderMapping({
      name: 'third', hostPath: '/x', volumeName: '', containerPath: '/x',
      readOnly: false, enabled: true, sortOrder: 0,
    })).toBe(3);
  });

  it('meldt een onbekende id op update, en delete is idempotent', () => {
    writeConfig({ folderMappings: [] });
    expect(hc.updateFolderMapping(99, { name: 'x' })).toBe(false);
    expect(hc.deleteFolderMapping(99)).toBe(true);
  });

  it('sorteert op sortOrder en dan id', () => {
    writeConfig({
      folderMappings: [
        { id: 1, name: 'b', containerPath: '/b', sortOrder: 5 },
        { id: 2, name: 'a', containerPath: '/a', sortOrder: 1 },
        { id: 3, name: 'c', containerPath: '/c', sortOrder: 5 },
      ],
    });
    expect(hc.listFolderMappings().map(m => m.name)).toEqual(['a', 'b', 'c']);
  });

  it('is robuust tegen een handmatig gehavend bestand', () => {
    // De config is hand-editable: ontbrekende of fout getypeerde velden mogen
    // niet als `undefined` in de Docker-mountspec belanden.
    writeConfig({ folderMappings: [{ name: 'half' }, 'rommel', { id: 'x', enabled: false }] });
    const [first, second, third] = hc.listFolderMappings();
    expect(first).toEqual({
      id: 1, name: 'half', hostPath: '', volumeName: '', containerPath: '',
      readOnly: false, enabled: true, sortOrder: 0,
    });
    expect(second.name).toBe('');       // 'rommel' → lege mapping, geen crash
    expect(third.enabled).toBe(false);  // id 'x' → fallback-index
  });

  it('schrijft de sleutel ook als de lijst leeg wordt (eigendomsmarkering)', () => {
    writeConfig({ folderMappings: [{ id: 1, name: 'x', containerPath: '/x' }] });
    expect(hc.deleteFolderMapping(1)).toBe(true);
    expect(readConfig().folderMappings).toEqual([]);
  });

  it('overleeft een niet-schrijfbare config zonder te gooien', () => {
    writeConfig({});
    fs.chmodSync(HOME, 0o500); // read+execute: geen nieuwe .tmp aanmaken
    try {
      expect(hc.createFolderMapping({
        name: 'x', hostPath: '/x', volumeName: '', containerPath: '/x',
        readOnly: false, enabled: true, sortOrder: 0,
      })).toBe(null);
    } finally {
      fs.chmodSync(HOME, 0o700);
    }
  });
});

describe('wire-conversie', () => {
  it('houdt de HTTP-vorm gelijk aan wat de portal al sprak', () => {
    expect(hc.toWireMapping({
      id: 7, name: 'tool', hostPath: '~/.tool', volumeName: '', containerPath: '/home/vscode/.tool',
      readOnly: true, enabled: false, sortOrder: 2,
    })).toEqual({
      id: 7, name: 'tool', host_path: '~/.tool', volume_name: '', container_path: '/home/vscode/.tool',
      read_only: 1, enabled: 0, sort_order: 2,
    });
  });
});
