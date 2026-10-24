import { Component, inject, signal, computed, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { forkJoin, of } from 'rxjs';
import { catchError, map } from 'rxjs/operators';
import { ApiService, HOST_PIPE_OFFLINE_HINT, ProviderStatus, SandboxInfo, isHostPipeOffline } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';

type EnvType = 'container' | 'sandbox';
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
// environment provider (GET /api/environments). Container rows open the
// container detail; sandbox rows have no detail page yet.
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
  private providers = signal<ProviderStatus[]>([]);
  private rules = signal<Rule[]>([]);
  loadingSandboxes = signal(false);
  sandboxesLoaded = signal(false);

  busy = signal<Record<string, string>>({});
  notice = signal<string | null>(null);

  rows = computed<EnvRow[]>(() => {
    const rules = this.rules();
    const reqOf = (name: string) => rules.filter(r => r.container_id === name && r.status === 'requested').length;
    const containerRows: EnvRow[] = this.containers().map(c => {
      const running = (c.status || '').toLowerCase().includes('up');
      return { type: 'container', name: c.name, provider: '', typeLabel: 'Container', short: c.name.replace(/^devcontainer-/, ''),
        statusLabel: running ? 'Running' : 'Stopped', running, requested: reqOf(c.name) };
    });
    const labels = new Map(this.providers().map(p => [p.id, p.label]));
    const sandboxRows: EnvRow[] = this.sandboxes().map(s => {
      const running = /up|run/i.test(s.status || '');
      return { type: 'sandbox', name: s.name, provider: s.provider, typeLabel: labels.get(s.provider) || s.provider, short: s.name,
        statusLabel: running ? 'Running' : (s.status || 'Stopped'), running, requested: reqOf(s.name),
        workspaces: s.workspaces?.join(', ') || undefined, managed: s.managed };
    });
    return [...containerRows, ...sandboxRows].sort((a, b) => a.short.localeCompare(b.short));
  });

  /** Providers that could not be asked for their sandboxes, with why. */
  unavailable = computed(() => this.providers().filter(p => !p.available));

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
  }

  refreshSandboxes(): void {
    // Listing goes through the host agent and can take a few seconds — show a
    // loading indicator so it doesn't look empty/stuck. One failing provider
    // must not hide the sandboxes of the others.
    this.loadingSandboxes.set(true);
    const done = (providers: ProviderStatus[], sandboxes: SandboxInfo[]) => {
      this.providers.set(providers);
      this.sandboxes.set(sandboxes);
      this.loadingSandboxes.set(false);
      this.sandboxesLoaded.set(true);
    };
    this.api.listEnvironments().subscribe({
      next: ({ providers }) => {
        const available = (providers ?? []).filter(p => p.available);
        if (!available.length) { done(providers ?? [], []); return; }
        forkJoin(available.map(p => this.api.listSandboxes(p.id).pipe(
          // Older/odd providers may leave `provider` out; the row needs it to remove.
          map(r => (r.sandboxes ?? []).map(s => ({ ...s, provider: s.provider || p.id }))),
          catchError(() => of([] as SandboxInfo[])),
        ))).subscribe(lists => done(providers, lists.flat()));
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

  openDetail(row: EnvRow): void {
    if (row.type === 'container') this.router.navigate(['/container', row.name]);
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
      error: (e) => { this.setBusy(row.name, null); this.notice.set('✗ ' + (e?.message || 'remove failed')); },
    });
  }
}
