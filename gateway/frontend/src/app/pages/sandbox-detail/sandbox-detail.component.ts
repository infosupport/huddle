import { Component, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, HOST_PIPE_OFFLINE_HINT, SandboxInfo, isHostPipeOffline, isProviderDisabled } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { Rule } from '../../core/models/rule.model';
import { forkJoin, Observable } from 'rxjs';
import { ModalService } from '../../core/services/modal.service';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { FirewallGroupsPanelComponent } from '../firewall/firewall-groups-panel.component';

// Detail of one sandbox of an environment provider. Its firewall scope is
// `<provider>:<name>` (the identity the egress listener gives it), so pending
// requests and rules are the ones with that container_id.
@Component({
  selector: 'app-sandbox-detail',
  standalone: true,
  imports: [RouterLink, RelTimePipe, IconComponent, PieMenuComponent, FirewallGroupsPanelComponent],
  templateUrl: './sandbox-detail.component.html',
  styleUrls: ['../container-detail/container-detail.component.css'],
})
export class SandboxDetailComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(StateService);
  private destroyRef = inject(DestroyRef);
  private modal = inject(ModalService);

  readonly provider = this.route.snapshot.paramMap.get('provider') ?? '';
  readonly name = this.route.snapshot.paramMap.get('name') ?? '';
  readonly scope = `${this.provider}:${this.name}`;

  providerLabel = signal(this.provider);
  sandbox = signal<SandboxInfo | null>(null);
  loading = signal(true);
  error = signal<string | null>(null);
  busy = signal<string | null>(null);
  ideStatus = signal('');
  sshHost = signal<string | null>(null);
  private rules = signal<Rule[]>([]);

  requested = computed(() => this.rules().filter(r => r.container_id === this.scope && r.status === 'requested'));
  running = computed(() => /up|run/i.test(this.sandbox()?.status || ''));

  constructor() {
    this.state.rules$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(r => this.rules.set(r));
    this.load();
  }

  load(): void {
    this.loading.set(true);
    this.api.listEnvironments().subscribe({
      next: ({ providers }) => {
        const p = (providers ?? []).find(x => x.id === this.provider);
        if (p) this.providerLabel.set(p.label);
      },
      error: () => undefined,
    });
    this.api.listSandboxes(this.provider).subscribe({
      next: ({ sandboxes }) => {
        const s = (sandboxes ?? []).find(x => x.name === this.name) ?? null;
        this.sandbox.set(s);
        this.error.set(s ? null : `Sandbox "${this.name}" does not exist (anymore).`);
        this.loading.set(false);
      },
      error: (e) => {
        this.loading.set(false);
        this.error.set(isProviderDisabled(e) ? `${this.providerLabel()} is switched off in Huddle.`
          : isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'could not list the sandboxes');
      },
    });
  }

  // Same actions as a devcontainer's pending requests (container-detail).
  readonly pieConfig: PieMenuConfig = {
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

  onPieAction(actionId: string, rule: Rule): void {
    if (actionId === 'approve-all' || actionId === 'deny-all') {
      this.modal.openConfirm(rule, actionId === 'approve-all' ? 'allow' : 'deny');
      return;
    }
    this.call(actionId, rule).subscribe(() => this.state.loadAll());
  }

  private call(actionId: string, r: Rule): Observable<unknown> {
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

  // ── Selection for the bulk pie ──
  private selected = signal(new Set<number>());
  pendingChecked(id: number): boolean { return this.selected().has(id); }
  togglePending(id: number): void {
    const next = new Set(this.selected());
    next.has(id) ? next.delete(id) : next.add(id);
    this.selected.set(next);
  }
  allChecked(): boolean { const rs = this.requested(); return rs.length > 0 && rs.every((r) => this.selected().has(r.id)); }
  toggleAll(): void { this.selected.set(this.allChecked() ? new Set() : new Set(this.requested().map((r) => r.id))); }
  selectedCount(): number { return this.requested().filter((r) => this.selected().has(r.id)).length; }

  onBulkPie(actionId: string): void {
    const rules = this.requested().filter((r) => this.selected().has(r.id));
    if (!rules.length) return;
    // Global allow/deny changes policy for everything, beyond this sandbox.
    if (actionId === 'approve-all' || actionId === 'deny-all') {
      const verb = actionId === 'approve-all' ? 'Allow' : 'Deny';
      if (!confirm(`${verb} ${rules.length} request${rules.length !== 1 ? 's' : ''} globally — for ALL containers? This changes global firewall policy.`)) return;
    }
    forkJoin(rules.map((r) => this.call(actionId, r))).subscribe(() => {
      this.selected.set(new Set());
      this.state.loadAll();
    });
  }

  // The link opens VS Code (Remote-SSH) or the JetBrains Toolbox App on this machine;
  // both reach the sandbox through the `<name>.sbx` alias `sbx setup ssh` wrote.
  connectIde(ide: 'vscode' | 'jetbrains'): void {
    this.ideStatus.set('Preparing SSH…');
    this.api.getSandboxIdeLink(this.provider, this.name, ide).subscribe({
      next: ({ link, sshHost }) => {
        this.sshHost.set(sshHost);
        const prefix = ide === 'vscode' ? 'vscode://' : 'jetbrains://gateway/ssh/environment?';
        if (typeof link !== 'string' || !link.startsWith(prefix)) { this.ideStatus.set('Unexpected link from the gateway; not opened.'); return; }
        this.ideStatus.set('');
        window.open(link, '_self');
      },
      error: (e) => this.ideStatus.set(isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'could not prepare SSH'),
    });
  }

  remove(): void {
    if (!confirm(`Remove sandbox "${this.name}"? This deletes the sandbox and everything inside it.`)) return;
    this.busy.set('Removing…');
    this.api.removeSandbox(this.provider, this.name, true).subscribe({
      next: () => this.router.navigate(['/dev-environments']),
      error: (e) => { this.busy.set(null); this.error.set('✗ ' + (e?.message || 'remove failed')); },
    });
  }
}
