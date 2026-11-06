import { Component, DestroyRef, inject, signal } from '@angular/core';
import {
  ApiService, HOST_PIPE_OFFLINE_HINT, ProviderStatus, SandboxStep, isHostPipeOffline, isProviderDisabled,
} from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';

// Settings → Dev environments: switch each environment provider the gateway
// reports (Docker Sandbox today, others later) on or off in Huddle, and recreate
// its sandboxes. The Dev Environments page links here.
@Component({
  selector: 'app-environment-providers',
  standalone: true,
  template: `
    @if (loading()) {
      <p class="loading-row"><span class="spinner"></span> Loading… (asking the host agent)</p>
    } @else if (loadError()) {
      <p class="form-error">{{ loadError() }}</p>
    } @else if (!providers().length) {
      <p class="empty-note">No environment providers.</p>
    }
    @for (p of providers(); track p.id) {
      <div class="provider">
        <div class="provider__head">
          <div class="provider__info">
            <b>{{ p.label }}</b>
            <span class="state" [class.state--on]="p.enabled">{{ p.enabled ? 'On' : 'Off' }}</span>
            @if (p.version) { <span class="muted"> {{ p.version }}</span> }
            <div class="provider__sub">
              @if (p.enabled) {
                Sandbox traffic goes through the Huddle firewall.
              } @else {
                Switched off in Huddle — its sandboxes are not listed or created here.
              }
            </div>
            @if (p.enabled && !p.available) {
              <div class="provider__sub provider__warn">Unavailable{{ p.error ? ': ' + p.error : '' }}</div>
            }
            @if (p.unavailableReason) {
              <div class="provider__sub provider__warn">Cannot be switched on: {{ p.unavailableReason }}</div>
            }
          </div>
          <div class="provider__actions">
            @if (providerBusyLabel(p.id); as label) {
              <span class="loading-row"><span class="spinner"></span> {{ label }}</span>
            }
            @if (p.enabled) {
              <button class="btn btn-ghost btn-sm" (click)="recreateAll(p)"
                      [disabled]="!!providerBusyLabel(p.id) || isRecreating(p)">Recreate all</button>
            }
            <button type="button" class="btn btn-sm" [class.btn--accent]="!p.enabled" [class.btn-ghost]="p.enabled"
                    [disabled]="!!providerBusyLabel(p.id) || isRecreating(p) || (!p.enabled && !!p.unavailableReason)"
                    [title]="!p.enabled && p.unavailableReason ? p.unavailableReason : ''"
                    (click)="toggleProvider(p)">{{ p.enabled ? 'Switch off' : 'Switch on' }}</button>
          </div>
        </div>

        @if (p.recreate; as rc) {
          @if (rc.running) {
            <p class="loading-row"><span class="spinner"></span>
              Recreating sandboxes ({{ rc.reason }})… {{ rc.results.length }} done so far. Sandboxes are unavailable meanwhile.</p>
          } @else if (rc.finishedAt) {
            <p class="provider__sub">
              Last recreate ({{ rc.reason }}): {{ rc.results.length - failedRecreates(p).length }} of {{ rc.results.length }} sandboxes recreated.
            </p>
            @if (failedRecreates(p).length) {
              <ul class="provider__fails">
                @for (r of failedRecreates(p); track r.name) {
                  <li><code>{{ r.name }}</code> — {{ r.message || 'failed' }} (stopped)</li>
                }
              </ul>
            }
          }
        }

        @if (providerError()[p.id]; as err) { <p class="form-error">{{ err }}</p> }
        @if (providerSteps()[p.id]?.length) {
          <ul class="steps">
            @for (step of providerSteps()[p.id]; track $index) {
              <li>
                <b>{{ step.label }}</b> — exit {{ step.code }}<br />
                <code>{{ step.command }}</code>
                @if (step.stderr || step.stdout) { <pre>{{ step.stderr || step.stdout }}</pre> }
              </li>
            }
          </ul>
        }
      </div>
    }
  `,
  styles: [`
    .spinner {
      display: inline-block; width: 12px; height: 12px; vertical-align: -1px; margin-right: 5px;
      border: 2px solid var(--border-strong, rgba(128,128,128,.4)); border-top-color: var(--accent, #5865f2);
      border-radius: 50%; animation: prov-spin .7s linear infinite;
    }
    @keyframes prov-spin { to { transform: rotate(360deg); } }
    .loading-row { display: flex; align-items: center; color: var(--text-muted); font-size: 13px; margin: 0; padding: 6px 0; }
    .provider + .provider { border-top: 1px solid var(--border); margin-top: 12px; padding-top: 12px; }
    .provider__head { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; justify-content: space-between; }
    .provider__info { min-width: 0; flex: 1 1 260px; }
    .provider__sub { font-size: 12px; color: var(--text-muted); margin: 3px 0 0; }
    .provider__warn { color: var(--danger); }
    .provider__actions { display: flex; align-items: center; gap: 10px; }
    .provider__fails { margin: 6px 0 0; padding-left: 18px; font-size: 12px; color: var(--danger); }
    .state { display: inline-flex; margin-left: 8px; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 700;
      background: var(--surface-hover); color: var(--text-muted); }
    .state--on { background: var(--accent-soft, rgba(88,101,242,.15)); color: var(--accent, #5865f2); }
    .steps { margin: 8px 0 0; padding: 0; list-style: none; font-size: 12px; }
    .steps li { margin-bottom: 8px; }
    .steps code { font-size: 11.5px; }
    .steps pre {
      margin: 4px 0 0; padding: 8px 10px; max-height: 160px; overflow: auto; white-space: pre-wrap;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-size: 11.5px;
    }
  `],
})
export class EnvironmentProvidersComponent {
  private api = inject(ApiService);
  private modal = inject(ModalService);

  providers = signal<ProviderStatus[]>([]);
  loading = signal(true);
  loadError = signal<string | null>(null);
  /** Provider id → what is going on while switching it on/off or starting a recreate. */
  providerBusy = signal<Record<string, string>>({});
  /** The steps the last switch on/off ran, per provider. */
  providerSteps = signal<Record<string, SandboxStep[]>>({});
  /** The last switch on/off or recreate failure, per provider. */
  providerError = signal<Record<string, string>>({});
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  static readonly POLL_MS = 3000;

  constructor() {
    this.load();
    inject(DestroyRef).onDestroy(() => this.stopPolling());
  }

  load(): void {
    this.api.listEnvironments().subscribe({
      next: ({ providers }) => {
        this.providers.set(providers ?? []);
        this.loading.set(false);
        this.loadError.set(null);
        this.schedulePoll();
      },
      error: (e) => {
        this.loading.set(false);
        this.loadError.set(isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'could not load the providers');
      },
    });
  }

  isRecreating(p: ProviderStatus): boolean { return !!p.recreate?.running; }
  failedRecreates(p: ProviderStatus) { return (p.recreate?.results ?? []).filter(r => !r.ok); }
  providerBusyLabel(id: string): string | undefined { return this.providerBusy()[id]; }

  toggleProvider(p: ProviderStatus): void {
    const on = !p.enabled;
    if (on && p.unavailableReason) return;
    const question = on
      ? `Switch ${p.label} on in Huddle?\n\n` +
        `All sandbox network traffic will go through the Huddle firewall. To do that, EVERY sandbox on this machine ` +
        `is recreated — also the ones Huddle did not create. Anything inside a sandbox outside its workspace folders ` +
        `(installed packages, files in the home folder, …) is lost; the workspace folders live on the host and stay.\n\n` +
        `Sandboxes that cannot be recreated are stopped.`
      : `Switch ${p.label} off in Huddle?\n\n` +
        `Sandbox network traffic then no longer goes through the Huddle firewall: ${p.label} gets its own proxy ` +
        `setting back and its daemon is restarted. Huddle will no longer list or create sandboxes.`;
    if (!confirm(question)) return;
    this.setProviderState(p.id, on ? 'Switching on…' : 'Switching off…', [], '');
    this.api.setEnvironmentEnabled(p.id, on).subscribe({
      next: (r) => {
        const failedStep = (r.steps ?? []).find(s => s.code !== 0);
        this.setProviderState(p.id, null, failedStep ? r.steps : [],
          failedStep ? (failedStep.stderr?.trim() || `${failedStep.label} failed`) : '');
        this.modal.notifySandboxesChanged();
        this.load();
      },
      error: (e) => {
        this.setProviderState(p.id, null, [], isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'switching failed');
        this.load();
      },
    });
  }

  recreateAll(p: ProviderStatus): void {
    if (!confirm(`Recreate every ${p.label} sandbox on this machine?\n\n` +
      `This includes sandboxes Huddle did not create. Anything inside a sandbox outside its workspace folders is lost; ` +
      `the workspace folders live on the host and stay. Sandboxes that cannot be recreated are stopped.`)) return;
    this.setProviderState(p.id, 'Starting…', [], '');
    this.api.recreateEnvironment(p.id).subscribe({
      next: () => { this.setProviderState(p.id, null, [], ''); this.modal.notifySandboxesChanged(); this.load(); },
      error: (e) => {
        const msg = isProviderDisabled(e) ? `${p.label} is switched off in Huddle.`
          : isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'recreate failed';
        this.setProviderState(p.id, null, [], msg);
      },
    });
  }

  private setProviderState(id: string, busy: string | null, steps: SandboxStep[], error: string): void {
    const b = { ...this.providerBusy() };
    if (busy) b[id] = busy; else delete b[id];
    this.providerBusy.set(b);
    this.providerSteps.set({ ...this.providerSteps(), [id]: steps });
    this.providerError.set({ ...this.providerError(), [id]: error });
  }

  // Follow a running recreate: ask for the status every few seconds until it is done.
  private schedulePoll(): void {
    this.stopPolling();
    if (!this.providers().some(p => this.isRecreating(p))) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.api.listEnvironments().subscribe({
        next: ({ providers }) => {
          this.providers.set(providers ?? []);
          // Done: the sandboxes were replaced, so lists elsewhere reload.
          if (!this.providers().some(p => this.isRecreating(p))) this.modal.notifySandboxesChanged();
          this.schedulePoll();
        },
        error: () => this.schedulePoll(),
      });
    }, EnvironmentProvidersComponent.POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }
}
