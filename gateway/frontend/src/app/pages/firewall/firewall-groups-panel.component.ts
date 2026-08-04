import { Component, inject, signal, computed, OnInit } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { FirewallGroup } from '../../core/models/group.model';
import { Rule } from '../../core/models/rule.model';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';

// Firewall groups panel (#69) — the "Groups" card on the Firewall page. Left:
// searchable group list with counts. Right: the selected group's rules in a
// table (type / domain-path / match / actions / added / added-by / menu), with
// Import / Export / New group and per-group apply-to-scope.
@Component({
  selector: 'app-firewall-groups-panel',
  standalone: true,
  imports: [FormsModule, IconComponent, RelTimePipe],
  template: `
    <section class="fw-sec">
      <div class="card grp">
        <div class="grp__head">
          <div class="grp__title">
            <span class="grp__icon"><app-icon name="layers" [size]="20" /></span>
            <div>
              <h2>Groups <span class="pill pill--new">NEW</span></h2>
              <p class="grp__sub">Group domains and rules with tags. Share across containers or teams.</p>
            </div>
          </div>
          <div class="grp__actions">
            <button type="button" class="btn btn-ghost" (click)="importInput.click()">
              <app-icon name="upload" [size]="15" /> Import
            </button>
            <button type="button" class="btn btn-ghost" [disabled]="!selected()" (click)="exportSelected()">
              <app-icon name="download" [size]="15" /> Export
            </button>
            <button type="button" class="btn btn--accent" (click)="startCreate()">
              <app-icon name="plus" [size]="15" /> New group
            </button>
            <input #importInput type="file" accept="application/json,.json" hidden (change)="onImportFile($event)" />
          </div>
        </div>

        @if (note()) { <div class="grp__note">{{ note() }}</div> }

        <div class="grp__body">
          <!-- Left: group list -->
          <aside class="grp__list">
            <div class="grp__search">
              <app-icon name="search" [size]="15" />
              <input [(ngModel)]="query" name="grpSearch" placeholder="Search groups…" autocomplete="off" />
            </div>
            <button type="button" class="grp__item" [class.on]="selectedId() === null && !creating()"
                    (click)="selectAll()">
              <span>All groups</span><i>{{ groups().length }}</i>
            </button>
            @for (g of filteredGroups(); track g.id) {
              <button type="button" class="grp__item" [class.on]="selectedId() === g.id"
                      (click)="select(g.id)">
                <span>{{ g.name }}</span><i>{{ g.rule_count }}</i>
              </button>
            }
            @if (creating()) {
              <form class="grp__new" (ngSubmit)="createGroup()">
                <input [(ngModel)]="newName" name="newName" placeholder="Group name" autocomplete="off" />
                <div class="grp__new-actions">
                  <button type="submit" class="btn btn--accent btn--sm" [disabled]="!newName.trim()">Create</button>
                  <button type="button" class="btn btn-ghost btn--sm" (click)="cancelCreate()">Cancel</button>
                </div>
              </form>
            } @else {
              <button type="button" class="grp__additem" (click)="startCreate()">
                <app-icon name="plus" [size]="14" /> New group
              </button>
            }
          </aside>

          <!-- Right: detail -->
          <div class="grp__detail">
            <div class="grp__detail-head">
              <h3>
                {{ selected() ? selected()!.name : 'All groups' }}
                @if (selected()?.shared) { <span class="pill pill--shared">Shared</span> }
                @if (selected()?.source === 'startup-folder') { <span class="pill pill--folder">From folder</span> }
              </h3>
              @if (selected()) {
                <p class="grp__desc">{{ selected()!.description || 'No description.' }}</p>
              } @else {
                <p class="grp__desc">Every rule assigned to a group, across all groups.</p>
              }
              @if (selected()) {
                <div class="grp__apply">
                  <span>Apply to</span>
                  <select [(ngModel)]="applyScope" name="applyScope">
                    <option value="">Global</option>
                    @for (c of containers(); track c) { <option [value]="c">{{ shortName(c) }}</option> }
                  </select>
                  <button type="button" class="btn btn-ghost btn--sm" (click)="applySelected()">Apply</button>
                </div>
              }
            </div>

            <table class="data-table grp__table">
              <thead>
                <tr>
                  <th>Type</th><th>Domain / path</th><th>Match</th><th>Actions</th>
                  <th>Added</th><th>Added by</th><th></th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr>
                    <td class="grp__type">
                      <app-icon [name]="r.path_pattern ? 'file-text' : 'globe'" [size]="16" />
                    </td>
                    <td class="grp__dom">{{ r.domain }}<span class="grp__path">{{ r.path_pattern }}</span></td>
                    <td>{{ r.path_pattern ? 'Path pattern' : 'Root' }}</td>
                    <td class="grp__act">
                      <span class="tag tag--match">{{ matchLabel(r) }}</span>
                      <span class="tag tag--dur">{{ durationLabel(r) }}</span>
                      <span class="pill" [class.pill--allow]="r.status === 'allow'" [class.pill--deny]="r.status === 'deny'"
                            [class.pill--pending]="r.status === 'requested'">{{ statusLabel(r) }}</span>
                    </td>
                    <td class="grp__muted">{{ r.updated_at | relTime }}</td>
                    <td class="grp__muted">{{ r.added_by || 'you' }}</td>
                    <td class="grp__row-menu">
                      <button type="button" class="grp__dots" (click)="toggleMenu(r.id)">⋯</button>
                      @if (openMenu() === r.id) {
                        <div class="grp__menu">
                          <button type="button" (click)="removeFromGroup(r)">Remove from group</button>
                          <button type="button" class="danger" (click)="deleteRule(r)">Delete rule</button>
                        </div>
                      }
                    </td>
                  </tr>
                } @empty {
                  <tr><td colspan="7" class="grp__empty">No rules in this group yet.</td></tr>
                }
              </tbody>
            </table>

            <div class="grp__foot">
              <span>{{ rows().length }} item{{ rows().length !== 1 ? 's' : '' }}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  `,
  styles: [`
    .grp__head { display: flex; align-items: flex-start; gap: 16px; }
    .grp__title { display: flex; gap: 12px; align-items: flex-start; }
    .grp__icon { color: var(--accent); display: inline-flex; margin-top: 2px; }
    .grp__title h2 { margin: 0; display: flex; align-items: center; gap: 8px; }
    .grp__sub { margin: 2px 0 0; color: var(--text-muted); font-size: 0.85em; }
    .grp__actions { margin-left: auto; display: flex; gap: 8px; }
    .pill--new { background: var(--info-soft); color: var(--info); font-size: 0.6em; font-weight: 700; letter-spacing: .04em; padding: 3px 7px; border-radius: 999px; text-transform: uppercase; }
    .pill--shared { background: var(--accent-soft); color: var(--accent-strong); }
    .pill--folder { background: var(--info-soft); color: var(--info); }
    .grp__note { margin: 12px 0 0; font-size: 0.85em; color: var(--text-muted); }

    .grp__body { display: grid; grid-template-columns: 240px 1fr; gap: 20px; margin-top: 18px; }
    .grp__list { display: flex; flex-direction: column; gap: 4px; border-right: 1px solid var(--border); padding-right: 16px; }
    .grp__search { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); color: var(--text-muted); margin-bottom: 8px; }
    .grp__search input { border: none; background: transparent; outline: none; color: var(--text); width: 100%; font-size: 0.9em; }
    .grp__item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--text); font-size: 0.92em; text-align: left; }
    .grp__item:hover { background: var(--surface-hover); }
    .grp__item.on { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
    .grp__item i { font-style: normal; color: var(--text-dim); font-size: 0.85em; }
    .grp__item.on i { color: var(--accent-strong); }
    .grp__additem { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 0.88em; border-radius: var(--radius-sm); }
    .grp__additem:hover { color: var(--accent); }
    .grp__new { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .grp__new input { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); }
    .grp__new-actions { display: flex; gap: 6px; }

    .grp__detail-head h3 { margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
    .grp__desc { margin: 0 0 12px; color: var(--text-muted); font-size: 0.88em; }
    .grp__apply { display: flex; align-items: center; gap: 8px; font-size: 0.85em; color: var(--text-muted); margin-bottom: 12px; }
    .grp__apply select { padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); }

    .grp__table { width: 100%; }
    .grp__type { color: var(--text-muted); }
    .grp__dom { font-family: 'Space Grotesk', monospace; }
    .grp__path { color: var(--accent-strong); }
    .grp__act { display: flex; align-items: center; gap: 6px; }
    .tag { font-size: 0.75em; padding: 3px 8px; border-radius: 7px; border: 1px solid var(--border); color: var(--text-muted); background: var(--surface-2); white-space: nowrap; }
    .tag--match { color: var(--text); }
    .grp__muted { color: var(--text-muted); font-size: 0.85em; }
    .grp__empty { text-align: center; color: var(--text-muted); padding: 24px 0; }
    .grp__foot { margin-top: 12px; color: var(--text-dim); font-size: 0.82em; }

    .grp__row-menu { position: relative; text-align: right; }
    .grp__dots { border: none; background: transparent; cursor: pointer; color: var(--text-muted); font-size: 1.2em; padding: 0 6px; }
    .grp__menu { position: absolute; right: 0; top: 100%; z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; min-width: 160px; }
    .grp__menu button { text-align: left; padding: 9px 12px; border: none; background: transparent; cursor: pointer; color: var(--text); font-size: 0.88em; }
    .grp__menu button:hover { background: var(--surface-hover); }
    .grp__menu button.danger { color: var(--danger); }

    .btn-ghost { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; }
    .btn-ghost:hover { background: var(--surface-hover); }
    .btn-ghost:disabled { opacity: .5; cursor: default; }
    .btn--sm { padding: 5px 10px; font-size: 0.8em; }

    @media (max-width: 820px) { .grp__body { grid-template-columns: 1fr; } .grp__list { border-right: none; border-bottom: 1px solid var(--border); padding-right: 0; padding-bottom: 12px; } }
  `],
})
export class FirewallGroupsPanelComponent implements OnInit {
  private api = inject(ApiService);
  private state = inject(StateService);

  groups = signal<FirewallGroup[]>([]);
  selectedId = signal<number | null>(null);
  detailRules = signal<Rule[]>([]);
  allGroupedRules = signal<Rule[]>([]);
  containers = signal<string[]>([]);
  note = signal<string | null>(null);
  creating = signal(false);
  openMenu = signal<number | null>(null);

  query = '';
  newName = '';
  applyScope = '';

  selected = computed(() => this.groups().find((g) => g.id === this.selectedId()) ?? null);
  filteredGroups = computed(() => {
    const q = this.query.trim().toLowerCase();
    return q ? this.groups().filter((g) => g.name.toLowerCase().includes(q)) : this.groups();
  });
  rows = computed(() => (this.selectedId() === null ? this.allGroupedRules() : this.detailRules()));

  ngOnInit(): void {
    this.loadGroups();
    this.state.containers$.subscribe((cs) => this.containers.set(cs.map((c) => c.name)));
  }

  private loadGroups(): void {
    this.api.getGroups().subscribe({
      next: (gs) => {
        this.groups.set(gs);
        if (this.selectedId() === null) this.loadAllGrouped();
        else this.select(this.selectedId()!);
      },
      error: (e) => this.note.set(e.message),
    });
  }

  private loadAllGrouped(): void {
    // "All groups" = every rule that belongs to some group.
    this.api.getRules({}).subscribe({
      next: (rs) => this.allGroupedRules.set(rs.filter((r) => r.group_id != null)),
      error: (e) => this.note.set(e.message),
    });
  }

  selectAll(): void { this.selectedId.set(null); this.creating.set(false); this.loadAllGrouped(); }

  select(id: number): void {
    this.selectedId.set(id);
    this.creating.set(false);
    this.api.getGroup(id).subscribe({
      next: (d) => this.detailRules.set(d.rules),
      error: (e) => this.note.set(e.message),
    });
  }

  startCreate(): void { this.creating.set(true); this.newName = ''; }
  cancelCreate(): void { this.creating.set(false); this.newName = ''; }

  createGroup(): void {
    const name = this.newName.trim();
    if (!name) return;
    this.api.createGroup(name).subscribe({
      next: (g) => { this.creating.set(false); this.newName = ''; this.loadGroups(); this.select(g.id); },
      error: (e) => this.note.set(e.message),
    });
  }

  exportSelected(): void {
    const g = this.selected();
    if (!g) return;
    this.api.exportGroup(g.id).subscribe({
      next: (doc) => {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `huddle-group-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.note.set(`Exported "${g.name}"`);
      },
      error: (e) => this.note.set(e.message),
    });
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let doc: unknown;
      try { doc = JSON.parse(String(reader.result)); }
      catch { this.note.set('Import failed: not valid JSON'); return; }
      this.api.importGroup(doc, 'merge').subscribe({
        next: (res) => {
          this.note.set(`Imported "${res.group.name}": ${res.imported} added, ${res.updated} updated`);
          this.loadGroups();
          this.select(res.group.id);
        },
        error: (e) => this.note.set('Import failed: ' + e.message),
      });
    };
    reader.readAsText(file);
  }

  applySelected(): void {
    const g = this.selected();
    if (!g) return;
    const container = this.applyScope || null;
    this.api.applyGroup(g.id, container).subscribe({
      next: (r) => {
        this.note.set(`Applied "${g.name}" to ${container ? this.shortName(container) : 'global'} (${r.applied} added, ${r.updated} updated)`);
        this.state.loadAll();
      },
      error: (e) => this.note.set(e.message),
    });
  }

  toggleMenu(id: number): void { this.openMenu.set(this.openMenu() === id ? null : id); }

  removeFromGroup(r: Rule): void {
    this.openMenu.set(null);
    const gid = this.selectedId() ?? r.group_id;
    if (gid == null) return;
    this.api.removeRuleFromGroup(gid, r.id).subscribe({
      next: () => this.reloadAfterMutation(),
      error: (e) => this.note.set(e.message),
    });
  }

  deleteRule(r: Rule): void {
    this.openMenu.set(null);
    this.api.deleteRule(r.id).subscribe({ next: () => this.reloadAfterMutation(), error: (e) => this.note.set(e.message) });
  }

  private reloadAfterMutation(): void {
    this.state.loadAll();
    this.loadGroups();
  }

  matchLabel(r: Rule): string {
    if (r.status === 'deny') return r.path_pattern ? 'Deny exact' : 'Deny /*';
    return r.path_pattern ? 'Allow exact' : 'Allow /*';
  }
  durationLabel(r: Rule): string {
    return r.expires_at ? 'Temporary' : 'Always';
  }
  statusLabel(r: Rule): string {
    return r.status === 'allow' ? 'Allowed' : r.status === 'deny' ? 'Denied' : 'Pending';
  }
  shortName(id: string): string { return id.replace(/^devcontainer-/, ''); }
}
