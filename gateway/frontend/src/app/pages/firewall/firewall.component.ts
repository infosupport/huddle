import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { PathAllowlistComponent } from '../../shared/components/path-allowlist/path-allowlist.component';
import { buildPathDomains, excludePathModeRules } from '../../shared/components/path-allowlist/path-allowlist.util';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { FirewallGroupsPanelComponent } from './firewall-groups-panel.component';
import { map, forkJoin, Observable } from 'rxjs';

interface Toast { id: number; caption: string; text: string; tone: 'allow' | 'deny' | 'temp'; }

/** A path sub-request row for the inbox flat list */
interface PathRequestRow {
  rule: Rule;
  domain: string;
  path_pattern: string;
  last_path: string | null;
}

@Component({
  selector: 'app-firewall',
  standalone: true,
  imports: [AsyncPipe, FormsModule, RelTimePipe, PieMenuComponent, PathAllowlistComponent, IconComponent, FirewallGroupsPanelComponent],
  templateUrl: './firewall.component.html',
  styleUrl: './firewall.component.css',
})
export class FirewallComponent {
  private state = inject(StateService);
  private api   = inject(ApiService);
  modal         = inject(ModalService);

  activeTab: 'allow' | 'deny' | 'path' = 'allow';
  searchQuery = '';
  toasts: Toast[] = [];
  resolving = new Set<number>();

  // Bulk selection over the pending inbox (domain requests + path sub-requests),
  // keyed by rule id. A plain Set (like `resolving`) — mutated on the same click
  // events that drive change detection.
  pendingSel = new Set<number>();

  // Known containers for the scope selection in the "add custom rule" form.
  containers$ = this.state.containers$;

  // ── "Add custom rule" form ──────────────────────────────────────────────────
  // Lets the operator write a rule themselves with wildcards: `*.` in the domain
  // and `*` in the path pattern (e.g. an Azure DevOps feed with a changing GUID).
  showAddForm = false;
  addSubmitting = false;
  newDomain = '';
  newPath = '';
  newScope = '';                       // '' = global, otherwise container_id
  newAction: 'allow' | 'deny' = 'allow';

  readonly pieConfig: PieMenuConfig = {
    families: [
      {
        id: 'approve', label: 'Allow', tone: 'green', icon: 'approve',
        variants: [{ id: 'approve-all', label: 'Allow globally', icon: 'approve-all' }],
      },
      {
        id: 'temp', label: 'Temp 5 min', tone: 'blue', icon: 'timer',
        variants: [
          { id: 'temp-10', label: 'Temp 10 min', icon: 'timer-long' },
          { id: 'later',   label: 'Dismiss',     icon: 'later' },
        ],
      },
      {
        id: 'deny', label: 'Deny', tone: 'red', icon: 'deny',
        variants: [{ id: 'deny-all', label: 'Deny globally', icon: 'deny-all' }],
      },
      { id: 'pathmode', label: 'Path mode', tone: 'neutral', icon: 'filter' },
    ],
  };

  /** Pie menu for path sub-requests in the inbox.
   *  Family order maps to fixed wheel positions (0=top, 1=right, 2=bottom,
   *  3=left). Keep everything path-related on the LEFT — mirroring the
   *  `pathmode` slot in the general pie config — so the path icon never jumps
   *  sides just because a domain is already in path mode. Dismiss moves right. */
  readonly pieConfigPath: PieMenuConfig = {
    families: [
      { id: 'path-allow', label: 'Allow exact', tone: 'green', icon: 'approve' },
      { id: 'path-later', label: 'Dismiss', tone: 'neutral', icon: 'later' },
      { id: 'path-deny', label: 'Deny', tone: 'red', icon: 'deny' },
      { id: 'path-prefix', label: 'Allow prefix/*', tone: 'blue', icon: 'filter' },
    ],
  };

  shortContainer(id: string | null): string {
    return (id ?? 'global').replace(/^devcontainer-/, '');
  }

  filterRules(rules: Rule[], q: string): Rule[] {
    if (!q) return rules;
    const lq = q.toLowerCase();
    return rules.filter(r => r.domain.toLowerCase().includes(lq));
  }

  private pushToast(caption: string, text: string, tone: Toast['tone']): void {
    const id = Date.now();
    this.toasts = [...this.toasts, { id, caption, text, tone }];
    setTimeout(() => { this.toasts = this.toasts.filter(t => t.id !== id); }, 2800);
  }

  private resolve(rule: Rule, fn: () => void): void {
    this.resolving = new Set(this.resolving).add(rule.id);
    setTimeout(() => { fn(); this.resolving.delete(rule.id); }, 240);
  }

  onPieAction(actionId: string, rule: Rule): void {
    switch (actionId) {
      case 'approve':
        this.resolve(rule, () => this.allowRule(rule));
        this.pushToast(rule.domain, 'Allowed for this container', 'allow'); break;
      case 'approve-all':
        this.modal.openConfirm(rule, 'allow'); break;
      case 'temp':
        this.resolve(rule, () => this.allowTimed(rule, 5));
        this.pushToast(rule.domain, 'Allowed for 5 minutes', 'temp'); break;
      case 'temp-10':
        this.resolve(rule, () => this.allowTimed(rule, 10));
        this.pushToast(rule.domain, 'Allowed for 10 minutes', 'temp'); break;
      case 'later':
        this.resolve(rule, () => this.deleteRule(rule));
        this.pushToast(rule.domain, 'Request dismissed', 'deny'); break;
      case 'deny':
        this.resolve(rule, () => this.denyRule(rule));
        this.pushToast(rule.domain, 'Denied for this container', 'deny'); break;
      case 'deny-all':
        this.modal.openConfirm(rule, 'deny'); break;
      case 'pathmode':
        this.resolve(rule, () => this.enablePathMode(rule));
        this.pushToast(rule.domain, 'Now reviewed by path', 'allow'); break;
    }
  }

  onPathPieAction(actionId: string, row: PathRequestRow): void {
    const { rule } = row;
    switch (actionId) {
      case 'path-allow':
        this.resolve(rule, () =>
          this.api.resolveRule(rule.id, 'allow', 'rule', undefined, row.path_pattern).subscribe(() => this.state.loadAll())
        );
        this.pushToast(row.path_pattern, 'Path allowed', 'allow'); break;
      case 'path-prefix': {
        const prefix = this.toPrefix(row.path_pattern);
        this.resolve(rule, () =>
          this.api.resolveRule(rule.id, 'allow', 'rule', undefined, prefix).subscribe(() => this.state.loadAll())
        );
        this.pushToast(row.domain, `Prefix ${prefix} allowed`, 'allow'); break;
      }
      case 'path-deny':
        this.resolve(rule, () =>
          this.api.resolveRule(rule.id, 'deny', 'rule', undefined, row.path_pattern).subscribe(() => this.state.loadAll())
        );
        this.pushToast(row.path_pattern, 'Path denied', 'deny'); break;
      case 'path-later':
        this.resolve(rule, () => this.deleteRule(rule));
        this.pushToast(row.path_pattern, 'Request dismissed', 'deny'); break;
    }
  }

  private toPrefix(path: string): string {
    const parts = path.replace(/\/+$/, '').split('/');
    return parts.slice(0, -1).join('/') + '/*';
  }

  vm$ = this.state.rules$.pipe(
    map(rules => {
      const now = Math.floor(Date.now() / 1000);
      const pathDomains = buildPathDomains(rules);
      const normal      = excludePathModeRules(rules);
      const allow       = normal.filter(r => r.status === 'allow');
      const deny        = normal.filter(r => r.status === 'deny');
      const requested   = normal.filter(r => r.status === 'requested');

      // Collect path sub-requests from path-mode domains into the inbox
      const pathRequested: PathRequestRow[] = pathDomains.flatMap(pd =>
        pd.requested
          .filter(r => !!r.path_pattern)
          .map(r => ({
            rule: r,
            domain: pd.domain,
            path_pattern: r.path_pattern!,
            last_path: (r as any).last_path ?? null,
          }))
      );

      return { allow, deny, requested, pathDomains, pathRequested, now };
    })
  );

  reload(): void { this.state.loadAll(); }

  toggleAddForm(): void {
    this.showAddForm = !this.showAddForm;
    if (!this.showAddForm) this.resetAddForm();
  }

  private resetAddForm(): void {
    this.newDomain = '';
    this.newPath = '';
    this.newScope = '';
    this.newAction = 'allow';
  }

  addCustomRule(): void {
    const domain = this.newDomain.trim();
    if (!domain || this.addSubmitting) return;
    const path = this.newPath.trim() || null;
    const containerId = this.newScope || null;
    this.addSubmitting = true;
    this.api.createRule(domain, containerId, this.newAction, path).subscribe({
      next: () => {
        const tone: Toast['tone'] = this.newAction === 'deny' ? 'deny' : 'allow';
        this.pushToast(path ? `${domain}${path}` : domain, `Rule ${this.newAction}ed`, tone);
        this.addSubmitting = false;
        this.showAddForm = false;
        this.resetAddForm();
        this.state.loadAll();
      },
      error: (err: Error) => {
        this.addSubmitting = false;
        this.pushToast(domain, err.message || 'Could not add rule', 'deny');
      },
    });
  }

  // ── Export / import (#69) ──────────────────────────────────────────────────
  exportRules(): void {
    this.api.exportRules().subscribe({
      next: (doc) => {
        const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `huddle-firewall-rules-${new Date().toISOString().slice(0, 10)}.json`;
        a.click();
        URL.revokeObjectURL(url);
        this.pushToast('Firewall rules', 'Exported to JSON', 'allow');
      },
      error: (err) => this.pushToast('Export failed', err.message ?? 'Error', 'deny'),
    });
  }

  onImportFile(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    input.value = ''; // allow selecting the same file again
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let doc: Record<string, unknown>;
      try {
        doc = JSON.parse(String(reader.result)) as Record<string, unknown>;
      } catch {
        this.pushToast('Import failed', 'Not valid JSON', 'deny');
        return;
      }
      this.api.importRules({ ...doc, mode: 'merge' }).subscribe({
        next: (res) => {
          this.pushToast('Firewall rules', `Imported: ${res.imported} added, ${res.updated} updated`, 'allow');
          this.state.loadAll();
        },
        error: (err) => this.pushToast('Import failed', err.message ?? 'Error', 'deny'),
      });
    };
    reader.readAsText(file);
  }

  enablePathMode(rule: Rule): void { this.api.setPathMode(rule.id, true).subscribe(() => this.state.loadAll()); }
  allowRule(rule: Rule): void      { this.api.resolveRule(rule.id, 'allow').subscribe(() => this.state.loadAll()); }
  denyRule(rule: Rule): void       { this.api.resolveRule(rule.id, 'deny').subscribe(() => this.state.loadAll()); }
  deleteRule(rule: Rule): void     { this.api.deleteRule(rule.id).subscribe(() => this.state.loadAll()); }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.resolveRule(rule.id, 'allow', 'rule', expires_at).subscribe(() => this.state.loadAll());
  }

  // ── Pending selection (per section: domain requests vs path requests) ────────
  pendingChecked(id: number): boolean { return this.pendingSel.has(id); }
  togglePending(id: number): void {
    this.pendingSel.has(id) ? this.pendingSel.delete(id) : this.pendingSel.add(id);
  }
  private allChecked(ids: number[]): boolean { return ids.length > 0 && ids.every((i) => this.pendingSel.has(i)); }
  private toggleAll(ids: number[]): void {
    if (ids.every((i) => this.pendingSel.has(i))) ids.forEach((i) => this.pendingSel.delete(i));
    else ids.forEach((i) => this.pendingSel.add(i));
  }
  private selectedCount(ids: number[]): number { return ids.filter((i) => this.pendingSel.has(i)).length; }

  // Domain (normal) requests.
  domainAllChecked(rs: Rule[]): boolean { return this.allChecked(rs.map((r) => r.id)); }
  toggleDomainAll(rs: Rule[]): void { this.toggleAll(rs.map((r) => r.id)); }
  domainSelectedCount(rs: Rule[]): number { return this.selectedCount(rs.map((r) => r.id)); }
  // Path sub-requests.
  pathAllChecked(rows: PathRequestRow[]): boolean { return this.allChecked(rows.map((p) => p.rule.id)); }
  togglePathAll(rows: PathRequestRow[]): void { this.toggleAll(rows.map((p) => p.rule.id)); }
  pathSelectedCount(rows: PathRequestRow[]): number { return this.selectedCount(rows.map((p) => p.rule.id)); }

  private afterBulk(n: number, caption: string, tone: Toast['tone'], ids: number[]): void {
    ids.forEach((i) => this.pendingSel.delete(i));
    this.state.loadAll();
    this.pushToast(`${n} request${n !== 1 ? 's' : ''}`, caption, tone);
  }

  // Bulk pie for domain requests — same actions/config as a single row's pie
  // (this.pieConfig), applied to every selected domain request at once.
  onBulkPie(actionId: string, requested: Rule[]): void {
    const rules = requested.filter((r) => this.pendingSel.has(r.id));
    if (!rules.length) return;
    // Global allow/deny changes policy for ALL containers. Single-item actions go
    // through the confirmation modal; keep an equivalent guard for the bulk path.
    if (actionId === 'approve-all' || actionId === 'deny-all') {
      const verb = actionId === 'approve-all' ? 'Allow' : 'Deny';
      if (!confirm(`${verb} ${rules.length} request${rules.length !== 1 ? 's' : ''} globally — for ALL containers? This changes global firewall policy.`)) return;
    }
    const now = Math.floor(Date.now() / 1000);
    const call = (r: Rule): Observable<unknown> => {
      switch (actionId) {
        case 'approve':     return this.api.resolveRule(r.id, 'allow', 'rule');
        case 'approve-all': return this.api.resolveRule(r.id, 'allow', 'global');
        case 'temp':        return this.api.resolveRule(r.id, 'allow', 'rule', now + 5 * 60);
        case 'temp-10':     return this.api.resolveRule(r.id, 'allow', 'rule', now + 10 * 60);
        case 'later':       return this.api.deleteRule(r.id) as unknown as Observable<unknown>;
        case 'deny':        return this.api.resolveRule(r.id, 'deny', 'rule');
        case 'deny-all':    return this.api.resolveRule(r.id, 'deny', 'global');
        case 'pathmode':    return this.api.setPathMode(r.id, true);
        default:            return this.api.resolveRule(r.id, 'allow', 'rule');
      }
    };
    const [caption, tone] = this.pieOutcome(actionId);
    forkJoin(rules.map(call)).subscribe({
      next: () => this.afterBulk(rules.length, caption, tone, rules.map((r) => r.id)),
      error: (e) => this.pushToast('Bulk action failed', e.message ?? 'Error', 'deny'),
    });
  }

  // Bulk pie for path sub-requests — mirrors this.pieConfigPath / onPathPieAction.
  onBulkPathPie(actionId: string, pathReq: PathRequestRow[]): void {
    const rows = pathReq.filter((p) => this.pendingSel.has(p.rule.id));
    if (!rows.length) return;
    const call = (row: PathRequestRow): Observable<unknown> => {
      switch (actionId) {
        case 'path-allow':  return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, row.path_pattern);
        case 'path-prefix': return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, this.toPrefix(row.path_pattern));
        case 'path-deny':   return this.api.resolveRule(row.rule.id, 'deny', 'rule', undefined, row.path_pattern);
        case 'path-later':  return this.api.deleteRule(row.rule.id) as unknown as Observable<unknown>;
        default:            return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, row.path_pattern);
      }
    };
    const tone: Toast['tone'] = actionId === 'path-deny' ? 'deny' : actionId === 'path-later' ? 'deny' : 'allow';
    const caption = actionId === 'path-deny' ? 'Denied' : actionId === 'path-later' ? 'Dismissed' : 'Allowed';
    forkJoin(rows.map(call)).subscribe({
      next: () => this.afterBulk(rows.length, caption, tone, rows.map((p) => p.rule.id)),
      error: (e) => this.pushToast('Bulk action failed', e.message ?? 'Error', 'deny'),
    });
  }

  private pieOutcome(actionId: string): [string, Toast['tone']] {
    switch (actionId) {
      case 'approve':     return ['Allowed', 'allow'];
      case 'approve-all': return ['Allowed globally', 'allow'];
      case 'temp':        return ['Allowed for 5 minutes', 'temp'];
      case 'temp-10':     return ['Allowed for 10 minutes', 'temp'];
      case 'later':       return ['Dismissed', 'deny'];
      case 'deny':        return ['Denied', 'deny'];
      case 'deny-all':    return ['Denied globally', 'deny'];
      case 'pathmode':    return ['Now reviewed by path', 'allow'];
      default:            return ['Updated', 'allow'];
    }
  }
}
