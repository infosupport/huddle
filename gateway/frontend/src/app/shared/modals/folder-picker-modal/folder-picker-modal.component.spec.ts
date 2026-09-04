import { TestBed } from '@angular/core/testing';
import { SimpleChange } from '@angular/core';
import { of } from 'rxjs';
import { FolderPickerModalComponent } from './folder-picker-modal.component';
import { ApiService, HostFolderListing } from '../../../core/services/api.service';

// Selectie- en laadgedrag van de picker. De dialoog leest de host één map per
// aanroep, dus de fake API hieronder doet precies dat: hij kent een set paden en
// geeft alleen de directe kinderen terug.
const PATHS = ['T:/projects/api', 'T:/projects/web', 'T:/projects/docs', 'T:/tools'];

/** Alle mappen die uit PATHS volgen, inclusief de tussenliggende. */
function allFolders(): string[] {
  const out = new Set<string>(['T:/']);
  for (const p of PATHS) {
    const rest = p.slice(3).split('/');
    let cur = 'T:';
    for (const seg of rest) { cur = `${cur}/${seg}`; out.add(cur); }
  }
  return [...out];
}

let listCalls: string[] = [];

function fakeApi(): Pick<ApiService, 'listHostFolders'> {
  return {
    listHostFolders(path?: string) {
      listCalls.push(path ?? '');
      const parent = path ?? '';
      const folders = allFolders()
        .filter((f) => {
          if (!parent) return f === 'T:/';
          const prefix = parent.endsWith('/') ? parent : `${parent}/`;
          const rest = f.startsWith(prefix) ? f.slice(prefix.length) : '';
          return rest.length > 0 && !rest.includes('/');
        })
        .map((f) => ({ path: f, name: f === 'T:/' ? 'T:' : f.split('/').pop() as string }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return of({ path: parent, folders, truncated: false, max: 2000 } as HostFolderListing);
    },
  };
}

/** Laat elke openstaande belofte van de fake API afwikkelen. */
async function settle(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

async function open(multiple: boolean, value = ''): Promise<FolderPickerModalComponent> {
  const c = TestBed.runInInjectionContext(() => new FolderPickerModalComponent());
  c.multiple = multiple;
  c.value = value;
  c.ngOnChanges({ value: new SimpleChange(undefined, value, true) });
  c.ngOnInit();
  await settle();
  return c;
}

/** De rijen zoals ze getekend staan, met alles opengeklapt. */
async function visible(c: FolderPickerModalComponent) {
  for (let guard = 0; guard < 20; guard++) {
    const shut = c.rows.find((r) => r.canExpand && !r.open);
    if (!shut) break;
    c.toggle(shut.node, { stopPropagation() {} } as unknown as Event);
    await settle();
  }
  return c.rows;
}

const click = (mods: Partial<MouseEvent> = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as MouseEvent;

describe('FolderPickerModalComponent', () => {
  beforeEach(() => {
    listCalls = [];
    TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: fakeApi() }] });
  });

  describe('bladeren', () => {
    it('begint bij de roots en leest pas een map als je hem openklapt', async () => {
      const c = await open(false);
      expect(c.rows.map((r) => r.node.name)).toEqual(['T:']);
      expect(listCalls).toEqual(['']);

      c.toggle(c.rows[0].node, { stopPropagation() {} } as unknown as Event);
      await settle();
      expect(c.rows.map((r) => r.node.name)).toEqual(['T:', 'projects', 'tools']);
      expect(listCalls).toEqual(['', 'T:/']);
    });

    it('leest dezelfde map niet twee keer', async () => {
      const c = await open(false);
      const ev = { stopPropagation() {} } as unknown as Event;
      c.toggle(c.rows[0].node, ev); await settle();
      c.toggle(c.rows[0].node, ev); await settle(); // dicht
      c.toggle(c.rows[0].node, ev); await settle(); // en weer open
      expect(listCalls).toEqual(['', 'T:/']);
    });

    // Opnieuw openen bij de root beginnen betekent elke keer opnieuw doorklikken
    // naar de map waar je al stond.
    it('klapt open tot de map die al gekozen was', async () => {
      const c = await open(false, 'T:/projects/api');
      expect(c.rows.map((r) => r.node.path)).toContain('T:/projects/api');
      expect(c.selected).toEqual(['T:/projects/api']);
      expect(listCalls).toEqual(['', 'T:/', 'T:/projects']);
    });
  });

  describe('selectie', () => {
    it('vervangt de selectie bij een gewone klik', async () => {
      const c = await open(true);
      const rows = await visible(c);
      c.select(rows[0].node, click(), rows);
      c.select(rows[1].node, click(), rows);
      expect(c.selected).toEqual([rows[1].node.path]);
    });

    it('voegt toe met ctrl en haalt dezelfde map er weer af', async () => {
      const c = await open(true);
      const rows = await visible(c);
      c.select(rows[0].node, click(), rows);
      c.select(rows[1].node, click({ ctrlKey: true }), rows);
      expect(c.selected.length).toBe(2);
      c.select(rows[1].node, click({ ctrlKey: true }), rows);
      expect(c.selected).toEqual([rows[0].node.path]);
    });

    it('neemt met shift alles tussen anker en klik, in beide richtingen', async () => {
      const c = await open(true);
      const rows = await visible(c);
      c.select(rows[3].node, click(), rows);
      c.select(rows[1].node, click({ shiftKey: true }), rows);
      expect(c.selected).toEqual([rows[1], rows[2], rows[3]].map((r) => r.node.path));
    });

    it('emit pickedMany als er meerdere mogen, anders picked', async () => {
      const c = await open(true);
      const rows = await visible(c);
      c.select(rows[0].node, click(), rows);
      c.select(rows[1].node, click({ ctrlKey: true }), rows);

      let many: string[] = [];
      c.pickedMany.subscribe((v) => (many = v));
      c.confirm();
      expect(many.length).toBe(2);

      const single = await open(false);
      let one = '';
      single.picked.subscribe((v) => (one = v));
      single.select(single.rows[0].node, click({ ctrlKey: true }), single.rows);
      single.confirm();
      expect(one).toBe(single.rows[0].node.path);
    });

    it('vat de keuze samen op de naam van elke map', async () => {
      const c = await open(true);
      const rows = await visible(c);
      c.select(rows[0].node, click(), rows);
      expect(c.summary()).toContain(rows[0].node.name);
      c.select(rows[1].node, click({ ctrlKey: true }), rows);
      expect(c.summary()).toBe(`${rows[0].node.name}, ${rows[1].node.name}`);
    });
  });
});
