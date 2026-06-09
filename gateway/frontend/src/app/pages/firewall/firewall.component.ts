import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { PathAllowlistComponent } from '../../shared/components/path-allowlist/path-allowlist.component';
import { buildPathDomains, excludePathModeRules } from '../../shared/components/path-allowlist/path-allowlist.util';
import { map } from 'rxjs';

@Component({
  selector: 'app-firewall',
  standalone: true,
  imports: [AsyncPipe, RelTimePipe, PieMenuComponent, PathAllowlistComponent],
  templateUrl: './firewall.component.html',
  styles: [`:host { display: contents; }`]
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

      // Pad-allowlist domeinen krijgen hun eigen sectie; hun marker + padregels
      // worden uit de normale lijsten gefilterd zodat ze niet dubbel verschijnen.
      const pathDomains = buildPathDomains(rules);
      const normal = excludePathModeRules(rules);

      const globalRules = normal.filter(r => r.status !== 'requested' && !r.container_id);
      const allow = globalRules.filter(r => r.status === 'allow');
      const deny = globalRules.filter(r => r.status === 'deny');
      const requested = normal.filter(r => r.status === 'requested');

      const groups: Record<string, Rule[]> = {};
      for (const r of requested) {
        const k = r.container_id || '(global)';
        (groups[k] = groups[k] || []).push(r);
      }

      const tempAllows = normal.filter(r =>
        r.status === 'allow' && r.container_id && r.expires_at && r.expires_at > now
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

  reload(): void { this.state.loadAll(); }
  enablePathMode(rule: Rule): void {
    this.api.setPathMode(rule.id, true).subscribe(() => this.state.loadAll());
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
