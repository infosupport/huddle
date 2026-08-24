import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Eenmalige migratie van resource-limieten + folder mappings uit SQLite naar
// ~/.huddle/config.json (#98). db.ts instantieert bij import de native
// better-sqlite3-binding, dus die wordt hier gemockt: de migratie hoeft alleen te
// weten wát de legacy-laag teruggeeft, niet hoe die het opslaat.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'huddle-migrate-'));
const CONFIG = path.join(HOME, 'config.json');
process.env.HUDDLE_HOME_DIR = HOME;

let legacyRows: any[] = [];
let legacySettings: Record<string, string | null> = {};

vi.mock('../src/db', () => ({
  getSetting: (k: string) => legacySettings[k] ?? null,
  readLegacyFolderMappings: () => legacyRows,
}));

const { migrateSettingsToHostConfig } = await import('../src/settings-migration');

function writeConfig(obj: unknown): void {
  fs.writeFileSync(CONFIG, JSON.stringify(obj, null, 2) + '\n');
}
function readConfig(): any {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

const ROW = {
  id: 4, name: 'tool', host_path: '~/.tool', volume_name: '', container_path: '/home/vscode/.tool',
  read_only: 1, enabled: 1, sort_order: 2,
};

beforeEach(() => {
  fs.rmSync(CONFIG, { force: true });
  legacyRows = [];
  legacySettings = {};
});

afterAll(() => {
  fs.rmSync(HOME, { recursive: true, force: true });
});

describe('migrateSettingsToHostConfig', () => {
  it('slaat over zolang de config niet gemount is (volgende start opnieuw)', () => {
    legacyRows = [ROW];
    expect(migrateSettingsToHostConfig()).toEqual({ skipped: true, mappings: 0, resources: [] });
  });

  it('neemt legacy-rijen en -limieten over en behoudt de id', () => {
    writeConfig({ operatorToken: 'keep-me' });
    legacyRows = [ROW];
    legacySettings = { defaultMemory: '4g', defaultCpus: ' 2 ' };

    const r = migrateSettingsToHostConfig();
    expect(r).toEqual({ skipped: false, mappings: 1, resources: ['defaultMemory', 'defaultCpus'] });

    const cfg = readConfig();
    expect(cfg.operatorToken).toBe('keep-me');
    expect(cfg.defaultMemory).toBe('4g');
    expect(cfg.defaultCpus).toBe('2'); // getrimd
    expect(cfg.folderMappings).toEqual([{
      id: 4, name: 'tool', hostPath: '~/.tool', volumeName: '', containerPath: '/home/vscode/.tool',
      readOnly: true, enabled: true, sortOrder: 2,
    }]);
  });

  it('is idempotent: een bestaande folderMappings-sleutel wint', () => {
    writeConfig({ folderMappings: [] });
    legacyRows = [ROW];

    expect(migrateSettingsToHostConfig()).toEqual({ skipped: false, mappings: 0, resources: [] });
    // Alles gewist in de portal blijft gewist — geen resurrectie van de DB-rijen.
    expect(readConfig().folderMappings).toEqual([]);
  });

  it('laat een limiet die al in de config staat ongemoeid', () => {
    writeConfig({ defaultMemory: '16g' });
    legacySettings = { defaultMemory: '4g' };

    expect(migrateSettingsToHostConfig().resources).toEqual([]);
    expect(readConfig().defaultMemory).toBe('16g');
  });

  it('doet niets als er niets te migreren valt', () => {
    writeConfig({});
    expect(migrateSettingsToHostConfig()).toEqual({ skipped: false, mappings: 0, resources: [] });
    expect('folderMappings' in readConfig()).toBe(false);
  });
});
