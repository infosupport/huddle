import { describe, it, expect, beforeEach } from 'vitest';
import { SimpleChange } from '@angular/core';
import { FolderPickerModalComponent } from './folder-picker-modal.component';
import { IndexedFolder } from '../../../core/services/api.service';

// Selectie-gedrag van de picker. Puur klasse-logica — geen TestBed nodig, want
// select() raakt alleen de eigen velden.
const PATHS = ['T:/projects/api', 'T:/projects/web', 'T:/projects/docs', 'T:/tools'];

function folders(): IndexedFolder[] {
  return PATHS.map((path, i) => ({ id: i + 1, path, source: 'scan' }) as IndexedFolder);
}

function open(multiple: boolean): FolderPickerModalComponent {
  const c = new FolderPickerModalComponent();
  c.folders = folders();
  c.multiple = multiple;
  c.ngOnChanges({ folders: new SimpleChange(undefined, c.folders, true) });
  c.ngOnChanges({ value: new SimpleChange(undefined, '', true) });
  c.onQuery(''); // vult rows/tiles
  return c;
}

/** De rijen zoals ze getekend staan, met alles opengeklapt. */
function visible(c: FolderPickerModalComponent) {
  for (let guard = 0; guard < 20; guard++) {
    const shut = c.rows.find(r => r.node.children.length && !r.open);
    if (!shut) break;
    c.toggle(shut.node, { stopPropagation() {} } as unknown as Event);
  }
  return c.rows;
}

const click = (mods: Partial<MouseEvent> = {}) => ({ ctrlKey: false, metaKey: false, shiftKey: false, ...mods }) as MouseEvent;

describe('FolderPickerModalComponent selectie', () => {
  let c: FolderPickerModalComponent;
  beforeEach(() => { c = open(true); });

  it('vervangt de selectie bij een gewone klik', () => {
    const rows = visible(c);
    c.select(rows[0].node, click(), rows);
    c.select(rows[1].node, click(), rows);
    expect(c.selected).toEqual([rows[1].node.path]);
  });

  it('voegt toe met ctrl en haalt dezelfde map er weer af', () => {
    const rows = visible(c);
    c.select(rows[0].node, click(), rows);
    c.select(rows[1].node, click({ ctrlKey: true }), rows);
    expect(c.selected.length).toBe(2);
    c.select(rows[1].node, click({ ctrlKey: true }), rows);
    expect(c.selected).toEqual([rows[0].node.path]);
  });

  it('neemt met shift alles tussen anker en klik, in beide richtingen', () => {
    const rows = visible(c);
    c.select(rows[3].node, click(), rows);
    c.select(rows[1].node, click({ shiftKey: true }), rows);
    expect(c.selected).toEqual([rows[1], rows[2], rows[3]].map(r => r.node.path));
  });

  it('emit pickedMany als er meerdere mogen, anders picked', () => {
    const rows = visible(c);
    c.select(rows[0].node, click(), rows);
    c.select(rows[1].node, click({ ctrlKey: true }), rows);

    let many: string[] = [];
    c.pickedMany.subscribe(v => (many = v));
    c.confirm();
    expect(many.length).toBe(2);

    const single = open(false);
    let one = '';
    single.picked.subscribe(v => (one = v));
    single.select(single.rows[0].node, click({ ctrlKey: true }), single.rows);
    single.confirm();
    expect(one).toBe(single.rows[0].node.path);
  });

  it('vat de keuze samen op de naam van elke map', () => {
    const rows = visible(c);
    c.select(rows[0].node, click(), rows);
    expect(c.summary()).toContain(rows[0].node.name);
    c.select(rows[1].node, click({ ctrlKey: true }), rows);
    expect(c.summary()).toBe(`${rows[0].node.name}, ${rows[1].node.name}`);
  });
});
