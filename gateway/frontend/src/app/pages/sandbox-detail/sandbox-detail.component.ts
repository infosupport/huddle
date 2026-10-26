import { Component, inject, signal, computed, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiService, HOST_PIPE_OFFLINE_HINT, SandboxInfo, isHostPipeOffline, isProviderDisabled } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { Rule } from '../../core/models/rule.model';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { FirewallGroupsPanelComponent } from '../firewall/firewall-groups-panel.component';

// Detail of one sandbox of an environment provider. Its firewall scope is
// `<provider>:<name>` (the identity the egress listener gives it), so pending
// requests and rules are the ones with that container_id.
@Component({
  selector: 'app-sandbox-detail',
  standalone: true,
  imports: [RouterLink, RelTimePipe, IconComponent, FirewallGroupsPanelComponent],
  templateUrl: './sandbox-detail.component.html',
  styleUrls: ['../container-detail/container-detail.component.css', './sandbox-detail.component.css'],
})
export class SandboxDetailComponent {
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);
  private state = inject(StateService);
  private destroyRef = inject(DestroyRef);

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

  resolve(rule: Rule, status: 'allow' | 'deny', minutes?: number): void {
    const expires = minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : undefined;
    this.api.resolveRule(rule.id, status, 'rule', expires).subscribe(() => this.state.loadAll());
  }

  // The link opens VS Code (Remote-SSH) or JetBrains Gateway on this machine;
  // both reach the sandbox through the `<name>.sbx` alias `sbx setup ssh` wrote.
  connectIde(ide: 'vscode' | 'jetbrains'): void {
    this.ideStatus.set('Preparing SSH…');
    this.api.getSandboxIdeLink(this.provider, this.name, ide).subscribe({
      next: ({ link, sshHost }) => {
        this.sshHost.set(sshHost);
        const prefix = ide === 'vscode' ? 'vscode://' : 'jetbrains-gateway://';
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
