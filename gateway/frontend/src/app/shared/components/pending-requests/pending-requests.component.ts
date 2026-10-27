import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { forkJoin, Observable } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { ModalService } from '../../../core/services/modal.service';
import { Rule } from '../../../core/models/rule.model';
import { RelTimePipe } from '../../pipes/rel-time.pipe';
import { IconComponent } from '../icon/icon.component';
import { PieMenuComponent } from '../pie-menu/pie-menu.component';
import { PieMenuConfig } from '../pie-menu/pie-menu.model';
import { buildPathDomains, confirmGlobalPaths, excludePathModeRules } from '../path-allowlist/path-allowlist.util';

/** A path sub-request row for the pending inbox flat list */
export interface PathRequestRow {
  rule: Rule;
  domain: string;
  path_pattern: string;
  last_path: string | null;
}

/** Pending domain requests of one scope, newest first; path-mode domains go to buildPathRequests. */
export function buildDomainRequests(scopeRules: Rule[]): Rule[] {
  return excludePathModeRules(scopeRules).filter(r => r.status === 'requested').sort((a, b) => b.last_seen - a.last_seen);
}

/** Pending path sub-requests across a scope's path-mode domains (its own and the
 *  global markers), flattened for the inbox — mirrors the firewall view's list. */
export function buildPathRequests(scopeRules: Rule[], globalRules: Rule[]): PathRequestRow[] {
  const domains = [...buildPathDomains(scopeRules), ...buildPathDomains(globalRules)];
  return domains.flatMap(pd =>
    pd.requested
      .filter(r => !!r.path_pattern)
      .map(r => ({
        rule: r,
        domain: pd.domain,
        path_pattern: r.path_pattern!,
        last_path: (r as any).last_path ?? null,
      })),
  ).sort((a, b) => b.rule.last_seen - a.rule.last_seen);
}

/** Pie for domain requests: one row and the bulk selection use the same actions. */
export const DOMAIN_PIE: PieMenuConfig = {
  families: [
    {
      id: 'approve', label: 'Allow', tone: 'green', icon: 'approve',
      variants: [{ id: 'approve-all', label: 'For everyone', icon: 'approve-all' }],
    },
    {
      id: 'temp', label: 'Temporary 5 min', tone: 'blue', icon: 'timer',
      variants: [
        { id: 'temp-10', label: 'Temporary 10 min', icon: 'timer-long' },
        { id: 'later',   label: 'Hide',              icon: 'later'      },
      ],
    },
    {
      id: 'deny', label: 'Deny', tone: 'red', icon: 'deny',
      variants: [{ id: 'deny-all', label: 'For everyone', icon: 'deny-all' }],
    },
    { id: 'pathmode', label: 'Path allowlist', tone: 'neutral', icon: 'filter' },
  ],
};

/** Pie for path sub-requests — same layout as the firewall inbox:
 *  path-related actions on the left (0=top,1=right,2=bottom,3=left). */
export const PATH_PIE: PieMenuConfig = {
  families: [
    { id: 'path-allow', label: 'Allow exact', tone: 'green', icon: 'approve' },
    { id: 'path-later', label: 'Dismiss', tone: 'neutral', icon: 'later' },
    { id: 'path-deny', label: 'Deny', tone: 'red', icon: 'deny' },
    { id: 'path-prefix', label: 'Allow prefix/*', tone: 'blue', icon: 'filter' },
  ],
};

/** `/a/b/c` → `/a/b/*` */
export function toPathPrefix(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  return parts.slice(0, -1).join('/') + '/*';
}

// The pending requests of one container or sandbox (domain and path requests),
// with per-row and bulk pie actions. Shared by the devcontainer and sandbox
// detail pages so both offer the same actions. Emits `changed` after an action
// so the page can reload what it shows besides the shared state.
@Component({
  selector: 'app-pending-requests',
  standalone: true,
  imports: [RelTimePipe, IconComponent, PieMenuComponent],
  templateUrl: './pending-requests.component.html',
  styleUrl: './pending-requests.component.css',
})
export class PendingRequestsComponent {
  private api = inject(ApiService);
  private state = inject(StateService);
  private modal = inject(ModalService);

  @Input() requested: Rule[] = [];
  @Input() pathRequests: PathRequestRow[] = [];
  @Output() changed = new EventEmitter<void>();

  readonly pieConfig = DOMAIN_PIE;
  readonly pieConfigPath = PATH_PIE;

  private selected = new Set<number>();

  private domainCall(actionId: string, r: Rule): Observable<unknown> {
    const now = Math.floor(Date.now() / 1000);
    switch (actionId) {
      case 'approve-all': return this.api.resolveRule(r.id, 'allow', 'global');
      case 'temp':        return this.api.resolveRule(r.id, 'allow', 'rule', now + 5 * 60);
      case 'temp-10':     return this.api.resolveRule(r.id, 'allow', 'rule', now + 10 * 60);
      case 'later':       return this.api.deleteRule(r.id) as unknown as Observable<unknown>;
      case 'deny':        return this.api.resolveRule(r.id, 'deny', 'rule');
      case 'deny-all':    return this.api.resolveRule(r.id, 'deny', 'global');
      case 'pathmode':    return this.api.setPathMode(r.id, true);
      default:            return this.api.resolveRule(r.id, 'allow', 'rule');
    }
  }

  private pathCall(actionId: string, row: PathRequestRow): Observable<unknown> {
    switch (actionId) {
      case 'path-prefix': return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, toPathPrefix(row.path_pattern));
      case 'path-deny':   return this.api.resolveRule(row.rule.id, 'deny', 'rule', undefined, row.path_pattern);
      case 'path-later':  return this.api.deleteRule(row.rule.id) as unknown as Observable<unknown>;
      default:            return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, row.path_pattern);
    }
  }

  private done(ids: number[] = []): void {
    ids.forEach((i) => this.selected.delete(i));
    this.state.loadAll();
    this.changed.emit();
  }

  onPieAction(actionId: string, rule: Rule): void {
    // Global allow/deny changes policy for everyone: the shared confirm modal asks first.
    if (actionId === 'approve-all' || actionId === 'deny-all') {
      this.modal.openConfirm(rule, actionId === 'approve-all' ? 'allow' : 'deny');
      return;
    }
    this.domainCall(actionId, rule).subscribe(() => this.done());
  }

  onPathPieAction(actionId: string, row: PathRequestRow): void {
    if (!confirmGlobalPaths([row])) return;
    this.pathCall(actionId, row).subscribe(() => this.done());
  }

  onBulkPie(actionId: string): void {
    const rules = this.requested.filter((r) => this.selected.has(r.id));
    if (!rules.length) return;
    // Global allow/deny changes policy for ALL containers, beyond this one. Match
    // the confirmation the single-item global actions use.
    if (actionId === 'approve-all' || actionId === 'deny-all') {
      const verb = actionId === 'approve-all' ? 'Allow' : 'Deny';
      if (!confirm(`${verb} ${rules.length} request${rules.length !== 1 ? 's' : ''} globally — for ALL containers? This changes global firewall policy.`)) return;
    }
    forkJoin(rules.map((r) => this.domainCall(actionId, r))).subscribe(() => this.done(rules.map((r) => r.id)));
  }

  onBulkPathPie(actionId: string): void {
    const rows = this.pathRequests.filter((p) => this.selected.has(p.rule.id));
    if (!rows.length) return;
    if (!confirmGlobalPaths(rows)) return;
    forkJoin(rows.map((row) => this.pathCall(actionId, row))).subscribe(() => this.done(rows.map((p) => p.rule.id)));
  }

  // ── Selection (per section: domain requests vs path requests) ──
  pendingChecked(id: number): boolean { return this.selected.has(id); }
  togglePending(id: number): void {
    this.selected.has(id) ? this.selected.delete(id) : this.selected.add(id);
  }
  private allChecked(ids: number[]): boolean { return ids.length > 0 && ids.every((i) => this.selected.has(i)); }
  private toggleAll(ids: number[]): void {
    if (ids.every((i) => this.selected.has(i))) ids.forEach((i) => this.selected.delete(i));
    else ids.forEach((i) => this.selected.add(i));
  }
  private selectedCount(ids: number[]): number { return ids.filter((i) => this.selected.has(i)).length; }

  domainAllChecked(): boolean { return this.allChecked(this.requested.map((r) => r.id)); }
  toggleDomainAll(): void { this.toggleAll(this.requested.map((r) => r.id)); }
  domainSelectedCount(): number { return this.selectedCount(this.requested.map((r) => r.id)); }
  pathAllChecked(): boolean { return this.allChecked(this.pathRequests.map((p) => p.rule.id)); }
  togglePathAll(): void { this.toggleAll(this.pathRequests.map((p) => p.rule.id)); }
  pathSelectedCount(): number { return this.selectedCount(this.pathRequests.map((p) => p.rule.id)); }
}
