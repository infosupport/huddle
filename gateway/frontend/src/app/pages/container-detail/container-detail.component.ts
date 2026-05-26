import { Component, inject, OnInit } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AsyncPipe, DatePipe } from '@angular/common';
import { ApiService } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { GrantMap } from '../../core/models/grant.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { BehaviorSubject } from 'rxjs';

interface DetailData {
  inspect: any;
  rules: Rule[];
  globalRules: Rule[];
}

@Component({
  selector: 'app-container-detail',
  standalone: true,
  imports: [AsyncPipe, RouterLink, RelTimePipe, DatePipe, PieMenuComponent],
  templateUrl: './container-detail.component.html',
  styles: [`:host { display: contents; }`]
})
export class ContainerDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private state = inject(StateService);
  modal = inject(ModalService);

  protected Math = Math;

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
    }
  }

  name = '';
  detail$ = new BehaviorSubject<DetailData | null>(null);
  error$ = new BehaviorSubject<string | null>(null);
  grants$ = this.state.grants$;
  credentials: { password: string; createdAt: number } | null = null;
  passwordVisible = false;
  copied = false;

  ngOnInit(): void {
    this.name = this.route.snapshot.paramMap.get('name') ?? '';
    this.load();
    this.api.getContainerCredentials(this.name).subscribe({
      next: (c) => this.credentials = c,
      error: () => this.credentials = null,
    });
  }

  load(): void {
    this.api.getContainerDetail(this.name).subscribe({
      next: (data: any) => this.detail$.next(data),
      error: (err) => this.error$.next(err.message),
    });
  }

  allowRules(rules: Rule[]) { return rules.filter(r => r.status === 'allow'); }
  denyRules(rules: Rule[]) { return rules.filter(r => r.status === 'deny'); }
  requestedRules(rules: Rule[]) { return rules.filter(r => r.status === 'requested'); }
  tempAllowRules(rules: Rule[]) {
    const now = Math.floor(Date.now() / 1000);
    return rules.filter(r => r.status === 'allow' && r.expires_at && r.expires_at > now);
  }
  permanentAllowRules(rules: Rule[]) { return rules.filter(r => r.status === 'allow' && !r.expires_at); }

  allowRule(rule: Rule): void {
    this.api.updateRule(rule.id, 'allow').subscribe(() => { this.state.loadAll(); this.load(); });
  }
  denyRule(rule: Rule): void {
    this.api.updateRule(rule.id, 'deny').subscribe(() => { this.state.loadAll(); this.load(); });
  }
  deleteRule(rule: Rule): void {
    this.api.deleteRule(rule.id).subscribe(() => { this.state.loadAll(); this.load(); });
  }
  openGlobalConfirm(domain: string, status: 'allow' | 'deny'): void {
    this.modal.openConfirm(domain, status);
  }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.updateRule(rule.id, 'allow', expires_at).subscribe(() => { this.state.loadAll(); this.load(); });
  }

  copyPassword(): void {
    if (!this.credentials) return;
    navigator.clipboard.writeText(this.credentials.password).then(() => {
      this.copied = true;
      setTimeout(() => { this.copied = false; }, 2000);
    });
  }

  remainingMinutes(until: number): number {
    return Math.ceil((until - Math.floor(Date.now() / 1000)) / 60);
  }

  grantRemaining(grants: GrantMap): number {
    const g = grants[this.name];
    if (!g) return 0;
    return Math.max(0, g.until - Math.floor(Date.now() / 1000));
  }

  grant(minutes: number): void {
    this.api.setGrant(this.name, minutes).subscribe(() => this.state.loadAll());
  }
  revoke(): void {
    this.api.deleteGrant(this.name).subscribe(() => this.state.loadAll());
  }
}
