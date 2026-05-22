import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { map } from 'rxjs';

@Component({
  selector: 'app-firewall',
  standalone: true,
  imports: [AsyncPipe, RelTimePipe],
  templateUrl: './firewall.component.html',
  styles: []
})
export class FirewallComponent {
  private state = inject(StateService);
  private api = inject(ApiService);
  modal = inject(ModalService);

  vm$ = this.state.rules$.pipe(
    map(rules => {
      const globalRules = rules.filter(r => r.status !== 'requested' && !r.container_id);
      const allow = globalRules.filter(r => r.status === 'allow');
      const deny = globalRules.filter(r => r.status === 'deny');
      const requested = rules.filter(r => r.status === 'requested');

      const groups: Record<string, Rule[]> = {};
      for (const r of requested) {
        const key = r.container_id || '(global)';
        (groups[key] = groups[key] || []).push(r);
      }
      return { allow, deny, requested, groups, groupNames: Object.keys(groups).sort() };
    })
  );

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
}
