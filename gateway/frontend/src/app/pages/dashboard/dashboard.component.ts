import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';
import { combineLatest, map } from 'rxjs';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [AsyncPipe, NgClass, RouterLink, RelTimePipe],
  templateUrl: './dashboard.component.html',
  styles: []
})
export class DashboardComponent {
  state = inject(StateService);
  api = inject(ApiService);
  modal = inject(ModalService);

  protected Math = Math;

  vm$ = combineLatest([this.state.containers$, this.state.rules$, this.state.grants$]).pipe(
    map(([containers, rules, grants]) => {
      const now = Math.floor(Date.now() / 1000);
      const running = containers.filter(c => this.isRunning(c));
      const allowRules = rules.filter(r => r.status === 'allow');
      const denyRules = rules.filter(r => r.status === 'deny');
      const requestedRules = rules.filter(r => r.status === 'requested');
      const activeGrants = Object.entries(grants).filter(([, g]) => g.until > now);
      const topRules = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 4);
      const activityRules = [...rules].sort((a, b) => b.last_seen - a.last_seen).slice(0, 8);
      const recentContainers = containers.slice(0, 6);

      const total = allowRules.length + denyRules.length + requestedRules.length;
      const compliancePct = total === 0 ? 100 : Math.round((allowRules.length / total) * 100);
      const R = 56, circ = 2 * Math.PI * R;
      const allowDash = total > 0 ? (allowRules.length / total) * circ : circ;
      const warnDash = total > 0 ? (requestedRules.length / total) * circ : 0;
      const denyDash = circ - allowDash - warnDash;

      return {
        containers, rules, grants, now,
        runningCount: running.length,
        allowRules, denyRules, requestedRules,
        activeGrants,
        topRules, activityRules, recentContainers,
        compliancePct, R, circ,
        allowDash, warnDash, denyDash,
        allowOff: 0, warnOff: -allowDash, denyOff: -(allowDash + warnDash),
      };
    })
  );

  isRunning(c: Container): boolean { return (c.status || '').toLowerCase().includes('up'); }
  isRogue(c: Container): boolean { return c.inNetwork === false; }
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
  scoreOf(containerName: string, rules: Rule[]): number | null {
    const cRules = rules.filter(r => r.container_id === containerName);
    const allow = cRules.filter(r => r.status === 'allow').length;
    const deny = cRules.filter(r => r.status === 'deny').length;
    const total = allow + deny;
    return total === 0 ? null : Math.round((allow / total) * 100);
  }
  scoreClass(score: number | null): string {
    if (score === null) return 'muted';
    if (score > 70) return 'green';
    if (score > 40) return 'yellow';
    return 'red';
  }
  sourcesLeaf(c: Container): string {
    const p = c.workspacePath || c.labels?.['com.intellij.devcontainer.sources.path'] || c.Labels?.['com.intellij.devcontainer.sources.path'] || '';
    return p ? p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '—' : '—';
  }
  revokeGrant(container: string): void {
    this.api.deleteGrant(container).subscribe(() => this.state.loadAll());
  }
}
