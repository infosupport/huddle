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
import { map } from 'rxjs';

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
  imports: [AsyncPipe, FormsModule, RelTimePipe, PieMenuComponent, PathAllowlistComponent, IconComponent],
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

  enablePathMode(rule: Rule): void { this.api.setPathMode(rule.id, true).subscribe(() => this.state.loadAll()); }
  allowRule(rule: Rule): void      { this.api.resolveRule(rule.id, 'allow').subscribe(() => this.state.loadAll()); }
  denyRule(rule: Rule): void       { this.api.resolveRule(rule.id, 'deny').subscribe(() => this.state.loadAll()); }
  deleteRule(rule: Rule): void     { this.api.deleteRule(rule.id).subscribe(() => this.state.loadAll()); }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.resolveRule(rule.id, 'allow', 'rule', expires_at).subscribe(() => this.state.loadAll());
  }
}
