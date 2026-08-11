import { Component, inject, signal, computed, Input, OnInit, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { FirewallGroup } from '../../core/models/group.model';
import { Rule } from '../../core/models/rule.model';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { forkJoin, Observable } from 'rxjs';

type Bucket = number | 'all' | 'ungrouped';
type StatusFilter = 'all' | 'allow' | 'deny' | 'path';

// The firewall rules view (#69). One shared, scope-aware component used by the
// standalone Firewall page (container = null → all rules) and the
// container-detail view (container = <name> → that container + global). Every
// rule in scope, organised by group (All rules / each group / Ungrouped), with
// a rules/domains search and a status filter. The "Action" column is merged:
// an allow/deny rule shows its Allowed/Denied pill, a path-mode domain shows the
// path control (all/specific select + expandable allowed-paths editor) in its
// place. A "Container / Global" column shows each rule's scope. Allow↔deny and
// path-mode toggling are done via the bulk actions. Per-group import/export/apply.
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
              <h2>Firewall rules &amp; groups <span class="pill pill--new">NEW</span></h2>
              <p class="grp__sub">Every rule in scope, organised by group. Share across containers or teams.</p>
            </div>
          </div>
          <div class="grp__actions">
            <button type="button" class="btn btn-ghost" (click)="importInput.click()"><app-icon name="upload" [size]="15" /> Import</button>
            <button type="button" class="btn btn-ghost" (click)="exportSelected()"><app-icon name="download" [size]="15" /> Export</button>
            <button type="button" class="btn btn-ghost" [disabled]="syncing()" (click)="syncToFolder()"><app-icon name="refresh" [size]="15" /> {{ syncing() ? 'Syncing…' : 'Sync to folder' }}</button>
            <button type="button" class="btn btn-ghost" [class.on]="showAdd()" (click)="showAdd.set(!showAdd())"><app-icon name="plus" [size]="15" /> Add rule</button>
            <button type="button" class="btn btn--accent" (click)="startCreate()"><app-icon name="layers" [size]="15" /> New group</button>
            <input #importInput type="file" accept="application/json,.json" hidden (change)="onImportFile($event)" />
          </div>
        </div>

        @if (note()) { <div class="grp__note">{{ note() }}</div> }

        @if (showAdd()) {
          <form class="grp__add" (ngSubmit)="submitAdd()">
            <input class="grp__add-in" [(ngModel)]="newDomain" name="nd" placeholder="domain (e.g. *.pkgs.dev.azure.com)" autocomplete="off" />
            <input class="grp__add-in" [(ngModel)]="newPath" name="np" placeholder="path pattern (optional, e.g. /v3/*)" autocomplete="off" />
            @if (container === null) {
              <select [(ngModel)]="newScope" name="ns">
                <option value="">Global</option>
                @for (c of containers(); track c) { <option [value]="c">{{ shortName(c) }}</option> }
              </select>
            }
            <select [(ngModel)]="newAction" name="na">
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
            </select>
            <button type="submit" class="btn btn--accent btn--sm" [disabled]="!newDomain.trim() || adding()">Add</button>
          </form>
        }

        <div class="grp__body">
          <!-- Left: group buckets -->
          <aside class="grp__list">
            <button type="button" class="grp__item" [class.on]="selectedId() === 'all' && !creating()" (click)="selectBucket('all')">
              <span>All rules</span><i>{{ domainRules().length }}</i>
            </button>
            @for (g of groups(); track g.id) {
              <button type="button" class="grp__item" [class.on]="selectedId() === g.id" (click)="selectBucket(g.id)">
                <span>{{ g.name }}</span><i>{{ countFor(g.id) }}</i>
              </button>
            }
            <button type="button" class="grp__item grp__item--ungrouped" [class.on]="selectedId() === 'ungrouped'" (click)="selectBucket('ungrouped')">
              <span>Ungrouped</span><i>{{ ungroupedCount() }}</i>
            </button>
            @if (creating()) {
              <form class="grp__new" (ngSubmit)="createGroup()">
                <input [(ngModel)]="newName" name="newName" placeholder="Group name" autocomplete="off" />
                <div class="grp__new-actions">
                  <button type="submit" class="btn btn--accent btn--sm" [disabled]="!newName.trim()">Create</button>
                  <button type="button" class="btn btn-ghost btn--sm" (click)="cancelCreate()">Cancel</button>
                </div>
              </form>
            } @else {
              <button type="button" class="grp__additem" (click)="startCreate()"><app-icon name="plus" [size]="14" /> New group</button>
            }
          </aside>

          <!-- Right: detail -->
          <div class="grp__detail">
            <div class="grp__detail-head">
              <h3>
                {{ headTitle() }}
                @if (selectedGroup()?.shared) { <span class="pill pill--shared">Shared</span> }
                @if (selectedGroup()?.source === 'startup-folder') { <span class="pill pill--folder">From folder</span> }
              </h3>
              <p class="grp__desc">{{ headDesc() }}</p>
              <div class="grp__toolbar">
                <div class="grp__search">
                  <app-icon name="search" [size]="15" />
                  <input [ngModel]="query()" (ngModelChange)="query.set($event)" name="ruleSearch" placeholder="Search rules or domains…" autocomplete="off" />
                </div>
                <div class="seg">
                  <button type="button" [class.on]="statusFilter() === 'all'" (click)="statusFilter.set('all')">All <i>{{ domainRules().length }}</i></button>
                  <button type="button" [class.on]="statusFilter() === 'allow'" (click)="statusFilter.set('allow')">Allowed <i>{{ countAllow() }}</i></button>
                  <button type="button" [class.on]="statusFilter() === 'deny'" (click)="statusFilter.set('deny')">Denied <i>{{ countDeny() }}</i></button>
                  <button type="button" [class.on]="statusFilter() === 'path'" (click)="statusFilter.set('path')">Path mode <i>{{ countPath() }}</i></button>
                </div>
                @if (selectedGroup()) {
                  <div class="grp__apply">
                    <span>Apply to</span>
                    <select [(ngModel)]="applyScope" name="applyScope">
                      <option value="">Global</option>
                      @for (c of containers(); track c) { <option [value]="c">{{ shortName(c) }}</option> }
                    </select>
                    <button type="button" class="btn btn-ghost btn--sm" (click)="applySelected()">Apply</button>
                    <button type="button" class="btn btn-ghost btn--sm grp__del-group" (click)="deleteGroup()"><app-icon name="trash" [size]="13" /> Delete group</button>
                  </div>
                }
              </div>
            </div>

            @if (selectedCount() > 0) {
              <div class="grp__bulk">
                <span class="grp__bulk-n">{{ selectedCount() }} selected</span>
                <button type="button" class="btn btn-ghost btn--sm" (click)="bulkExport()"><app-icon name="download" [size]="14" /> Export</button>
                <div class="grp__bulk-menu">
                  <button type="button" class="btn btn-ghost btn--sm" [disabled]="!groups().length" (click)="bulkGroupMenu.set(!bulkGroupMenu())"><app-icon name="layers" [size]="14" /> Add to group</button>
                  @if (bulkGroupMenu()) {
                    <div class="grp__menu">
                      @for (g of groups(); track g.id) { <button type="button" (click)="bulkAssign(g.id)">{{ g.name }}</button> }
                    </div>
                  }
                </div>
                <button type="button" class="btn btn-ghost btn--sm" (click)="bulkPathMode()">Path mode</button>
                <button type="button" class="btn btn-ghost btn--sm" (click)="bulkFlip()">Flip allow/deny</button>
                <button type="button" class="btn btn-ghost btn--sm grp__bulk-del" (click)="bulkDelete()"><app-icon name="trash" [size]="14" /> Delete</button>
                <button type="button" class="btn btn-ghost btn--sm grp__bulk-clear" (click)="clearSelection()">Clear</button>
              </div>
            }

            <div class="grp__table-wrap" (scroll)="openMenu.set(null)">
            <table class="data-table grp__table">
              <thead>
                <tr>
                  <th class="grp__chk"><input type="checkbox" [checked]="allVisibleSelected()" (change)="toggleSelectAll()" title="Select all" /></th>
                  <th class="grp__col-dom">Domain / path</th>
                  <th class="grp__col-rule">Action</th>
                  <th class="grp__col-scope">Container / Global</th>
                  <th class="grp__col-grp">Group</th>
                  <th class="grp__col-menu"></th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.id) {
                  <tr [class.grp__tr--open]="expanded() === r.id" [class.grp__tr--sel]="isSelected(r.id)">
                    <td class="grp__chk"><input type="checkbox" [checked]="isSelected(r.id)" (change)="toggleSelect(r.id)" /></td>
                    <td class="grp__dom" [title]="r.domain">{{ r.domain }}</td>
                    <td class="grp__rule">
                      @if (isPath(r)) {
                        <select class="grp__pm-sel" [value]="'specific'" (change)="onPathMode(r, $event)">
                          <option value="all">All paths</option>
                          <option value="specific">Specific paths ({{ pathCount(r) }})</option>
                        </select>
                        <button type="button" class="grp__pm-toggle" (click)="toggleExpand(r.id)">
                          <app-icon [name]="expanded() === r.id ? 'chevron-down' : 'chevron-right'" [size]="14" />
                        </button>
                      } @else {
                        <span class="pill" [class.pill--allow]="r.status === 'allow'" [class.pill--deny]="r.status === 'deny'">{{ r.status === 'allow' ? 'Allowed' : 'Denied' }}</span>
                      }
                    </td>
                    <td class="grp__scope">
                      @if (r.container_id) { <span class="grp__stag" [title]="r.container_id">{{ shortName(r.container_id) }}</span> }
                      @else { <span class="grp__stag grp__stag--global">Global</span> }
                    </td>
                    <td>
                      @if (r.group_id != null) { <span class="grp__gtag">{{ groupName(r.group_id) }}</span> }
                      @else { <span class="grp__muted">—</span> }
                    </td>
                    <td class="grp__row-menu">
                      <button type="button" class="grp__dots" (click)="toggleMenu(r.id, $event)">⋯</button>
                      @if (openMenu() === r.id) {
                        <div class="grp__menu grp__menu--fixed" [style.top.px]="menuPos()?.top" [style.right.px]="menuPos()?.right">
                          @if (groups().length) {
                            <div class="grp__menu-label">Add to group</div>
                            @for (g of groups(); track g.id) { <button type="button" (click)="assign(r, g.id)">{{ g.name }}</button> }
                          }
                          @if (r.group_id != null) { <button type="button" (click)="removeFromGroup(r)">Remove from group</button> }
                          <button type="button" class="danger" (click)="deleteRule(r)">Delete rule</button>
                        </div>
                      }
                    </td>
                  </tr>
                  @if (isPath(r) && expanded() === r.id) {
                    <tr class="grp__paths-row">
                      <td colspan="6">
                        <div class="grp__paths">
                          <div class="grp__paths-head">Allowed paths</div>
                          @for (p of allowedPaths(r); track p.id) {
                            <div class="grp__path-row">
                              <span class="grp__path-val">{{ p.path_pattern }}</span>
                              <button type="button" class="grp__path-del" title="Remove path" (click)="deleteRule(p)"><app-icon name="trash" [size]="14" /></button>
                            </div>
                          } @empty {
                            <div class="grp__muted grp__path-empty">No allowed paths yet — the domain is blocked at the root.</div>
                          }
                          <form class="grp__path-add" (ngSubmit)="addPath(r)">
                            <input [(ngModel)]="newPathValue" name="npv" placeholder="/path/*" autocomplete="off" />
                            <button type="button" class="btn btn-ghost btn--sm" (click)="addPath(r)"><app-icon name="plus" [size]="13" /> Add path</button>
                          </form>
                        </div>
                      </td>
                    </tr>
                  }
                } @empty {
                  <tr><td colspan="6" class="grp__empty">No rules here yet.</td></tr>
                }
              </tbody>
            </table>
            </div>
            <div class="grp__foot"><span>{{ rows().length }} item{{ rows().length !== 1 ? 's' : '' }}</span></div>
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
    .grp__actions { margin-left: auto; display: flex; gap: 8px; flex-wrap: wrap; }
    .pill--new { background: var(--info-soft); color: var(--info); font-size: 0.6em; font-weight: 700; letter-spacing: .04em; padding: 3px 7px; border-radius: 999px; text-transform: uppercase; }
    .pill--shared { background: var(--accent-soft); color: var(--accent-strong); }
    .pill--folder { background: var(--info-soft); color: var(--info); }
    .grp__note { margin: 12px 0 0; font-size: 0.85em; color: var(--text-muted); }

    .grp__add { display: flex; gap: 8px; margin-top: 14px; flex-wrap: wrap; }
    .grp__add-in, .grp__add select { padding: 8px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); font-size: 0.88em; }
    .grp__add-in { flex: 1; min-width: 180px; }

    .grp__body { display: grid; grid-template-columns: 240px 1fr; gap: 20px; margin-top: 18px; }
    .grp__list { display: flex; flex-direction: column; gap: 4px; border-right: 1px solid var(--border); padding-right: 16px; }
    .grp__search { display: flex; align-items: center; gap: 8px; padding: 7px 10px; border: 1px solid var(--border); border-radius: 999px; color: var(--text-muted); min-width: 240px; }
    .grp__search input { border: none; background: transparent; outline: none; color: var(--text); width: 100%; font-size: 0.88em; }
    .grp__item { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 9px 12px; border: none; background: transparent; border-radius: var(--radius-sm); cursor: pointer; color: var(--text); font-size: 0.92em; text-align: left; }
    .grp__item:hover { background: var(--surface-hover); }
    .grp__item.on { background: var(--accent-soft); color: var(--accent-strong); font-weight: 600; }
    .grp__item i { font-style: normal; color: var(--text-dim); font-size: 0.85em; }
    .grp__item.on i { color: var(--accent-strong); }
    .grp__item--ungrouped { color: var(--text-muted); }
    .grp__additem { display: flex; align-items: center; gap: 6px; padding: 9px 12px; border: none; background: transparent; color: var(--text-muted); cursor: pointer; font-size: 0.88em; border-radius: var(--radius-sm); }
    .grp__additem:hover { color: var(--accent); }
    .grp__new { padding: 8px; display: flex; flex-direction: column; gap: 8px; }
    .grp__new input { padding: 7px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); }
    .grp__new-actions { display: flex; gap: 6px; }

    .grp__detail-head h3 { margin: 0 0 4px; display: flex; align-items: center; gap: 10px; }
    .grp__desc { margin: 0 0 12px; color: var(--text-muted); font-size: 0.88em; }
    .grp__toolbar { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; margin-bottom: 12px; }
    .seg { display: inline-flex; background: var(--surface-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px; }
    .seg button { border: none; background: transparent; color: var(--text-muted); padding: 6px 12px; border-radius: 999px; cursor: pointer; font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; }
    .seg button.on { background: var(--surface); color: var(--accent-strong); box-shadow: var(--shadow-card); }
    .seg button i { font-style: normal; font-size: 0.85em; color: var(--text-dim); }
    .seg button.on i { color: var(--accent-strong); }
    .grp__apply { display: flex; align-items: center; gap: 8px; font-size: 0.85em; color: var(--text-muted); margin-left: auto; }
    .grp__apply select { padding: 5px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); }
    .grp__del-group:hover { border-color: var(--danger); color: var(--danger); }

    .grp__bulk { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-bottom: 12px; padding: 8px 12px; background: var(--accent-soft); border: 1px solid var(--accent); border-radius: var(--radius-sm); }
    .grp__bulk-n { font-size: 0.85em; font-weight: 600; color: var(--accent-strong); margin-right: 4px; }
    .grp__bulk-menu { position: relative; }
    .grp__bulk-menu .grp__menu { left: 0; right: auto; }
    .grp__bulk-del:hover { border-color: var(--danger); color: var(--danger); }
    .grp__bulk-clear { margin-left: auto; }

    /* Fixed layout so column widths come from the header and never re-flow per
       row content — keeps rows aligned and stops them from jumping when the list
       or filter changes. The domain column takes the remaining space. */
    .grp__table-wrap { overflow-x: auto; }
    .grp__table { width: 100%; table-layout: fixed; }
    .grp__col-rule { width: 208px; }
    .grp__col-scope { width: 150px; }
    .grp__col-grp { width: 128px; }
    .grp__col-menu { width: 40px; }
    .grp__table th, .grp__table td { overflow: hidden; text-overflow: ellipsis; }
    .grp__chk { width: 34px; text-align: center; }
    .grp__chk input { cursor: pointer; }
    .grp__tr--sel > td { background: var(--accent-soft); }
    .grp__dom { font-family: 'Space Grotesk', monospace; white-space: nowrap; }
    .grp__rule { white-space: nowrap; }
    .grp__pm-sel { max-width: 168px; padding: 4px 8px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); color: var(--text); font-size: 0.82em; }
    .grp__pm-toggle { border: none; background: transparent; cursor: pointer; color: var(--text-muted); padding: 0 4px; vertical-align: middle; }
    .grp__scope { white-space: nowrap; }
    .grp__stag { font-size: 0.78em; padding: 3px 9px; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--border); color: var(--text-muted); font-family: 'Space Grotesk', monospace; }
    .grp__stag--global { background: var(--info-soft); border-color: transparent; color: var(--info); font-family: inherit; }
    .grp__gtag { font-size: 0.78em; padding: 3px 9px; border-radius: 999px; background: var(--accent-soft); color: var(--accent-strong); }
    .grp__muted { color: var(--text-muted); font-size: 0.85em; }
    .grp__empty { text-align: center; color: var(--text-muted); padding: 24px 0; }
    .grp__foot { margin-top: 12px; color: var(--text-dim); font-size: 0.82em; }

    .grp__tr--open > td { border-bottom: none; }
    .grp__paths-row > td { padding: 0 0 12px; }
    .grp__paths { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 12px 14px; margin: 4px 0 4px 40px; }
    .grp__paths-head { font-size: 0.72em; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); margin-bottom: 8px; }
    .grp__path-row { display: flex; align-items: center; gap: 10px; padding: 5px 0; border-bottom: 1px solid var(--border); }
    .grp__path-val { flex: 1; font-family: 'Space Grotesk', monospace; font-size: 0.9em; }
    .grp__path-del { border: none; background: transparent; color: var(--text-muted); cursor: pointer; }
    .grp__path-del:hover { color: var(--danger); }
    .grp__path-empty { padding: 6px 0; }
    .grp__path-add { display: flex; gap: 8px; margin-top: 10px; }
    .grp__path-add input { flex: 1; padding: 6px 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); color: var(--text); font-size: 0.85em; }

    /* No overflow override needed here: the menu is position:fixed (below), so it
       is never clipped by this cell's overflow:hidden. A plain '.grp__row-menu'
       overflow rule would lose to '.grp__table td' on specificity anyway. */
    .grp__row-menu { position: relative; text-align: right; }
    .grp__dots { border: none; background: transparent; cursor: pointer; color: var(--text-muted); font-size: 1.2em; padding: 0 6px; }
    .grp__menu { position: absolute; right: 0; top: 100%; z-index: 20; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); box-shadow: var(--shadow-pop); display: flex; flex-direction: column; min-width: 180px; max-height: 320px; overflow: auto; }
    /* Row menus render fixed to the viewport so the table's overflow-x scroll
       container can't clip them (overflow-x:auto forces overflow-y to auto too). */
    .grp__menu--fixed { position: fixed; z-index: 1000; }
    .grp__menu-label { padding: 8px 12px 4px; font-size: 0.72em; text-transform: uppercase; letter-spacing: .04em; color: var(--text-dim); }
    .grp__menu button { text-align: left; padding: 8px 12px; border: none; background: transparent; cursor: pointer; color: var(--text); font-size: 0.88em; }
    .grp__menu button:hover { background: var(--surface-hover); }
    .grp__menu button.danger { color: var(--danger); border-top: 1px solid var(--border); }

    .btn-ghost { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 7px 12px; cursor: pointer; font-size: 0.85em; display: inline-flex; align-items: center; gap: 6px; }
    .btn-ghost:hover { background: var(--surface-hover); }
    .btn-ghost.on { border-color: var(--accent); color: var(--accent-strong); }
    .btn-ghost:disabled { opacity: .5; cursor: default; }
    .btn--sm { padding: 5px 10px; font-size: 0.8em; }

    @media (max-width: 820px) { .grp__body { grid-template-columns: 1fr; } .grp__list { border-right: none; border-bottom: 1px solid var(--border); padding-right: 0; padding-bottom: 12px; } }
  `],
})
export class FirewallGroupsPanelComponent implements OnInit {
  private api = inject(ApiService);
  private state = inject(StateService);

  @Input() container: string | null = null;

  groups = signal<FirewallGroup[]>([]);
  allRules = signal<Rule[]>([]);
  selectedId = signal<Bucket>('all');
  statusFilter = signal<StatusFilter>('all');
  containers = signal<string[]>([]);
  note = signal<string | null>(null);
  creating = signal(false);
  showAdd = signal(false);
  adding = signal(false);
  syncing = signal(false);
  openMenu = signal<number | null>(null);
  menuPos = signal<{ top: number; right: number } | null>(null);
  expanded = signal<number | null>(null);

  // Bulk selection over the visible rows.
  selected = signal<Set<number>>(new Set());
  bulkGroupMenu = signal(false);

  query = signal('');
  newName = '';
  applyScope = '';
  newDomain = '';
  newPath = '';
  newScope = '';
  newAction: 'allow' | 'deny' = 'allow';
  newPathValue = '';

  private inScope(r: Rule): boolean {
    if (this.container == null) return true;
    return r.container_id === this.container || r.container_id == null;
  }
  isPath(r: Rule): boolean { return r.path_mode === 1; }

  scopedAll = computed(() => this.allRules().filter((r) => this.inScope(r)));

  // Table rows = domain-level allow/deny rules (path_pattern is null), which
  // includes path-mode markers. Individual path rules are nested under their
  // domain's expandable editor, not shown as top-level rows.
  domainRules = computed(() =>
    this.scopedAll().filter((r) => (r.status === 'allow' || r.status === 'deny') && !r.path_pattern),
  );

  allowedPaths(r: Rule): Rule[] {
    return this.scopedAll()
      .filter((d) => d.domain === r.domain && d.container_id === r.container_id && !!d.path_pattern && d.status === 'allow')
      .sort((a, b) => (a.path_pattern ?? '').localeCompare(b.path_pattern ?? ''));
  }
  pathCount(r: Rule): number { return this.allowedPaths(r).length; }

  selectedGroup = computed(() => {
    const id = this.selectedId();
    return typeof id === 'number' ? this.groups().find((g) => g.id === id) ?? null : null;
  });
  ungroupedCount = computed(() => this.domainRules().filter((r) => r.group_id == null).length);
  countAllow = computed(() => this.domainRules().filter((r) => r.status === 'allow' && !this.isPath(r)).length);
  countDeny = computed(() => this.domainRules().filter((r) => r.status === 'deny' && !this.isPath(r)).length);
  countPath = computed(() => this.domainRules().filter((r) => this.isPath(r)).length);

  rows = computed(() => {
    const id = this.selectedId();
    const sf = this.statusFilter();
    const q = this.query().trim().toLowerCase();
    let rs = this.domainRules();
    if (id === 'ungrouped') rs = rs.filter((r) => r.group_id == null);
    else if (typeof id === 'number') rs = rs.filter((r) => r.group_id === id);
    if (sf === 'allow') rs = rs.filter((r) => r.status === 'allow' && !this.isPath(r));
    else if (sf === 'deny') rs = rs.filter((r) => r.status === 'deny' && !this.isPath(r));
    else if (sf === 'path') rs = rs.filter((r) => this.isPath(r));
    if (q) rs = rs.filter((r) => r.domain.toLowerCase().includes(q));
    return [...rs].sort((a, b) => a.domain.localeCompare(b.domain));
  });

  // Selection is scoped to what is visible: acting only ever touches the rows the
  // operator can currently see (respecting bucket/status/search filters).
  selectedRows = computed(() => this.rows().filter((r) => this.selected().has(r.id)));
  selectedCount = computed(() => this.selectedRows().length);
  allVisibleSelected = computed(() => {
    const rs = this.rows();
    return rs.length > 0 && rs.every((r) => this.selected().has(r.id));
  });

  // Count rules per group ONCE per domainRules() change (a computed memoizes it),
  // so the template's per-group countFor() is an O(1) lookup instead of O(rules).
  private groupCounts = computed(() => {
    const counts = new Map<number, number>();
    for (const r of this.domainRules()) {
      if (r.group_id != null) counts.set(r.group_id, (counts.get(r.group_id) ?? 0) + 1);
    }
    return counts;
  });
  countFor(groupId: number): number { return this.groupCounts().get(groupId) ?? 0; }
  groupName(groupId: number): string { return this.groups().find((g) => g.id === groupId)?.name ?? '—'; }

  headTitle(): string {
    const id = this.selectedId();
    if (id === 'all') return 'All rules';
    if (id === 'ungrouped') return 'Ungrouped';
    return this.selectedGroup()?.name ?? '';
  }
  headDesc(): string {
    const id = this.selectedId();
    if (id === 'all') return this.container ? 'Every firewall rule for this container and global.' : 'Every firewall rule.';
    if (id === 'ungrouped') return 'Rules not assigned to any group.';
    return this.selectedGroup()?.description || 'No description.';
  }

  ngOnInit(): void {
    this.loadGroups();
    this.state.containers$.subscribe((cs) => this.containers.set(cs.map((c) => c.name)));
    this.state.rules$.subscribe((rs) => this.allRules.set(rs));
  }

  private loadGroups(): void {
    this.api.getGroups().subscribe({ next: (gs) => this.groups.set(gs), error: (e) => this.note.set(e.message) });
  }
  reloadAfterMutation(): void { this.state.loadAll(); this.loadGroups(); }

  selectBucket(id: Bucket): void { this.selectedId.set(id); this.creating.set(false); this.clearSelection(); }
  toggleExpand(id: number): void { this.expanded.set(this.expanded() === id ? null : id); }

  onPathMode(r: Rule, ev: Event): void {
    const want = (ev.target as HTMLSelectElement).value === 'specific';
    if (want === this.isPath(r)) return;
    this.api.setPathMode(r.id, want).subscribe({
      next: () => { if (want) this.expanded.set(r.id); this.reloadAfterMutation(); },
      error: (e) => this.note.set(e.message),
    });
  }

  addPath(r: Rule): void {
    const p = this.newPathValue.trim();
    if (!p) return;
    this.api.createRule(r.domain, r.container_id, 'allow', p).subscribe({
      next: () => { this.newPathValue = ''; this.reloadAfterMutation(); },
      error: (e) => this.note.set(e.message),
    });
  }

  submitAdd(): void {
    const domain = this.newDomain.trim();
    if (!domain || this.adding()) return;
    const path = this.newPath.trim() || null;
    const scope = this.container ?? (this.newScope || null);
    const action = this.newAction; // capture before the reset below resets it to 'allow'
    this.adding.set(true);
    this.api.createRule(domain, scope, action, path).subscribe({
      next: () => {
        this.adding.set(false); this.showAdd.set(false);
        this.newDomain = ''; this.newPath = ''; this.newScope = ''; this.newAction = 'allow';
        this.note.set(`Rule ${action}ed for ${scope ? this.shortName(scope) : 'global'}`);
        this.reloadAfterMutation();
      },
      error: (e) => { this.adding.set(false); this.note.set(e.message); },
    });
  }

  startCreate(): void { this.creating.set(true); this.newName = ''; }
  cancelCreate(): void { this.creating.set(false); this.newName = ''; }
  createGroup(): void {
    const name = this.newName.trim();
    if (!name) return;
    this.api.createGroup(name).subscribe({
      next: (g) => { this.creating.set(false); this.newName = ''; this.loadGroups(); this.selectBucket(g.id); },
      error: (e) => this.note.set(e.message),
    });
  }

  // Delete the selected group. Its rules are kept (they become ungrouped) — only
  // the grouping is removed, so an accidental delete never opens/closes traffic.
  deleteGroup(): void {
    const g = this.selectedGroup();
    if (!g) return;
    if (!confirm(`Delete group "${g.name}"? Its rules stay but become ungrouped.`)) return;
    this.api.deleteGroup(g.id).subscribe({
      next: () => { this.note.set(`Deleted group "${g.name}" (its rules are now ungrouped)`); this.selectBucket('all'); this.reloadAfterMutation(); },
      error: (e) => this.note.set(e.message),
    });
  }

  // Top-bar Export. With a group selected it exports that group (server envelope,
  // incl. path sub-paths). With no group ("All rules"/"Ungrouped") it exports the
  // current view — so exporting is never blocked just because nothing is grouped.
  exportSelected(): void {
    const g = this.selectedGroup();
    if (g) {
      this.api.exportGroup(g.id).subscribe({
        next: (doc) => {
          this.download(doc, `huddle-group-${g.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.json`);
          this.note.set(`Exported "${g.name}"`);
        },
        error: (e) => this.note.set(e.message),
      });
      return;
    }
    const rows = this.rows();
    if (!rows.length) { this.note.set('Nothing to export in this view.'); return; }
    const label = this.selectedId() === 'ungrouped' ? 'ungrouped' : 'all';
    this.download(this.rulesEnvelope(rows), `huddle-firewall-rules-${label}-${new Date().toISOString().slice(0, 10)}.json`);
    this.note.set(`Exported ${rows.length} rule(s)`);
  }

  // Write every group back out to the team-managed folder so the folder mirrors
  // what's in the portal (app → files). Synced groups become folder-managed.
  syncToFolder(): void {
    this.syncing.set(true);
    this.api.syncFirewallRulesFolder().subscribe({
      next: (r) => {
        this.syncing.set(false);
        if (!r.mounted) {
          this.note.set('No firewall rules folder mounted — set one in Settings and run `huddle restart`.');
          return;
        }
        if (r.written === 0 && r.errors.length > 0) {
          this.note.set('Could not write to the folder — it may still be mounted read-only. Run `huddle restart` to remount it writable.');
          return;
        }
        const parts = [`Synced ${r.written} group(s) to the folder`];
        if (r.pruned > 0) parts.push(`${r.pruned} stale file(s) removed`);
        if (r.errors.length > 0) parts.push(`${r.errors.length} error(s)`);
        this.note.set(parts.join(' · '));
        this.reloadAfterMutation();
      },
      error: (e) => { this.syncing.set(false); this.note.set('Sync failed: ' + e.message); },
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
        next: (res) => { this.note.set(`Imported "${res.group.name}": ${res.imported} added, ${res.updated} updated`); this.reloadAfterMutation(); this.selectBucket(res.group.id); },
        error: (e) => this.note.set('Import failed: ' + e.message),
      });
    };
    reader.readAsText(file);
  }

  applySelected(): void {
    const g = this.selectedGroup();
    if (!g) return;
    const container = this.applyScope || null;
    this.api.applyGroup(g.id, container).subscribe({
      next: (r) => { this.note.set(`Applied "${g.name}" to ${container ? this.shortName(container) : 'global'} (${r.applied} added, ${r.updated} updated)`); this.reloadAfterMutation(); },
      error: (e) => this.note.set(e.message),
    });
  }

  toggleMenu(id: number, ev: Event): void {
    ev.stopPropagation();
    if (this.openMenu() === id) { this.openMenu.set(null); return; }
    // Anchor the fixed menu to the button's bottom-right so it escapes the
    // table's overflow-x scroll container instead of being clipped by it.
    const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
    this.menuPos.set({ top: Math.round(rect.bottom + 4), right: Math.round(window.innerWidth - rect.right) });
    this.openMenu.set(id);
  }

  // A fixed-positioned menu would linger with a stale position, so dismiss it on
  // any outside click, scroll or resize.
  @HostListener('document:click') onDocClick(): void { if (this.openMenu() !== null) this.openMenu.set(null); }
  @HostListener('window:scroll') @HostListener('window:resize') onViewportChange(): void { this.openMenu.set(null); }

  assign(r: Rule, groupId: number): void {
    this.openMenu.set(null);
    this.api.assignRuleToGroup(groupId, r.id).subscribe({ next: () => this.reloadAfterMutation(), error: (e) => this.note.set(e.message) });
  }
  removeFromGroup(r: Rule): void {
    this.openMenu.set(null);
    if (r.group_id == null) return;
    this.api.removeRuleFromGroup(r.group_id, r.id).subscribe({ next: () => this.reloadAfterMutation(), error: (e) => this.note.set(e.message) });
  }
  deleteRule(r: Rule): void {
    this.openMenu.set(null);
    this.api.deleteRule(r.id).subscribe({ next: () => this.reloadAfterMutation(), error: (e) => this.note.set(e.message) });
  }

  // ── Bulk selection & actions ────────────────────────────────────────────────
  isSelected(id: number): boolean { return this.selected().has(id); }
  toggleSelect(id: number): void {
    const s = new Set(this.selected());
    s.has(id) ? s.delete(id) : s.add(id);
    this.selected.set(s);
  }
  toggleSelectAll(): void {
    const rs = this.rows();
    const s = new Set(this.selected());
    if (rs.every((r) => s.has(r.id))) rs.forEach((r) => s.delete(r.id));
    else rs.forEach((r) => s.add(r.id));
    this.selected.set(s);
  }
  clearSelection(): void { this.selected.set(new Set()); this.bulkGroupMenu.set(false); }

  // Run one API call per selected row in parallel, then refresh once.
  private bulkRun(calls: Observable<unknown>[], msg: string): void {
    if (!calls.length) return;
    forkJoin(calls).subscribe({
      next: () => { this.note.set(msg); this.clearSelection(); this.reloadAfterMutation(); },
      error: (e) => this.note.set(e.message),
    });
  }

  bulkDelete(): void {
    const rows = this.selectedRows();
    if (!rows.length || !confirm(`Delete ${rows.length} rule(s)?`)) return;
    this.bulkRun(rows.map((r) => this.api.deleteRule(r.id) as unknown as Observable<unknown>), `Deleted ${rows.length} rule(s)`);
  }
  bulkAssign(groupId: number): void {
    this.bulkGroupMenu.set(false);
    const rows = this.selectedRows();
    this.bulkRun(rows.map((r) => this.api.assignRuleToGroup(groupId, r.id)), `Added ${rows.length} rule(s) to "${this.groupName(groupId)}"`);
  }
  bulkPathMode(): void {
    const rows = this.selectedRows().filter((r) => !this.isPath(r));
    if (!rows.length) { this.note.set('No convertible rows selected (already path mode).'); return; }
    this.bulkRun(rows.map((r) => this.api.setPathMode(r.id, true)), `Enabled path mode on ${rows.length} domain(s)`);
  }
  bulkFlip(): void {
    const rows = this.selectedRows().filter((r) => !this.isPath(r));
    if (!rows.length) { this.note.set('No allow/deny rows selected to flip.'); return; }
    this.bulkRun(
      // Preserve each rule's existing expiry — omitting it makes the backend
      // default expires_at to null, which would silently turn a temporary rule
      // into a permanent one when flipped.
      rows.map((r) => this.api.updateRule(r.id, r.status === 'allow' ? 'deny' : 'allow', r.expires_at ?? undefined)),
      `Flipped ${rows.length} rule(s)`,
    );
  }

  // Export the selected rows as the same JSON envelope the flat export uses. For a
  // selected path-mode domain we also include its allowed sub-paths, so the export
  // is self-contained (otherwise the domain would import back blocked-at-root).
  bulkExport(): void {
    const rows = this.selectedRows();
    if (!rows.length) return;
    const doc = this.rulesEnvelope(rows);
    this.download(doc, `huddle-firewall-rules-${new Date().toISOString().slice(0, 10)}.json`);
    this.note.set(`Exported ${doc.rules.length} rule(s)`);
  }

  // Build the flat rules envelope from a set of domain rows. For a path-mode
  // domain its allowed sub-paths are pulled in too, so the export is
  // self-contained (otherwise the domain re-imports blocked at the root).
  private rulesEnvelope(rows: Rule[]): { version: number; exported_at: number; rules: unknown[] } {
    const byId = new Map<number, Rule>();
    for (const r of rows) {
      byId.set(r.id, r);
      if (this.isPath(r)) for (const p of this.allowedPaths(r)) byId.set(p.id, p);
    }
    const rules = [...byId.values()].map((r) => ({
      domain: r.domain,
      container_id: r.container_id,
      status: r.status,
      path_pattern: r.path_pattern ?? null,
      path_mode: r.path_mode ?? 0,
      expires_at: r.expires_at ?? null,
    }));
    return { version: 1, exported_at: Math.floor(Date.now() / 1000), rules };
  }

  private download(doc: unknown, filename: string): void {
    const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  shortName(id: string): string { return id.replace(/^devcontainer-/, ''); }
}
