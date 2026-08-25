import { Component, EventEmitter, Input, OnChanges, Output, SimpleChanges } from '@angular/core';
import { IconComponent } from '../../components/icon/icon.component';
import { IndexedFolder } from '../../../core/services/api.service';
import {
  FolderNode, FolderRow, ancestorPaths, breadcrumbs, buildFolderTree, canonicalPath, findNode,
  flattenNodes, folderRows, prettyPath,
} from '../../components/folder-select/folder-tree.util';

// The folder dialog Huddle cannot ask the operating system for.
//
// The portal runs in a container: no native folder picker, no way to look at the
// host filesystem. `huddle indexfolder` fills an index on the host, and this
// modal browses it the way a file dialog does — a tree for structure, an icon
// view for scanning, a breadcrumb for where you are, one folder as the answer.
//
// It stays a *picker*: it selects a path, it does not save anything. The caller
// decides what the chosen folder means (workspace, mount, mapping).
@Component({
  selector: 'app-folder-picker-modal',
  standalone: true,
  imports: [IconComponent],
  template: `
    <div class="modal fp-modal" (mousedown)="onBackdrop($event)">
      <div class="modal-box fp-box" (mousedown)="$event.stopPropagation()">
        <div class="fp-head">
          <h3>{{ title }}</h3>
          <p>{{ subtitle }}</p>
        </div>

        <div class="fp-toolbar">
          <div class="fp-search">
            <app-icon name="search" [size]="15" />
            <input type="text" [value]="query" placeholder="Search folders…" autocomplete="off"
                   spellcheck="false" (input)="onQuery($any($event.target).value)" />
          </div>

          <nav class="fp-crumbs" aria-label="Location">
            <button type="button" class="fp-crumb" title="All indexed roots" (click)="goHome()">
              <app-icon name="home" [size]="15" />
            </button>
            @for (crumb of crumbs; track crumb.path) {
              <span class="fp-sep">›</span>
              <button type="button" class="fp-crumb" (click)="goTo(crumb.path)">{{ crumb.name }}</button>
            }
          </nav>

          <div class="fp-views">
            <button type="button" [class.on]="view === 'tree'" (click)="view = 'tree'" title="Tree view">
              <app-icon name="list-tree" [size]="15" />
            </button>
            <button type="button" [class.on]="view === 'grid'" (click)="view = 'grid'" title="Icon view">
              <app-icon name="grid" [size]="15" />
            </button>
          </div>
        </div>

        @if (multiple) {
          <p class="fp-multi-hint">
            Click to pick one, <b>Ctrl-click</b> to add more, <b>Shift-click</b> for a range.
            Double-click opens a folder.
          </p>
        }

        <div class="fp-body">
          @if (!folders.length) {
            <p class="fp-empty">
              Nothing indexed yet. Run <code>huddle indexfolder</code> on the host in the folder
              that holds your projects, then reopen this dialog. Typing a path by hand keeps working.
            </p>
          } @else if (view === 'tree') {
            <div class="fp-tree" role="tree">
              @for (row of rows; track row.node.path) {
                <div class="fp-row" role="treeitem" [class.sel]="isSelected(row.node)"
                     [style.padding-left.px]="8 + row.depth * 18"
                     (click)="select(row.node, $event, rows)" (dblclick)="enter(row.node)">
                  @if (row.node.children.length) {
                    <button type="button" class="fp-twist" (click)="toggle(row.node, $event)"
                            [title]="row.open ? 'Collapse' : 'Expand'">
                      <app-icon [name]="row.open ? 'chevron-down' : 'chevron-right'" [size]="14" />
                    </button>
                  } @else {
                    <span class="fp-twist"></span>
                  }
                  <span class="fp-icon folder-img" aria-hidden="true"></span>
                  <span class="fp-name" [class.dim]="!row.node.indexed">{{ row.node.name }}</span>
                </div>
              } @empty {
                <p class="fp-empty">No folder matches “{{ query }}”.</p>
              }
            </div>
          } @else {
            <div class="fp-grid">
              @for (node of tiles; track node.path) {
                <button type="button" class="fp-tile" [class.sel]="isSelected(node)"
                        (click)="select(node, $event, tiles)" (dblclick)="enter(node)"
                        [title]="node.children.length ? node.path + ' — double-click to open' : node.path">
                  <span class="fp-tile-icon folder-img" aria-hidden="true"></span>
                  <span class="fp-tile-name">{{ node.name }}</span>
                </button>
              } @empty {
                <p class="fp-empty">
                  @if (query) { No folder matches “{{ query }}”. } @else { This folder has nothing indexed below it. }
                </p>
              }
            </div>
          }
        </div>

        <div class="fp-foot">
          <div class="fp-selected">
            <span class="fp-selected-label">
              @if (multiple) { {{ selected.length }} folder(s) selected } @else { Selected folder }
            </span>
            <span class="fp-selected-path">{{ summary() }}</span>
          </div>
          <div class="fp-actions">
            <button type="button" class="btn btn-ghost" (click)="cancel.emit()">Cancel</button>
            <button type="button" class="btn btn--accent" [disabled]="!selected.length" (click)="confirm()">
              @if (multiple && selected.length > 1) { Use {{ selected.length }} folders } @else { Select folder }
            </button>
          </div>
        </div>
      </div>
    </div>
  `,
  styles: [`
    /* Above the modal that opened it (.modal is z-index 1000). */
    .fp-modal { z-index: 1100; }
    .fp-box { width: min(94vw, 640px); display: flex; flex-direction: column; max-height: 86vh; }

    .fp-head { padding: 1.1rem 1.25rem .75rem; }
    .fp-head h3 { margin: 0; font-size: 1.05rem; }
    .fp-head p { margin: .25rem 0 0; font-size: .82rem; color: var(--text-muted); }

    .fp-toolbar {
      display: flex; align-items: center; gap: .5rem; flex-wrap: wrap;
      padding: 0 1.25rem .85rem;
    }
    .fp-search {
      flex: 1 1 12rem; min-width: 0; display: flex; align-items: center; gap: .45rem;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      padding: .35rem .6rem; color: var(--text-muted); background: var(--surface);
    }
    .fp-search input { flex: 1; min-width: 0; border: 0; outline: 0; background: none; color: var(--text); font-size: .85rem; padding: 0; }
    .fp-crumbs {
      display: flex; align-items: center; gap: .25rem; max-width: 100%; overflow: auto;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: .3rem .55rem;
    }
    .fp-crumb {
      border: 0; background: none; cursor: pointer; color: var(--text); font-size: .82rem;
      padding: 0 .1rem; display: inline-flex; align-items: center; white-space: nowrap;
    }
    .fp-crumb:hover { color: var(--accent); }
    .fp-sep { color: var(--text-dim); font-size: .8rem; }
    .fp-views { display: flex; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; }
    .fp-views button {
      border: 0; background: var(--surface); color: var(--text-muted);
      padding: .35rem .5rem; cursor: pointer; display: inline-flex;
    }
    .fp-views button.on { background: var(--accent-soft); color: var(--accent-strong); }

    .fp-body { flex: 1; min-height: 12rem; overflow: auto; border-top: 1px solid var(--border); }
    .fp-tree { padding: .4rem 0; }
    .fp-row {
      display: flex; align-items: center; gap: .4rem; padding: .25rem .75rem .25rem 0;
      cursor: pointer; font-size: .85rem; white-space: nowrap;
    }
    .fp-row:hover { background: var(--surface-hover); }
    .fp-row.sel { background: var(--accent-soft); color: var(--accent-strong); }
    .fp-twist {
      flex: 0 0 auto; width: 1.15rem; height: 1.15rem; border: 0; background: none; padding: 0;
      cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center;
    }
    .fp-icon { flex: 0 0 auto; width: 18px; height: 18px; display: inline-flex; }
    /* A parent that is only here because a folder below it was indexed. */
    .fp-name.dim { color: var(--text-muted); }

    .fp-grid {
      display: grid; gap: .75rem; padding: 1rem 1.25rem;
      grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    }
    .fp-tile {
      display: flex; flex-direction: column; align-items: center; gap: .5rem;
      padding: 1rem .5rem; cursor: pointer; font-size: .8rem; color: var(--text);
      background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
    }
    .fp-tile:hover { background: var(--surface-hover); }
    .fp-tile.sel { background: var(--accent-soft); border-color: var(--accent); color: var(--accent-strong); }
    .fp-tile-icon { width: 44px; height: 44px; display: inline-flex; }
    .fp-tile-name { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

    .fp-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      padding: .8rem 1.25rem; border-top: 1px solid var(--border);
    }
    .fp-selected { display: flex; flex-direction: column; min-width: 0; }
    .fp-selected-label { font-size: .7rem; text-transform: uppercase; letter-spacing: .04em; color: var(--text-muted); }
    .fp-selected-path { font-size: .82rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .fp-actions { display: flex; gap: .5rem; flex: 0 0 auto; }
    /* Shift-click must extend the selection, not smear a text highlight. */
    .fp-row, .fp-tile { user-select: none; }
    .fp-multi-hint { margin: 0; padding: 0 1.25rem .6rem; font-size: .76rem; color: var(--text-muted); }
    .fp-empty { margin: 0; padding: 1.25rem; font-size: .82rem; color: var(--text-muted); }
    .fp-empty code { font-size: .78rem; }
  `],
})
export class FolderPickerModalComponent implements OnChanges {
  @Input() folders: IndexedFolder[] = [];
  @Input() value = '';
  @Input() title = 'Select folder';
  @Input() subtitle = 'Choose a folder from your indexed locations.';
  /** Ctrl/Shift-click picks several folders; the answer arrives on pickedMany. */
  @Input() multiple = false;
  @Output() picked = new EventEmitter<string>();
  @Output() pickedMany = new EventEmitter<string[]>();
  @Output() cancel = new EventEmitter<void>();

  view: 'tree' | 'grid' = 'tree';
  query = '';
  rows: FolderRow[] = [];
  tiles: FolderNode[] = [];
  crumbs: { name: string; path: string }[] = [];
  /** Picked folders, in the order they were picked. One entry unless multiple. */
  selected: string[] = [];

  private tree: FolderNode[] = [];
  private expanded = new Set<string>();
  // Where a Shift-click measures its range from.
  private anchor = '';
  // The folder we are browsing. Empty means "all indexed roots".
  private cwd = '';

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['folders']) this.tree = buildFolderTree(this.folders.map((f) => f.path));
    if (changes['folders'] || changes['value']) {
      const current = this.value.trim() ? canonicalPath(this.value) : '';
      this.selected = current ? [current] : [];
      this.anchor = current;
      // Open where the current value lives, so reopening the dialog does not
      // start over at the root every time.
      const parents = ancestorPaths(current);
      for (const p of parents) this.expanded.add(p.toLowerCase());
      this.cwd = parents.length > 1 ? parents[parents.length - 1] : '';
      this.refresh();
    }
  }

  pretty(path: string): string {
    return prettyPath(path);
  }

  isSelected(node: FolderNode): boolean {
    const key = node.path.toLowerCase();
    return this.selected.some((p) => p.toLowerCase() === key);
  }

  /** What the footer shows: the one path, or the names of everything picked. */
  summary(): string {
    if (!this.selected.length) return '—';
    if (!this.multiple) return prettyPath(this.selected[0]);
    return this.selected.map((p) => p.split('/').filter(Boolean).pop() || p).join(', ');
  }

  // File-dialog rules: plain click replaces the selection, Ctrl/Cmd adds or
  // removes one, Shift takes everything between the anchor and here — over the
  // list as it is drawn, so a range never reaches into collapsed branches.
  select(node: FolderNode, event?: MouseEvent, visible?: readonly (FolderRow | FolderNode)[]): void {
    if (!this.multiple || !event || (!event.ctrlKey && !event.metaKey && !event.shiftKey)) {
      this.selected = [node.path];
      this.anchor = node.path;
      return;
    }

    if (event.shiftKey && this.anchor && visible?.length) {
      const paths = visible.map((v) => ('node' in v ? v.node.path : v.path));
      const from = paths.findIndex((p) => p.toLowerCase() === this.anchor.toLowerCase());
      const to = paths.findIndex((p) => p.toLowerCase() === node.path.toLowerCase());
      if (from >= 0 && to >= 0) {
        this.selected = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
        return;
      }
    }

    const key = node.path.toLowerCase();
    this.selected = this.isSelected(node)
      ? this.selected.filter((p) => p.toLowerCase() !== key)
      : [...this.selected, node.path];
    this.anchor = node.path;
  }

  /** Double-click / breadcrumb navigation: browse *into* a folder. */
  enter(node: FolderNode): void {
    if (!node.children.length) return;
    this.selected = [node.path];
    this.anchor = node.path;
    this.cwd = node.path;
    this.expanded.add(node.path.toLowerCase());
    this.refresh();
  }

  goTo(path: string): void {
    this.cwd = path;
    this.refresh();
  }

  goHome(): void {
    this.cwd = '';
    this.refresh();
  }

  toggle(node: FolderNode, event: Event): void {
    event.stopPropagation();
    const key = node.path.toLowerCase();
    if (this.expanded.has(key)) this.expanded.delete(key);
    else this.expanded.add(key);
    if (this.query) this.query = '';
    this.refresh();
  }

  onQuery(q: string): void {
    this.query = q;
    this.refresh();
  }

  confirm(): void {
    if (!this.selected.length) return;
    if (this.multiple) this.pickedMany.emit([...this.selected]);
    else this.picked.emit(this.selected[0]);
  }

  // Bound to mousedown, not click: a click fires on the common ancestor of press
  // and release, so dragging a selection from inside the box and letting go over
  // the backdrop used to count as "clicked outside" and threw the dialog away.
  onBackdrop(event: MouseEvent): void {
    if ((event.target as HTMLElement).classList.contains('modal')) this.cancel.emit();
  }

  private refresh(): void {
    const at = findNode(this.tree, this.cwd);
    if (this.cwd && !at) this.cwd = ''; // index re-scanned: the branch is gone

    // The tree shows the browsed folder itself as its top row, so you can pick
    // the folder you navigated into, not just its children.
    const scope = at ? [at] : this.tree;
    if (at) this.expanded.add(at.path.toLowerCase());
    this.rows = folderRows(scope, this.expanded, this.query);

    const children = at ? at.children : this.tree;
    this.tiles = this.query
      ? flattenNodes(children).filter((n) => n.name.toLowerCase().includes(this.query.trim().toLowerCase()))
      : children;

    this.crumbs = breadcrumbs(this.cwd);
  }
}
