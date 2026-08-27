import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiService, HuddleSettings, FolderMapping, IndexedFolder } from '../../core/services/api.service';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { FolderSelectComponent } from '../../shared/components/folder-select/folder-select.component';
import {
  FolderNode, breadcrumbs, buildFolderTree, findNode, flattenNodes, folderRows, prettyPath,
} from '../../shared/components/folder-select/folder-tree.util';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, IconComponent, FolderSelectComponent],
  template: `
    <div class="page-header">
      <h1>Settings</h1>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }

    @if (configMounted() === false) {
      <p class="error-note">
        The CLI config (<code>~/.huddle/config.json</code>) is not mounted into Huddle, so
        nothing on this page can be saved. Run <code>huddle restart</code> on the host first.
      </p>
    }

    <div class="card">
      <h2>Resource limits</h2>
      <p class="hint">
        Default CPU and memory limits for new devcontainers. Leave empty for no limit.
        Stored in <code>~/.huddle/config.json</code>; applies to the next devcontainer you start.
      </p>
      <form (ngSubmit)="saveResources()">
        <div class="field-row">
          <div class="field">
            <label>Default memory (e.g. 4g, 2048m)</label>
            <input [(ngModel)]="resources.defaultMemory" name="defaultMemory"
                   placeholder="e.g. 4g" autocomplete="off">
          </div>
          <div class="field">
            <label>Default CPU (e.g. 2, 0.5)</label>
            <input [(ngModel)]="resources.defaultCpus" name="defaultCpus"
                   placeholder="e.g. 2" autocomplete="off">
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn--accent" [disabled]="savingResources()">
            {{ savingResources() ? 'Saving…' : 'Save' }}
          </button>
          @if (resourceNote()) { <span class="saved-note">{{ resourceNote() }}</span> }
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Folder mappings</h2>
      <p class="hint">
        Folders or volumes that are automatically mounted in every new devcontainer,
        and — for mappings with a host path — in every new sandbox as well.
        Use a host path for bind mounts, or a volume name for Docker volumes.
        Stored in <code>~/.huddle/config.json</code> so the team can review them in version control.
        A sandbox can only mount host folders: sbx mounts each folder at its own host
        path and Huddle links it at the container path below, without ever overwriting
        what the agent already has there.
      </p>

      <table class="mappings-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Source (host path or volume)</th>
            <th>Container path</th>
            <th>RO</th>
            <th>On</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (m of mappings(); track m.id) {
            <tr [class.disabled-row]="!m.enabled">
              <td>{{ m.name }}</td>
              <td class="source-cell">{{ m.host_path || m.volume_name || '—' }}</td>
              <td class="mono">{{ m.container_path }}</td>
              <td>{{ m.read_only ? 'RO' : 'RW' }}</td>
              <td>
                <input type="checkbox" [checked]="m.enabled"
                       (change)="toggleMapping(m)">
              </td>
              <td>
                <button class="btn btn--danger btn--sm" (click)="deleteMapping(m.id)">
                  Delete
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>

      <details class="add-form">
        <summary>+ Add mapping</summary>
        <form (ngSubmit)="addMapping()" class="add-mapping-form">
          <div class="field-row">
            <div class="field">
              <label>Name</label>
              <input [(ngModel)]="newMapping.name" name="nm_name" placeholder="e.g. My tool config" autocomplete="off" required>
            </div>
            <div class="field">
              <label>Container path</label>
              <input [(ngModel)]="newMapping.container_path" name="nm_cpath" placeholder="/home/vscode/.mytool" autocomplete="off" required>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label for="nm_hpath">Host path (bind mount, optional)</label>
              <app-folder-select inputId="nm_hpath" [value]="newMapping.host_path" [folders]="indexedFolders()"
                                 placeholder="C:/Users/me/.mytool"
                                 (valueChange)="newMapping.host_path = $event" />
            </div>
            <div class="field">
              <label>Volume name (Docker volume, optional)</label>
              <input [(ngModel)]="newMapping.volume_name" name="nm_vol" placeholder="huddle-mytool-settings" autocomplete="off">
            </div>
          </div>
          <div class="field-row">
            <label class="checkbox-label">
              <input type="checkbox" [(ngModel)]="newMappingReadOnly" name="nm_ro"> Read-only
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn--accent" [disabled]="addingMapping()">
              {{ addingMapping() ? 'Adding…' : 'Add' }}
            </button>
          </div>
        </form>
      </details>
    </div>

    <div class="card card--new">
      <div class="tmd-head">
        <span class="tmd-folder" aria-hidden="true"></span>
        <h2 class="tmd-title">
          Team-managed defaults (extension &amp; firewall rules)
          <span class="pill pill--new">NEW</span>
        </h2>
      </div>

      <div class="field-row tmd-cols">
        <div class="field">
          <label for="extensionsFolder">Extensions folder</label>
          <p class="hint">Path to folder containing extension definitions (read on startup &amp; reload).</p>
          <div class="tmd-input-row">
            <app-folder-select inputId="extensionsFolder" [value]="resources.extensionsFolder"
                               [folders]="indexedFolders()" placeholder="/path/to/extensions"
                               (valueChange)="resources.extensionsFolder = $event" />
            <button type="button" class="btn btn-ghost" (click)="saveFolders()" [disabled]="savingFolders()">Save</button>
          </div>
        </div>
        <div class="field">
          <label for="firewallRulesFolder">Firewall rules folder</label>
          <p class="hint">Path to folder containing firewall rules (read on startup &amp; reload).</p>
          <div class="tmd-input-row">
            <app-folder-select inputId="firewallRulesFolder" [value]="resources.firewallRulesFolder"
                               [folders]="indexedFolders()" placeholder="/path/to/firewall_rules"
                               (valueChange)="resources.firewallRulesFolder = $event" />
            <button type="button" class="btn btn-ghost" (click)="reloadFirewallFolder()" [disabled]="savingFolders()">Reload</button>
          </div>
        </div>
      </div>
      @if (folderNote()) { <span class="saved-note">{{ folderNote() }}</span> }
    </div>

    <div class="card">
      <div class="index-head">
        <div>
          <h2>Indexed folders</h2>
          <p class="hint">Manage the folders available to devcontainers.</p>
        </div>
        <button type="button" class="btn btn--accent index-add-btn" (click)="showAddFolder.set(!showAddFolder())">
          <app-icon name="plus" [size]="14" /> Add folder
        </button>
      </div>

      @if (showAddFolder()) {
        <form class="index-add" (ngSubmit)="addIndexedFolder()">
          <input [(ngModel)]="newIndexedFolder" name="newIndexedFolder" id="new-indexed-folder"
                 placeholder="C:/projects/my-project" autocomplete="off" spellcheck="false">
          <button type="submit" class="btn btn--accent" [disabled]="addingIndexed()">
            {{ addingIndexed() ? 'Adding…' : 'Add' }}
          </button>
          <button type="button" class="btn btn-ghost" (click)="showAddFolder.set(false)">Cancel</button>
        </form>
        <p class="hint index-add-hint">
          One folder at a time. For a whole projects folder, run
          <code>huddle indexfolder</code> on the host — it scans and adds everything below it.
        </p>
      }

      @if (indexedFolders().length === 0) {
        <p class="hint">
          Nothing indexed yet. Run <code>huddle indexfolder</code> on the host in the folder that
          holds your projects, or add a single folder by hand.
        </p>
      } @else {
        <div class="index-toolbar">
          <div class="index-search">
            <app-icon name="search" [size]="15" />
            <input type="text" [value]="indexQuery()" placeholder="Search indexed folders…"
                   autocomplete="off" spellcheck="false" (input)="indexQuery.set($any($event.target).value)">
          </div>
          <nav class="index-crumbs" aria-label="Location">
            <button type="button" class="index-crumb" title="All indexed roots" (click)="indexCwd.set('')">
              <app-icon name="home" [size]="15" />
            </button>
            @for (crumb of indexCrumbs(); track crumb.path) {
              <span class="index-sep">›</span>
              <button type="button" class="index-crumb" (click)="indexCwd.set(crumb.path)">{{ crumb.name }}</button>
            }
          </nav>
        </div>

        <table class="index-table">
          <thead>
            <tr>
              <th class="index-check">
                <input type="checkbox" [checked]="allVisibleSelected()" (change)="toggleAllVisible()"
                       title="Select everything shown">
              </th>
              <th>Folder</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            @for (row of indexRows(); track row.node.path) {
              <tr [class.sel]="isRowSelected(row.node)">
                <td class="index-check">
                  <input type="checkbox" [checked]="isRowSelected(row.node)"
                         (change)="toggleRowSelected(row.node)"
                         [title]="row.node.children.length ? 'Select this folder and everything below it' : 'Select this folder'">
                </td>
                <td>
                  <span class="index-cell" [style.padding-left.px]="row.depth * 18"
                        [style.background-size]="row.depth * 18 + 'px 100%'">
                    @if (row.node.children.length) {
                      <button type="button" class="index-twist" (click)="toggleIndexNode(row.node)"
                              [title]="row.open ? 'Collapse' : 'Expand'">
                        <app-icon [name]="row.open ? 'chevron-down' : 'chevron-right'" [size]="14" />
                      </button>
                    } @else {
                      <span class="index-twist"></span>
                    }
                    <span class="index-icon folder-img" aria-hidden="true"></span>
                    <button type="button" class="index-name" [class.dim]="!row.node.indexed"
                            [disabled]="!row.node.children.length" (click)="indexCwd.set(row.node.path)"
                            [title]="row.node.children.length ? 'Open ' + row.node.path : row.node.path">
                      {{ row.node.name }}
                    </button>
                    @if (!row.node.indexed) {
                      <span class="index-tag" title="Not indexed itself — shown because a folder below it is">parent</span>
                    } @else if (sourceOf(row.node) === 'manual') {
                      <span class="index-tag">by hand</span>
                    }
                  </span>
                </td>
                <td class="index-path">{{ pretty(row.node.path) }}</td>
              </tr>
            } @empty {
              <tr><td colspan="3" class="index-none">No folder matches “{{ indexQuery() }}”.</td></tr>
            }
          </tbody>
        </table>

        @if (selectedCount() > 0) {
          <div class="index-bar">
            <span>{{ selectedCount() }} folder(s) selected</span>
            <span class="index-bar-actions">
              <button type="button" class="btn btn-ghost" (click)="clearSelection()">Cancel</button>
              <button type="button" class="btn btn-delete" [disabled]="removingIndexed()"
                      (click)="removeSelected()">
                <app-icon name="trash" [size]="14" />
                {{ removingIndexed() ? 'Removing…' : 'Remove from index' }}
              </button>
            </span>
          </div>
        }
        @if (indexNote()) { <span class="saved-note">{{ indexNote() }}</span> }

        <details class="index-help">
          <summary>How do folders get in here?</summary>
          <p class="hint">
            Huddle runs in a container and cannot browse your host, so host paths had to be typed
            from memory. Index them once on the host and <b>Browse…</b> next to every host-path
            field opens them as a folder picker. Removing a folder here only shrinks the index —
            the folder itself and any mapping pointing at it stay untouched.
          </p>
          <pre class="cmd">huddle indexfolder            <span class="cmd-note"># this folder + 2 levels below it</span>
huddle indexfolder T:/projects --depth 3
huddle indexfolder --list     <span class="cmd-note"># what is indexed right now</span></pre>
        </details>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .page-header { margin-bottom: 16px; }
    .error-note { color: var(--danger, #e06c75); }
    h2 { margin: 0 0 8px; font-size: 1.1em; }
    .hint { color: var(--muted, #888); font-size: 0.9em; margin: 0 0 16px; }
    .field { margin-bottom: 16px; flex: 1; }
    .field-row { display: flex; gap: 16px; flex-wrap: wrap; }
    label { display: block; margin-bottom: 4px; font-size: 0.9em; color: var(--muted, #888); }
    input[type=text], input:not([type]) { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 0.95em; box-sizing: border-box; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 0.9em; cursor: pointer; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .saved-note { color: #4caf50; font-size: 0.9em; }
    .mappings-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.9em; }
    .mappings-table th { text-align: left; padding: 6px 8px; color: var(--muted); border-bottom: 1px solid var(--border); }
    .mappings-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
    .mappings-table tr.disabled-row td { opacity: 0.4; }
    .source-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: monospace; font-size: 0.85em; }
    .btn--sm { padding: 3px 8px; font-size: 0.8em; }
    .btn--danger { background: var(--danger, #e06c75); color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    .add-form { margin-top: 16px; }
    .add-form summary { cursor: pointer; color: var(--accent); font-size: 0.9em; padding: 4px 0; }
    .add-mapping-form { margin-top: 12px; }
    .cmd { background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 10px 12px; font-size: 0.85em; overflow-x: auto; margin: 0 0 16px; }
    /* Indexed folders — the file-manager style panel from the design. */
    .index-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
    .index-head .hint { margin-bottom: 12px; }
    .index-add-btn { display: inline-flex; align-items: center; gap: .35rem; flex: 0 0 auto; }
    .index-add { display: flex; gap: .5rem; align-items: center; margin-bottom: .25rem; }
    .index-add input { flex: 1; }
    .index-add-hint { margin-bottom: 12px; }

    .index-toolbar { display: flex; align-items: center; gap: .5rem; flex-wrap: wrap; margin-bottom: .75rem; }
    .index-search {
      flex: 1 1 14rem; min-width: 0; display: flex; align-items: center; gap: .45rem;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      padding: .3rem .6rem; color: var(--text-muted);
    }
    .index-search input { border: 0; outline: 0; background: none; padding: 0; font-size: .85em; }
    .index-crumbs {
      display: flex; align-items: center; gap: .25rem; overflow: auto;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm); padding: .28rem .55rem;
    }
    .index-crumb {
      border: 0; background: none; cursor: pointer; color: var(--text); font-size: .82em;
      padding: 0 .1rem; display: inline-flex; align-items: center; white-space: nowrap;
    }
    .index-crumb:hover { color: var(--accent); }
    .index-sep { color: var(--text-dim); font-size: .8em; }

    .index-table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
    .index-table th {
      text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--border);
      color: var(--table-head, var(--muted)); font-size: .72em; letter-spacing: .06em; text-transform: uppercase;
    }
    .index-table td { padding: 4px 8px; border-bottom: 1px solid var(--border); }
    .index-table tr.sel td { background: var(--accent-soft); }
    .index-check { width: 2rem; }
    .index-check input { width: auto; margin: 0; accent-color: var(--accent); }
    /* Indent guides, one per level, drawn across the padding of the cell. */
    .index-cell {
      display: inline-flex; align-items: center; gap: .4rem; background-size: 0 100%;
      background-repeat: no-repeat;
      background-image: repeating-linear-gradient(90deg, transparent 0 8px, var(--border) 8px 9px, transparent 9px 18px);
    }
    .index-twist {
      flex: 0 0 auto; width: 1.15rem; height: 1.15rem; border: 0; background: none; padding: 0;
      cursor: pointer; color: var(--text-muted); display: inline-flex; align-items: center; justify-content: center;
    }
    .index-icon { flex: 0 0 auto; width: 18px; height: 18px; display: inline-flex; }
    .index-name {
      border: 0; background: none; padding: 0; color: var(--text); font-size: 1em;
      font-weight: 600; cursor: pointer; text-align: left;
    }
    .index-name:disabled { cursor: default; font-weight: 500; }
    .index-name:not(:disabled):hover { color: var(--accent); }
    .index-name.dim { color: var(--text-muted); font-weight: 500; }
    .index-tag { font-size: .68em; color: var(--text-muted); border: 1px solid var(--border); border-radius: 999px; padding: 0 .4rem; }
    .index-path { color: var(--text-muted); font-size: .92em; }
    .index-none { color: var(--text-muted); padding: 12px 8px; }

    .index-bar {
      display: flex; align-items: center; justify-content: space-between; gap: 1rem;
      padding: .7rem .25rem; border-top: 1px solid var(--border); margin-top: -1px;
      font-size: .88em;
    }
    .index-bar-actions { display: flex; gap: .5rem; }
    .index-bar-actions .btn { display: inline-flex; align-items: center; gap: .35rem; }
    .index-help { margin-top: 1rem; }
    .index-help summary { cursor: pointer; color: var(--accent); font-size: 0.9em; padding: 4px 0; }
    .index-help .hint { margin: 8px 0; }
    .cmd-note { color: var(--muted, #888); }
    .tmd-input-row app-folder-select { flex: 1; min-width: 0; }

    /* Team-managed defaults (#69) */
    .card--new { border: 1px solid var(--accent); }
    .tmd-head { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    /* Glowing folder asset; it carries its own colour, so no theme swap needed. */
    .tmd-folder {
      flex: 0 0 auto; width: 42px; height: 32px;
      background: url("/assets/folder-orange.png") no-repeat center / contain;
    }
    .tmd-title { display: flex; align-items: center; gap: 10px; margin: 0; }
    .pill--new { background: var(--info-soft, #e6f0ff); color: var(--info, #2f6feb); font-size: 0.62em; font-weight: 700; letter-spacing: 0.04em; padding: 3px 7px; border-radius: 999px; text-transform: uppercase; }
    .tmd-cols { gap: 40px; }
    .tmd-cols .field { min-width: 260px; }
    .tmd-input-row { display: flex; gap: 10px; align-items: stretch; }
    .tmd-input-row input { flex: 1; }
    .btn-ghost { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 0.9em; }
    .btn-ghost:hover { background: var(--surface-hover); }
    .btn-ghost:disabled { opacity: 0.5; cursor: default; }
  `]
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  resources: HuddleSettings = { defaultMemory: '', defaultCpus: '', extensionsFolder: '', firewallRulesFolder: '' };
  mappings = signal<FolderMapping[]>([]);
  error = signal<string | null>(null);
  savingResources = signal(false);
  resourceNote = signal<string | null>(null);
  configMounted = signal<boolean | null>(null);
  addingMapping = signal(false);
  savingFolders = signal(false);
  folderNote = signal<string | null>(null);

  newMapping = { name: '', host_path: '', volume_name: '', container_path: '' };
  newMappingReadOnly = false;

  // The host folder index (`huddle indexfolder`). Lives in the DB, not in
  // config.json: it is a scan of THIS machine, not team-managed configuration.
  indexedFolders = signal<IndexedFolder[]>([]);
  // Same tree the picker dialog shows, so what you prune here is what disappears
  // there. Browsing state (which branch, which filter) is view-only; the DB only
  // ever sees the add and delete calls.
  indexExpanded = signal<ReadonlySet<string>>(new Set<string>());
  indexSelection = signal<ReadonlySet<string>>(new Set<string>());
  indexQuery = signal('');
  indexCwd = signal('');
  showAddFolder = signal(false);
  removingIndexed = signal(false);

  private indexTree = computed(() => buildFolderTree(this.indexedFolders().map((f) => f.path)));
  // Browsing into a folder shows that folder as the top row, so it stays
  // selectable — you came here to manage it, not only its children.
  private indexScope = computed(() => {
    const at = findNode(this.indexTree(), this.indexCwd());
    return at ? [at] : this.indexTree();
  });
  indexRows = computed(() => folderRows(this.indexScope(), this.indexExpanded(), this.indexQuery()));
  indexCrumbs = computed(() => breadcrumbs(this.indexCwd()));
  selectedCount = computed(() => this.indexSelection().size);
  allVisibleSelected = computed(() => {
    const rows = this.indexRows();
    const sel = this.indexSelection();
    return rows.length > 0 && rows.every((r) => sel.has(r.node.path.toLowerCase()));
  });
  private byPath = computed(
    () => new Map(this.indexedFolders().map((f) => [f.path.toLowerCase(), f] as const)),
  );
  newIndexedFolder = '';
  addingIndexed = signal(false);
  indexNote = signal<string | null>(null);

  ngOnInit(): void {
    this.api.getSettings().subscribe({
      next: (s) => { this.resources = { ...s }; this.configMounted.set(s.hostConfigMounted ?? null); },
      error: (e) => this.error.set(e.message),
    });
    this.loadMappings();
    this.loadIndexedFolders();
  }

  private loadIndexedFolders(): void {
    this.api.getIndexedFolders().subscribe({
      next: (r) => {
        this.indexedFolders.set(r.folders);
        // Roots open by default: a card that starts as a single collapsed 'T:'
        // line hides exactly the thing this panel is for.
        const open = new Set(this.indexExpanded());
        for (const root of this.indexTree()) open.add(root.path.toLowerCase());
        this.indexExpanded.set(open);
      },
      error: (e) => this.error.set(e.message),
    });
  }

  pretty(path: string): string {
    return prettyPath(path);
  }

  isRowSelected(node: FolderNode): boolean {
    return this.indexSelection().has(node.path.toLowerCase());
  }

  toggleRowSelected(node: FolderNode): void {
    const next = new Set(this.indexSelection());
    const key = node.path.toLowerCase();
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.indexSelection.set(next);
  }

  toggleAllVisible(): void {
    if (this.allVisibleSelected()) {
      this.clearSelection();
      return;
    }
    this.indexSelection.set(new Set(this.indexRows().map((r) => r.node.path.toLowerCase())));
  }

  clearSelection(): void {
    this.indexSelection.set(new Set());
  }

  // Every selected path is pruned with its subtree, so ticking a parent does what
  // it looks like it does. Paths are sent as typed in the tree; the gateway
  // normalizes them again before matching.
  removeSelected(): void {
    // Walk the whole tree, not the visible rows: collapsing a branch or typing
    // in the search box after selecting must not quietly spare those folders.
    const selection = this.indexSelection();
    const selected = flattenNodes(this.indexTree())
      .map((n) => n.path)
      .filter((p) => selection.has(p.toLowerCase()));
    // Removing a folder takes its subtree with it, so a child of another
    // selected folder is already covered — sending it too would report it twice.
    const paths = selected.filter(
      (p) => !selected.some((other) => other !== p && p.toLowerCase().startsWith(this.subtreePrefix(other)))
    );
    if (!paths.length) return;
    this.indexNote.set(null);
    this.error.set(null);
    this.removingIndexed.set(true);
    forkJoin(paths.map((p) => this.api.clearIndexedFolders(p))).subscribe({
      next: (results) => {
        this.removingIndexed.set(false);
        const removed = results.reduce((n, r) => n + r.removed, 0);
        this.indexNote.set(`Removed ${removed} folder(s) from the index`);
        this.clearSelection();
        this.loadIndexedFolders();
      },
      error: (e) => { this.removingIndexed.set(false); this.error.set(e.message); },
    });
  }

  /** 'T:/projects' -> 't:/projects/', and 'T:/' -> 't:/' — roots already end in one. */
  private subtreePrefix(path: string): string {
    const p = path.toLowerCase();
    return p.endsWith('/') ? p : `${p}/`;
  }

  toggleIndexNode(node: FolderNode): void {
    const next = new Set(this.indexExpanded());
    const key = node.path.toLowerCase();
    if (next.has(key)) next.delete(key);
    else next.add(key);
    this.indexExpanded.set(next);
  }

  sourceOf(node: FolderNode): string {
    return this.byPath().get(node.path.toLowerCase())?.source ?? '';
  }

  // The gateway normalizes and validates the path (host-path.ts), so a Windows
  // path with backslashes is accepted here and stored in one canonical form.
  addIndexedFolder(): void {
    const path = this.newIndexedFolder.trim();
    if (!path) return;
    this.addingIndexed.set(true);
    this.indexNote.set(null);
    this.error.set(null);
    this.api.addIndexedFolder(path).subscribe({
      next: (r) => {
        this.addingIndexed.set(false);
        if (r.invalid.length) {
          this.error.set(`Not added — ${r.invalid[0].error}: ${r.invalid[0].path}`);
          return;
        }
        this.newIndexedFolder = '';
        this.showAddFolder.set(false);
        this.indexNote.set(r.added ? 'Added' : 'Already indexed');
        this.loadIndexedFolders();
      },
      error: (e) => { this.addingIndexed.set(false); this.error.set(e.message); },
    });
  }

  private loadMappings(): void {
    this.api.getFolderMappings().subscribe({
      next: (m) => this.mappings.set(m),
      error: (e) => this.error.set(e.message),
    });
  }

  // The limits are written into the mounted ~/.huddle/config.json (#98), so a
  // failed write means the config is not mounted — say so instead of "Saved".
  saveResources(): void {
    this.savingResources.set(true);
    this.resourceNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      defaultMemory: this.resources.defaultMemory,
      defaultCpus: this.resources.defaultCpus,
    }).subscribe({
      next: (res) => {
        this.savingResources.set(false);
        if (res.persisted === false) {
          this.configMounted.set(false);
          this.error.set('Could not save — the CLI config is not mounted into Huddle. Run `huddle restart` on the host first.');
        } else {
          this.resourceNote.set('Saved');
        }
      },
      error: (e) => { this.savingResources.set(false); this.error.set(e.message); },
    });
  }

  // Save both folder paths. They are written into the mounted ~/.huddle/config.json
  // and only take effect once the CLI re-mounts them — so tell the operator to
  // restart. Used by the Extensions-folder Reload button too.
  saveFolders(): void {
    this.savingFolders.set(true);
    this.folderNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      extensionsFolder: this.resources.extensionsFolder,
      firewallRulesFolder: this.resources.firewallRulesFolder,
    }).subscribe({
      next: (res) => {
        this.savingFolders.set(false);
        if (res.persisted === false) {
          this.folderNote.set('Could not save — the CLI config is not mounted into Huddle. Run `huddle restart` on the host first.');
        } else {
          this.folderNote.set('Saved to config. Run `huddle restart` on the host to (re)mount the folder(s).');
        }
      },
      error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
    });
  }

  // Save the folder paths, then re-read whatever is currently mounted.
  reloadFirewallFolder(): void {
    this.savingFolders.set(true);
    this.folderNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      extensionsFolder: this.resources.extensionsFolder,
      firewallRulesFolder: this.resources.firewallRulesFolder,
    }).subscribe({
      next: () => {
        this.api.reloadFirewallRulesFolder().subscribe({
          next: (r) => {
            this.savingFolders.set(false);
            if (!r.mounted) {
              this.folderNote.set('Saved to config, but the folder is not mounted into Huddle yet — run `huddle restart` on the host, then Reload.');
            } else {
              const errs = r.errors.length ? `, ${r.errors.length} error(s)` : '';
              this.folderNote.set(`Loaded ${r.groups} group(s), ${r.imported} rule(s)${errs}`);
            }
          },
          error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
        });
      },
      error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
    });
  }

  toggleMapping(m: FolderMapping): void {
    this.api.updateFolderMapping(m.id, { enabled: m.enabled ? 0 : 1 }).subscribe({
      next: () => this.loadMappings(),
      error: (e) => this.error.set(e.message),
    });
  }

  deleteMapping(id: number): void {
    this.api.deleteFolderMapping(id).subscribe({
      next: () => this.loadMappings(),
      error: (e) => this.error.set(e.message),
    });
  }

  addMapping(): void {
    const { name, host_path, volume_name, container_path } = this.newMapping;
    if (!name || !container_path) return;
    this.addingMapping.set(true);
    this.api.createFolderMapping({
      name, host_path, volume_name, container_path,
      read_only: this.newMappingReadOnly ? 1 : 0,
      enabled: 1, sort_order: 0,
    }).subscribe({
      next: () => {
        this.addingMapping.set(false);
        this.newMapping = { name: '', host_path: '', volume_name: '', container_path: '' };
        this.newMappingReadOnly = false;
        this.loadMappings();
      },
      error: (e) => { this.addingMapping.set(false); this.error.set(e.message); },
    });
  }
}
