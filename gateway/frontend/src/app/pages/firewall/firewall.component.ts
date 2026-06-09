import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { map } from 'rxjs';

@Component({
  selector: 'app-firewall',
  standalone: true,
  imports: [AsyncPipe, RelTimePipe, PieMenuComponent],
  templateUrl: './firewall.component.html',
  styles: [`
    :host { display: contents; }
    .pathmode-domain { padding: 0.5rem 0; border-top: 1px solid var(--border, #e4e0d6); }
    .pathmode-domain:first-of-type { border-top: none; }
    .pathmode-domain h4 { display: flex; align-items: center; gap: 0.5rem; }
    .pathmode-domain h4 .btn { margin-left: auto; }
    .pathmode-domain h5 { margin: 0.5rem 0 0.25rem; font-size: 0.8rem; opacity: 0.8; }
    .path-input { width: 100%; min-width: 12rem; font-family: monospace; font-size: 0.85rem; padding: 0.2rem 0.4rem; box-sizing: border-box; }
    .path-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; justify-content: flex-end; }
    .full-path { margin-top: 0.2rem; font-family: monospace; font-size: 0.75rem; opacity: 0.65; word-break: break-all; }
    .path-collapse > summary { cursor: pointer; list-style: revert; user-select: none; }
    .path-collapse > summary > h5 { display: inline; }
  `]
})
export class FirewallComponent {
  private state = inject(StateService);
  private api = inject(ApiService);
  modal = inject(ModalService);

  readonly pieConfig: PieMenuConfig = {
    families: [
      {
        id: 'approve',
        label: 'Goedkeuren',
        tone: 'green',
        icon: 'approve',
        variants: [
          { id: 'approve-all', label: 'Voor iedereen', icon: 'approve-all' },
        ],
      },
      {
        id: 'temp',
        label: 'Tijdelijk 5 min',
        tone: 'blue',
        icon: 'timer',
        variants: [
          { id: 'temp-10', label: 'Tijdelijk 10 min', icon: 'timer-long' },
          { id: 'later',   label: 'Vraag later',      icon: 'later'      },
        ],
      },
      {
        id: 'deny',
        label: 'Afkeuren',
        tone: 'red',
        icon: 'deny',
        variants: [
          { id: 'deny-all', label: 'Voor iedereen', icon: 'deny-all' },
        ],
      },
      {
        id: 'pathmode',
        label: 'Pad-allowlist',
        tone: 'neutral',
        icon: 'filter',
      },
    ],
  };

  // Lokale, bewerkbare padpatronen per requested-subpad (key = rule.id). Pre-fill
  // met het door de engine gegroepeerde patroon; operator kan verfijnen.
  pathEdits: Record<number, string> = {};

  onPieAction(actionId: string, rule: Rule): void {
    switch (actionId) {
      case 'approve':     this.allowRule(rule); break;
      case 'approve-all': this.modal.openConfirm(rule.domain, 'allow'); break;
      case 'temp':        this.allowTimed(rule, 5); break;
      case 'temp-10':     this.allowTimed(rule, 10); break;
      case 'later':       this.deleteRule(rule); break;
      case 'deny':        this.denyRule(rule); break;
      case 'deny-all':    this.modal.openConfirm(rule.domain, 'deny'); break;
      case 'pathmode':    this.enablePathMode(rule); break;
    }
  }

  vm$ = this.state.rules$.pipe(
    map(rules => {
      const now = Math.floor(Date.now() / 1000);

      // Identiteit van een (domein, container) — bepaalt of een regel bij een
      // pad-allowlist domein hoort.
      const key = (r: Rule) => `${r.container_id ?? ''}|${r.domain}`;

      // Host-only marker-regels (path_mode=1): die plus al hun padregels horen
      // in de aparte pad-allowlist sectie, niet in de normale lijsten.
      const markers = rules.filter(r => r.path_mode === 1 && !r.path_pattern);
      const pmKeys = new Set(markers.map(key));
      const belongsPm = (r: Rule) => pmKeys.has(key(r));

      const pathDomains = markers
        .map(m => {
          const paths = rules.filter(r => key(r) === key(m) && !!r.path_pattern);
          return {
            marker: m,
            domain: m.domain,
            scope: m.container_id ?? '(global)',
            allowed: paths.filter(r => r.status === 'allow').sort((a, b) => (a.path_pattern ?? '').localeCompare(b.path_pattern ?? '')),
            denied: paths.filter(r => r.status === 'deny').sort((a, b) => (a.path_pattern ?? '').localeCompare(b.path_pattern ?? '')),
            requested: paths.filter(r => r.status === 'requested').sort((a, b) => b.last_seen - a.last_seen),
          };
        })
        .sort((a, b) => a.domain.localeCompare(b.domain));

      const globalRules = rules.filter(r => r.status !== 'requested' && !r.container_id && !belongsPm(r));
      const allow = globalRules.filter(r => r.status === 'allow');
      const deny = globalRules.filter(r => r.status === 'deny');
      const requested = rules.filter(r => r.status === 'requested' && !belongsPm(r));

      const groups: Record<string, Rule[]> = {};
      for (const r of requested) {
        const k = r.container_id || '(global)';
        (groups[k] = groups[k] || []).push(r);
      }

      const tempAllows = rules.filter(r =>
        r.status === 'allow' && r.container_id && r.expires_at && r.expires_at > now && !belongsPm(r)
      );
      const tempGroups: Record<string, Rule[]> = {};
      for (const r of tempAllows) {
        const k = r.container_id!;
        (tempGroups[k] = tempGroups[k] || []).push(r);
      }

      return {
        allow, deny, requested, groups, groupNames: Object.keys(groups).sort(),
        tempGroups, tempGroupNames: Object.keys(tempGroups).sort(),
        pathDomains, now,
      };
    })
  );

  // ── Pad-allowlist acties ────────────────────────────────────────────────────

  enablePathMode(rule: Rule): void {
    this.api.setPathMode(rule.id, true).subscribe(() => this.state.loadAll());
  }
  disablePathMode(rule: Rule): void {
    this.api.setPathMode(rule.id, false).subscribe(() => this.state.loadAll());
  }

  // Huidige (mogelijk bewerkte) waarde van het padpatroon-invoerveld voor een rij.
  pathEditValue(rule: Rule): string {
    return this.pathEdits[rule.id] ?? rule.path_pattern ?? '';
  }
  private effPattern(rule: Rule): string {
    return this.pathEditValue(rule);
  }
  // Prefix-match: garandeer een trailing `*` (`/api` → `/api/*`, `/api/` → `/api/*`).
  private toPrefix(p: string): string {
    let s = p.trim();
    if (!s.startsWith('/')) s = '/' + s;
    if (s.endsWith('*')) return s;
    return (s.endsWith('/') ? s : s + '/') + '*';
  }
  // Exacte match: strip een eventuele trailing `/*` of `*`.
  private toExact(p: string): string {
    let s = p.trim();
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/?\*+$/, '');
    return s || '/';
  }

  approvePath(rule: Rule, mode: 'prefix' | 'exact', minutes?: number): void {
    const pattern = mode === 'prefix' ? this.toPrefix(this.effPattern(rule)) : this.toExact(this.effPattern(rule));
    const expires = minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : undefined;
    this.api.updateRule(rule.id, 'allow', expires, pattern).subscribe(() => this.state.loadAll());
  }
  denyPath(rule: Rule): void {
    this.api.updateRule(rule.id, 'deny', undefined, this.toPrefix(this.effPattern(rule))).subscribe(() => this.state.loadAll());
  }

  allowRule(rule: Rule): void {
    this.api.updateRule(rule.id, 'allow').subscribe(() => this.state.loadAll());
  }
  denyRule(rule: Rule): void {
    this.api.updateRule(rule.id, 'deny').subscribe(() => this.state.loadAll());
  }
  deleteRule(rule: Rule): void {
    this.api.deleteRule(rule.id).subscribe(() => this.state.loadAll());
  }
  openGlobalConfirm(domain: string, status: 'allow' | 'deny'): void {
    this.modal.openConfirm(domain, status);
  }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.updateRule(rule.id, 'allow', expires_at).subscribe(() => this.state.loadAll());
  }
}
