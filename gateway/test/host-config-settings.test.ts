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

// De gateway (portal-edits) en de CLI op de host schrijven hetzelfde bestand met
// een read-modify-write. Zonder slot draait de laatste schrijver de wijziging van
// de ander terug — de operator verliest een mapping zonder foutmelding.
describe('gelijktijdige schrijvers', () => {
  const LOCK = `${CONFIG}.lock`;

  it('laat geen .tmp of .lock achter na een geslaagde schrijfactie', () => {
    writeConfig({});
    expect(hc.setResourceDefaults({ defaultMemory: '4g' })).toBe(true);
    expect(fs.readdirSync(HOME)).toEqual(['config.json']);
  });

  it('weigert te schrijven zolang een andere schrijver het slot vasthoudt', () => {
    writeConfig({ defaultMemory: '4g' });
    fs.writeFileSync(LOCK, ''); // verse lock: een actieve schrijver
    try {
      expect(hc.setResourceDefaults({ defaultMemory: '16g' })).toBe(false);
      // Belangrijk: het bestand is ongemoeid gebleven, niet half geschreven.
      expect(readConfig().defaultMemory).toBe('4g');
    } finally {
      fs.rmSync(LOCK, { force: true });
    }
  });

  it('breekt een slot van een schrijver die halverwege is omgevallen', () => {
    writeConfig({ defaultMemory: '4g' });
    fs.writeFileSync(LOCK, '');
    const longAgo = new Date(Date.now() - 60_000);
    fs.utimesSync(LOCK, longAgo, longAgo);

    expect(hc.setResourceDefaults({ defaultMemory: '16g' })).toBe(true);
    expect(readConfig().defaultMemory).toBe('16g');
    expect(fs.existsSync(LOCK)).toBe(false);
  });

  it('zet zijn eigen identiteit in het slot i.p.v. een leeg bestand', () => {
    writeConfig({});
    let held = '';
    expect(hc.mutateHostConfig(() => { held = fs.readFileSync(LOCK, 'utf8'); return {}; })).toBe(true);
    expect(held).toMatch(new RegExp(`^${process.pid}:[0-9a-f-]{36}$`));
  });

  it('laat een slot staan dat een andere schrijver inmiddels heeft overgenomen', () => {
    writeConfig({ operatorToken: 'x' });
    // Deze schrijver doet er binnen het slot te lang over; een contender breekt
    // het als verlopen en zet zijn eigen slot neer. Bij het loslaten mag dat
    // slot dus niet weg — het is nu van iemand anders, en het weghalen zou een
    // derde schrijver naast de tweede binnenlaten.
    expect(hc.mutateHostConfig(() => {
      fs.writeFileSync(LOCK, 'van-een-andere-schrijver');
      return { defaultCpus: '2' };
    })).toBe(true);
    expect(fs.existsSync(LOCK)).toBe(true);
    expect(fs.readFileSync(LOCK, 'utf8')).toBe('van-een-andere-schrijver');
    fs.rmSync(LOCK, { force: true });
  });

  it('geeft de mutator het bestand zoals het bij het pakken van het slot is', () => {
    writeConfig({ operatorToken: 'oud' });
    // Wat de aanroeper eerder las is niet wat er nu staat: een andere schrijver
    // is ertussen gekomen. De mutator hoort de nieuwe inhoud te zien, want daar
    // baseert de folder-mapping-CRUD hieronder zijn hele lijst op.
    const snapshot = hc.readHostConfig();
    writeConfig({ operatorToken: 'nieuw', firewallRulesFolder: 'T:/rules' });

    let seen: unknown;
    expect(hc.mutateHostConfig((cur) => { seen = { ...cur }; return {}; })).toBe(true);
    expect(snapshot).toEqual({ operatorToken: 'oud' });
    expect(seen).toEqual({ operatorToken: 'nieuw', firewallRulesFolder: 'T:/rules' });
  });

  it('slaat de schrijfactie over als de mutator null teruggeeft', () => {
    writeConfig({ operatorToken: 'x' });
    expect(hc.mutateHostConfig(() => null)).toBe(false);
    expect(readConfig()).toEqual({ operatorToken: 'x' });
    expect(fs.readdirSync(HOME)).toEqual(['config.json']);
  });

  it('laat de folder-mapping-CRUD op het slot wachten i.p.v. eroverheen te schrijven', () => {
    writeConfig({ folderMappings: [{ id: 1, name: 'a', hostPath: 'T:/a', volumeName: '', containerPath: '', readOnly: false, enabled: true, sortOrder: 0 }] });
    fs.writeFileSync(LOCK, ''); // verse lock: een actieve schrijver
    try {
      expect(hc.createFolderMapping({ name: 'b', hostPath: 'T:/b', volumeName: '', containerPath: '', readOnly: false, enabled: true, sortOrder: 0 })).toBe(null);
      expect(hc.updateFolderMapping(1, { name: 'anders' })).toBe(false);
      expect(hc.deleteFolderMapping(1)).toBe(false);
      // Geen van de drie heeft het bestand aangeraakt.
      expect(readConfig().folderMappings).toHaveLength(1);
      expect(readConfig().folderMappings[0].name).toBe('a');
    } finally {
      fs.rmSync(LOCK, { force: true });
    }
  }, 10_000); // drie schrijvers die elk LOCK_WAIT_MS uitzitten

  it('leidt een nieuwe mapping af uit het bestand, niet uit een oudere lijst', () => {
    writeConfig({ folderMappings: [] });
    const stale = hc.listFolderMappings(); // wat de portal in handen had
    // Een andere schrijver zet er ondertussen een mapping bij, met een hogere id
    // en een sleutel die niets met mappings te maken heeft.
    writeConfig({
      operatorToken: 'van-de-cli',
      folderMappings: [{ id: 9, name: 'ander', hostPath: 'T:/ander', volumeName: '', containerPath: '', readOnly: false, enabled: true, sortOrder: 0 }],
    });

    const id = hc.createFolderMapping({ name: 'nieuw', hostPath: 'T:/nieuw', volumeName: '', containerPath: '', readOnly: false, enabled: true, sortOrder: 0 });
    expect(stale).toEqual([]);
    expect(id).toBe(10); // niet 1: de id komt uit het bestand
    const after = readConfig();
    expect(after.folderMappings.map((m: any) => m.id)).toEqual([9, 10]);
    expect(after.operatorToken).toBe('van-de-cli'); // niet weggeschreven
  });

  it('leest binnen het slot, dus een wijziging van de CLI blijft staan', () => {
    writeConfig({ operatorToken: 'from-cli' });
    // Wat de portal in handen had toen de operator op opslaan drukte, is niet
    // wat er nu in het bestand staat: de CLI heeft er ondertussen een sleutel bij
    // gezet. De merge moet die overleven.
    writeConfig({ operatorToken: 'from-cli', firewallRulesFolder: 'T:/rules' });
    expect(hc.setResourceDefaults({ defaultCpus: '2' })).toBe(true);
    expect(readConfig()).toEqual({
      operatorToken: 'from-cli', firewallRulesFolder: 'T:/rules', defaultCpus: '2',
    });
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
