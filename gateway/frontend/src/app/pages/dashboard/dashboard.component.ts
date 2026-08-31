import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { combineLatest, map } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [AsyncPipe, NgClass, RouterLink, RelTimePipe, PieMenuComponent],
  templateUrl: './dashboard.component.html',
  styles: [`:host { display: contents; }`]
})
export class DashboardComponent {
  state = inject(StateService);
  api = inject(ApiService);
  modal = inject(ModalService);

  readonly pieConfig: PieMenuConfig = {
    families: [
      {
        id: 'approve',
        label: 'Approve',
        tone: 'green',
        icon: 'approve',
        variants: [
          { id: 'approve-all', label: 'For everyone', icon: 'approve-all' },
        ],
      },
      {
        id: 'temp',
        label: 'Temporary 5 min',
        tone: 'blue',
        icon: 'timer',
        variants: [
          { id: 'temp-10', label: 'Temporary 10 min', icon: 'timer-long' },
          { id: 'later',   label: 'Ask later',        icon: 'later'      },
        ],
      },
      {
        id: 'deny',
        label: 'Deny',
        tone: 'red',
        icon: 'deny',
        variants: [
          { id: 'deny-all', label: 'For everyone', icon: 'deny-all' },
        ],
      },
    ],
  };

  onPieAction(actionId: string, rule: Rule): void {
    switch (actionId) {
      case 'approve':     this.allowRule(rule); break;
      case 'approve-all': this.modal.openConfirm(rule, 'allow'); break;
      case 'temp':        this.allowTimed(rule, 5); break;
      case 'temp-10':     this.allowTimed(rule, 10); break;
      case 'later':       this.deleteRule(rule); break;
      case 'deny':        this.denyRule(rule); break;
      case 'deny-all':    this.modal.openConfirm(rule, 'deny'); break;
    }
  }

  protected Math = Math;

  vm$ = combineLatest([this.state.containers$, this.state.rules$, this.state.grants$]).pipe(
    map(([containers, rules, grants]) => {
      const now = Math.floor(Date.now() / 1000);
      const running = containers.filter(c => this.isRunning(c));
      const requestedRules = rules.filter(r => r.status === 'requested');
      const activeGrants = Object.entries(grants).filter(([, g]) => g.until > now);
      const topRequested = [...requestedRules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 5);
      const activityRules = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 8);
      const recentContainers = containers.slice(0, 6);

      return {
        containers, rules, grants, now,
        runningCount: running.length,
        requestedRules,
        activeGrants,
        topRequested, activityRules, recentContainers,
      };
    })
  );

  isRunning(c: Container): boolean { return (c.status || '').toLowerCase().includes('up'); }
  isRogue(c: Container): boolean { return this.isRunning(c) && c.inNetwork === false; }
  statusClass(c: Container): string {
    if (this.isRogue(c)) return 'rogue';
    if (this.isRunning(c)) return 'running';
    return 'stopped';
  }
  statusLabel(c: Container): string {
    if (this.isRogue(c)) return 'Rogue';
    if (this.isRunning(c)) return 'Running';
    return 'Stopped';
  }
  allowRule(rule: Rule): void {
    this.api.resolveRule(rule.id, 'allow').subscribe(() => this.state.loadAll());
  }
  denyRule(rule: Rule): void {
    this.api.resolveRule(rule.id, 'deny').subscribe(() => this.state.loadAll());
  }
  deleteRule(rule: Rule): void {
    this.api.deleteRule(rule.id).subscribe(() => this.state.loadAll());
  }
  revokeGrant(container: string): void {
    this.api.deleteGrant(container).subscribe(() => this.state.loadAll());
  }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.resolveRule(rule.id, 'allow', 'rule', expires_at).subscribe(() => this.state.loadAll());
  }
}
