import { Component, inject, signal, computed, effect, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService, SandboxInfo } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';

type EnvType = 'container' | 'sandbox';
interface EnvRow {
  type: EnvType;
  name: string;
  short: string;
  statusLabel: string;
  running: boolean;
  requested: number;
}

// Dev Environments — one list for BOTH runtimes. Each row is typed container or
// sandbox; the row opens the shared detail (firewall + terminal always; Docker +
// admin only for containers).
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
  modal = inject(ModalService);

  private containers = signal<Container[]>([]);
  private sandboxes = signal<SandboxInfo[]>([]);
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
      return { type: 'container', name: c.name, short: c.name.replace(/^devcontainer-/, ''),
        statusLabel: running ? 'Running' : 'Stopped', running, requested: reqOf(c.name) };
    });
    const sandboxRows: EnvRow[] = this.sandboxes().map(s => {
      const running = /up|run/i.test(s.status || '');
      return { type: 'sandbox', name: s.name, short: s.name,
        statusLabel: running ? 'Running' : (s.status || 'Stopped'), running, requested: reqOf(s.name) };
    });
    return [...containerRows, ...sandboxRows].sort((a, b) => a.short.localeCompare(b.short));
  });

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
    // `sbx ls` runs over the host-agent/mailbox and can take a few seconds — show
    // a loading indicator so it doesn't look empty/stuck.
    this.loadingSandboxes.set(true);
    this.api.listSbxSandboxes().subscribe({
      next: r => { this.sandboxes.set(r.sandboxes ?? []); this.loadingSandboxes.set(false); this.sandboxesLoaded.set(true); },
      error: () => { this.sandboxes.set([]); this.loadingSandboxes.set(false); this.sandboxesLoaded.set(true); },
    });
  }

  private setBusy(name: string, label: string | null): void {
    const b = { ...this.busy() };
    if (label) b[name] = label; else delete b[name];
    this.busy.set(b);
  }
  isBusy(name: string): string | undefined { return this.busy()[name]; }

  // container actions
  startContainer(name: string): void { this.api.resumeContainer(name).subscribe(() => this.state.loadAll()); }
  deleteContainer(name: string): void { if (confirm(`Delete container "${name}"?`)) this.api.deleteContainer(name).subscribe(() => this.state.loadAll()); }
  snapshot(name: string): void { this.modal.openSnapshot(name); }

  // sandbox actions (create is handled by the shared "Create dev environment" modal)
  deleteSandbox(name: string): void {
    if (!confirm(`Remove sandbox "${name}"? This deletes the microVM.`)) return;
    this.setBusy(name, 'Removing…');
    this.api.removeSbxSandbox(name, true).subscribe({
      next: () => { this.setBusy(name, null); this.refreshSandboxes(); },
      error: (e) => { this.setBusy(name, null); this.notice.set('✗ ' + (e?.error?.error || 'remove failed')); },
    });
  }
}
