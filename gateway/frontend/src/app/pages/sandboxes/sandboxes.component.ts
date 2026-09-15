import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import {
  ApiService,
  SbxStatus,
  SbxStartResult,
  SandboxInfo,
  SbxReconcileReport,
  SbxCommandResult,
  SbxSettingsFolders,
} from '../../core/services/api.service';
import { Rule } from '../../core/models/rule.model';

// Sandboxes — the parallel "second box type" next to Containers, same table
// layout. Create a Docker Sandbox microVM, open it in VS Code / JetBrains via
// clickable deep links, and let Huddle keep the firewall rules in sync (auto).
@Component({
  selector: 'app-sandboxes',
  standalone: true,
  imports: [FormsModule, NgClass, RouterLink],
  templateUrl: './sandboxes.component.html',
  styleUrls: ['./sandboxes.component.css'],
})
export class SandboxesComponent {
  private api = inject(ApiService);

  status = signal<SbxStatus | null>(null);
  sandboxes = signal<SandboxInfo[]>([]);
  rules = signal<Rule[]>([]);
  loading = signal(false);
  error = signal<string | null>(null);

  showCreate = signal(false);
  newName = signal('');
  newAgent = signal('claude');
  // A sandbox can hold several folders: the first is the one the agent starts in,
  // the rest ride along. sbx mounts each folder at its own host path, so there is
  // no container path to choose (unlike a devcontainer mount).
  newFolders = signal<{ path: string; readOnly: boolean }[]>([{ path: '', readOnly: false }]);
  creating = signal(false);
  createError = signal<SbxStartResult | null>(null);
  /** Settings folders (folder mappings) every new sandbox gets — shown in the form. */
  settingsFolders = signal<SbxSettingsFolders | null>(null);

  busy = signal<Record<string, string>>({});
  msg = signal<Record<string, string>>({});

  syncing = signal(false);
  report = signal<SbxReconcileReport | null>(null);
  showReport = signal(false);

  ready = computed(() => !!this.status()?.available);

  constructor() {
    this.refresh();
    this.api.sbxSettingsFolders().subscribe({
      next: (s) => this.settingsFolders.set(s),
      error: () => this.settingsFolders.set(null),
    });
  }

  addFolder(): void {
    this.newFolders.set([...this.newFolders(), { path: '', readOnly: false }]);
  }

  removeFolder(i: number): void {
    const next = this.newFolders().filter((_, idx) => idx !== i);
    this.newFolders.set(next.length ? next : [{ path: '', readOnly: false }]);
  }

  setFolderPath(i: number, path: string): void {
    this.newFolders.set(this.newFolders().map((f, idx) => (idx === i ? { ...f, path } : f)));
  }

  setFolderReadOnly(i: number, readOnly: boolean): void {
    this.newFolders.set(this.newFolders().map((f, idx) => (idx === i ? { ...f, readOnly } : f)));
  }

  refresh(): void {
    this.api.sbxStatus().subscribe({ next: (s) => this.status.set(s), error: () => this.status.set(null) });
    this.loading.set(true);
    this.error.set(null);
    this.api.listSbxSandboxes().subscribe({
      next: (r) => { this.sandboxes.set(r.sandboxes ?? []); this.loading.set(false); },
      error: (e) => { this.error.set(e?.error?.error || e?.message || 'Could not list sandboxes'); this.loading.set(false); },
    });
    this.api.getRules({ status: 'requested' }).subscribe({ next: (rs) => this.rules.set(rs), error: () => {} });
  }

  running(s: SandboxInfo): boolean { return /up|run/i.test(s.status || ''); }
  requestedCount(name: string): number { return this.rules().filter(r => r.container_id === name && r.status === 'requested').length; }

  // ── clickable IDE deep links ──────────────────────────────────────────────
  sshHost(name: string): string { return `${name}.sbx`; }
  vscodeLink(name: string): string { return `vscode://vscode-remote/ssh-remote+root@${this.sshHost(name)}/root`; }
  jetbrainsLink(name: string): string {
    return `jetbrains://gateway/ssh/environment?h=${encodeURIComponent(this.sshHost(name))}&u=root&p=22&launchIde=true`;
  }

  create(): void {
    const workspaces = this.newFolders()
      .map((f) => ({ path: f.path.trim(), readOnly: f.readOnly === true }))
      .filter((f) => f.path !== '');
    if (workspaces.length === 0) { this.error.set('Add at least one folder'); return; }
    this.creating.set(true);
    this.createError.set(null);
    this.error.set(null);
    this.api.startSbx({
      name: this.newName().trim() || undefined,
      agent: this.newAgent().trim() || undefined,
      workspaces,
    }).subscribe({
      next: (r) => {
        this.creating.set(false);
        if (r.ok) { this.newName.set(''); this.newFolders.set([{ path: '', readOnly: false }]); this.showCreate.set(false); }
        else this.createError.set(r);
        this.refresh();
      },
      error: (e) => { this.creating.set(false); this.error.set(e?.error?.error || e?.message || 'Create failed'); },
    });
  }

  private setBusy(name: string, label: string | null): void {
    const b = { ...this.busy() };
    if (label) b[name] = label; else delete b[name];
    this.busy.set(b);
  }
  isBusy(name: string): string | undefined { return this.busy()[name]; }
  private setMsg(name: string, m: string): void { this.msg.set({ ...this.msg(), [name]: m }); }
  msgFor(name: string): string | undefined { return this.msg()[name]; }

  trustCa(name: string): void {
    this.setBusy(name, 'Installing CA…');
    this.api.sbxTrustCa(name).subscribe({
      next: (r: SbxCommandResult) => { this.setBusy(name, null); this.setMsg(name, r.ok ? '✓ CA installed — reconnect your editor' : `✗ CA failed (exit ${r.code})`); },
      error: (e) => { this.setBusy(name, null); this.setMsg(name, '✗ ' + (e?.error?.error || 'CA install failed')); },
    });
  }
  sshSetup(): void {
    this.setBusy('__ssh__', 'Enabling SSH bridge…');
    this.api.sbxSshSetup().subscribe({
      next: (r) => { this.setBusy('__ssh__', null); this.setMsg('__ssh__', r.ok ? '✓ SSH bridge ready' : `✗ ssh setup failed (exit ${r.exitCode ?? r.code})`); },
      error: (e) => { this.setBusy('__ssh__', null); this.setMsg('__ssh__', '✗ ' + (e?.error?.error || 'ssh setup failed')); },
    });
  }
  remove(name: string): void {
    if (!confirm(`Remove sandbox "${name}"? This deletes the microVM.`)) return;
    this.setBusy(name, 'Removing…');
    this.api.removeSbxSandbox(name, true).subscribe({
      next: () => { this.setBusy(name, null); this.refresh(); },
      error: (e) => { this.setBusy(name, null); this.setMsg(name, '✗ ' + (e?.error?.error || 'remove failed')); },
    });
  }

  syncNow(): void {
    this.syncing.set(true);
    this.report.set(null);
    this.api.sbxReconcile(false).subscribe({
      next: (r) => { this.report.set(r); this.syncing.set(false); this.showReport.set(true); this.refresh(); },
      error: (e) => { this.syncing.set(false); this.error.set(e?.error?.error || e?.message || 'Sync failed'); },
    });
  }
  scopeLabel(s: { kind: string; name?: string }): string { return s.kind === 'sandbox' && s.name ? `sandbox:${s.name}` : 'global'; }
}
