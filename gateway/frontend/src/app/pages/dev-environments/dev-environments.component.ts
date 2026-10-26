import { Component, inject, signal, computed, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import {
  ApiService, HOST_PIPE_OFFLINE_HINT, ProviderStatus, SandboxInfo, SandboxStep, isHostPipeOffline, isProviderDisabled,
} from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';

type EnvType = 'container' | 'sandbox';
/** An available provider whose sandbox listing failed, with the API's message. */
interface ProviderFailure { id: string; label: string; error: string; }
interface EnvRow {
  type: EnvType;
  name: string;
  /** Environment provider id for sandboxes ('sbx'); '' for containers. */
  provider: string;
  /** What the type badge says: 'Container' or the provider's label. */
  typeLabel: string;
  short: string;
  statusLabel: string;
  running: boolean;
  requested: number;
  /** Host folders a sandbox was created with, joined for display. */
  workspaces?: string;
  /** Sandbox created by Huddle; only those can be removed from here. */
  managed?: boolean;
}

// Dev Environments — one list for devcontainers and the sandboxes of every
// environment provider (GET /api/environments). Every row opens its detail page.
@Component({
  selector: 'app-dev-environments',
  standalone: true,
  imports: [RouterLink, NgClass],
  templateUrl: './dev-environments.component.html',
  styleUrls: ['./dev-environments.component.css'],
})
export class DevEnvironmentsComponent {
  private state = inject(StateService);
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private router = inject(Router);
  modal = inject(ModalService);

  private containers = signal<Container[]>([]);
  private sandboxes = signal<SandboxInfo[]>([]);
  providers = signal<ProviderStatus[]>([]);
  private rules = signal<Rule[]>([]);
  loadingSandboxes = signal(false);
  sandboxesLoaded = signal(false);

  busy = signal<Record<string, string>>({});
  notice = signal<string | null>(null);

  /** Provider id → what is going on while switching it on/off or starting a recreate. */
  providerBusy = signal<Record<string, string>>({});
  /** The steps the last switch on/off ran, per provider. */
  providerSteps = signal<Record<string, SandboxStep[]>>({});
  /** The last switch on/off or recreate failure, per provider. */
  providerError = signal<Record<string, string>>({});
  private pollTimer: ReturnType<typeof setTimeout> | null = null;

  rows = computed<EnvRow[]>(() => {
    const rules = this.rules();
    // Firewall scope: the container name, or `<provider>:<name>` for a sandbox.
    const reqOf = (scope: string) => rules.filter(r => r.container_id === scope && r.status === 'requested').length;
    const containerRows: EnvRow[] = this.containers().map(c => {
      const running = (c.status || '').toLowerCase().includes('up');
      return { type: 'container', name: c.name, provider: '', typeLabel: 'Container', short: c.name.replace(/^devcontainer-/, ''),
        statusLabel: running ? 'Running' : 'Stopped', running, requested: reqOf(c.name) };
    });
    const labels = new Map(this.providers().map(p => [p.id, p.label]));
    const sandboxRows: EnvRow[] = this.sandboxes().map(s => {
      const running = /up|run/i.test(s.status || '');
      return { type: 'sandbox', name: s.name, provider: s.provider, typeLabel: labels.get(s.provider) || s.provider, short: s.name,
        statusLabel: running ? 'Running' : (s.status || 'Stopped'), running, requested: reqOf(`${s.provider}:${s.name}`),
        workspaces: s.workspaces?.join(', ') || undefined, managed: s.managed };
    });
    return [...containerRows, ...sandboxRows].sort((a, b) => a.short.localeCompare(b.short));
  });

  /** Providers that could not be asked for their sandboxes, with why. */
  unavailable = computed(() => this.providers().filter(p => p.enabled && !p.available));
  /** Available providers whose sandbox listing failed on the last refresh; their last known rows stay. */
  failed = signal<ProviderFailure[]>([]);

  constructor() {
    this.state.containers$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(c => this.containers.set(c));
    this.state.rules$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(r => this.rules.set(r));
    this.refreshSandboxes();
    // Refresh the sandbox list whenever the create/remove modal reports a change.
    let first = true;
    effect(() => {
      this.modal.sandboxesTick();
      if (first) { first = false; return; } // skip the initial value (constructor already loaded)
      this.refreshSandboxes();
    });
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  refreshSandboxes(): void {
    // Listing goes through the host agent and can take a few seconds — show a
    // loading indicator so it doesn't look empty/stuck. One failing provider
    // must not hide the sandboxes of the others.
    this.loadingSandboxes.set(true);
    const done = (providers: ProviderStatus[], sandboxes: SandboxInfo[], failed: ProviderFailure[] = []) => {
      this.providers.set(providers);
      this.failed.set(failed);
      this.sandboxes.set(sandboxes);
      this.loadingSandboxes.set(false);
      this.sandboxesLoaded.set(true);
      this.schedulePoll();
    };
    this.api.listEnvironments().subscribe({
      next: ({ providers }) => {
        // A provider switched off in Huddle has no sandboxes to list from here.
        const available = (providers ?? []).filter(p => p.available && p.enabled);
        if (!available.length) { done(providers ?? [], []); return; }
        const failed: ProviderFailure[] = [];
        forkJoin(available.map(p => this.api.listSandboxes(p.id).pipe(
          // Older/odd providers may leave `provider` out; the row needs it to remove.
          map(r => (r.sandboxes ?? []).map(s => ({ ...s, provider: s.provider || p.id }))),
          // A failed listing is not "no sandboxes": keep what we last saw and say so.
          catchError(e => {
            // Switched off between the status call and the listing: nothing to show, no error.
            if (isProviderDisabled(e)) return of([]);
            failed.push({ id: p.id, label: p.label, error: isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'unknown error' });
            return of(this.sandboxes().filter(s => s.provider === p.id));
          }),
        ))).subscribe(lists => done(providers, lists.flat(), failed));
      },
      error: (e) => {
        done([], []);
        this.notice.set(`Sandboxes unavailable: ${isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'unknown error'}`);
      },
    });
  }

  private setBusy(name: string, label: string | null): void {
    const b = { ...this.busy() };
    if (label) b[name] = label; else delete b[name];
    this.busy.set(b);
  }
  isBusy(name: string): string | undefined { return this.busy()[name]; }

  detailLink(row: EnvRow): string[] {
    return row.type === 'container'
      ? ['/dev-environments', 'container', row.name]
      : ['/dev-environments', 'sandbox', row.provider, row.name];
  }

  openDetail(row: EnvRow): void {
    this.router.navigate(this.detailLink(row));
  }

  // container actions
  startContainer(name: string): void { this.api.resumeContainer(name).subscribe(() => this.state.loadAll()); }
  deleteContainer(name: string): void { if (confirm(`Delete container "${name}"?`)) this.api.deleteContainer(name).subscribe(() => this.state.loadAll()); }
  snapshot(name: string): void { this.modal.openSnapshot(name); }

  // sandbox actions (create is handled by the shared "Create dev environment" modal)
  deleteSandbox(row: EnvRow): void {
    if (!confirm(`Remove sandbox "${row.name}"? This deletes the sandbox and everything inside it.`)) return;
    this.setBusy(row.name, 'Removing…');
    this.api.removeSandbox(row.provider, row.name, true).subscribe({
      next: () => { this.setBusy(row.name, null); this.refreshSandboxes(); },
      error: (e) => {
        this.setBusy(row.name, null);
        if (isProviderDisabled(e)) { this.notice.set(`${row.typeLabel} is switched off in Huddle.`); this.refreshSandboxes(); return; }
        this.notice.set('✗ ' + (e?.message || 'remove failed'));
      },
    });
  }

  // ── Provider on/off and recreate ──────────────────────────────────────────
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
      },
      error: (e) => {
        this.setProviderState(p.id, null, [], isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : e?.message || 'switching failed');
        this.refreshSandboxes();
      },
    });
  }

  recreateAll(p: ProviderStatus): void {
    if (!confirm(`Recreate every ${p.label} sandbox on this machine?\n\n` +
      `This includes sandboxes Huddle did not create. Anything inside a sandbox outside its workspace folders is lost; ` +
      `the workspace folders live on the host and stay. Sandboxes that cannot be recreated are stopped.`)) return;
    this.setProviderState(p.id, 'Starting…', [], '');
    this.api.recreateEnvironment(p.id).subscribe({
      next: () => { this.setProviderState(p.id, null, [], ''); this.refreshSandboxes(); },
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

  // While a recreate runs, ask for the provider status every few seconds; once
  // it is done, reload the whole list (the sandboxes were replaced).
  private schedulePoll(): void {
    this.stopPolling();
    if (!this.providers().some(p => this.isRecreating(p))) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.api.listEnvironments().subscribe({
        next: ({ providers }) => {
          const list = providers ?? [];
          if (list.some(p => this.isRecreating(p))) { this.providers.set(list); this.schedulePoll(); }
          else this.refreshSandboxes();
        },
        error: () => this.schedulePoll(),
      });
    }, DevEnvironmentsComponent.POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) { clearTimeout(this.pollTimer); this.pollTimer = null; }
  }

  static readonly POLL_MS = 3000;
}
