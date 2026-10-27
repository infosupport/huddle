import { Component, inject, effect, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ModalService } from '../../../core/services/modal.service';
import {
  ApiService, HOST_PIPE_OFFLINE_HINT, ProviderStatus, SandboxStep, isHostPipeOffline, isProviderDisabled,
} from '../../../core/services/api.service';
import { FolderSelectComponent } from '../../components/folder-select/folder-select.component';
import { FolderPickerModalComponent } from '../folder-picker-modal/folder-picker-modal.component';
import { IconComponent } from '../../components/icon/icon.component';

// Remembers the last-used sandbox folders so the modal pre-fills them next time.
const REMEMBER_KEY = 'huddle.sandbox-modal.v1';

// Same rule the gateway enforces on sandbox names (docs/host-pipe.md).
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface RememberedLayout { mounts?: { hostPath: string; readOnly: boolean }[]; }

/** One sandbox folder. It is mounted at its own host path, so there is no target to pick. */
interface FolderRow { hostPath: string; readOnly: boolean; }

// Create a sandbox with one environment provider (Docker Sandbox today). Opened
// from that provider's "+" on Dev Environments, so there is no type to choose.
@Component({
  selector: 'app-create-sandbox-modal',
  standalone: true,
  imports: [FormsModule, RouterLink, FolderSelectComponent, FolderPickerModalComponent, IconComponent],
  templateUrl: './create-sandbox-modal.component.html',
  styles: [`
    /* ── Modal chrome — ported from the create-modal.html mockup (.ce-* rules),
       scoped to this component so it doesn't touch other modals' shared
       .modal-box/.modal-header/.modal-body classes. ────────────────────────── */
    .modal-box.sc-xwide {
      width: min(94vw, 1130px); border-radius: 18px;
      max-height: 90vh; display: flex; flex-direction: column; overflow: hidden;
    }
    .modal-header {
      align-items: flex-start; gap: 16px; padding: 22px 24px 18px;
    }
    .modal-header h2 {
      font-family: 'Space Grotesk', sans-serif; font-size: 20px; font-weight: 600;
      letter-spacing: -.2px; color: var(--text); margin: 0;
    }
    .modal-close {
      width: 32px; height: 32px; border-radius: 9px; display: grid; place-items: center;
      padding: 0; margin-top: 2px;
    }
    .modal-close:hover { background: var(--surface-hover); }
    .modal-body { padding: 0; gap: 0; flex: 1; min-height: 0; overflow: hidden; }
    /* The grid itself carries no padding — each .sc-col owns its own (see
       below), so the divider border between them sits flush against each
       column's own padding on either side. Everything else that can land
       directly in .modal-body (submit error/status) still needs an explicit
       margin since there's no ambient padding here for them to inherit. */
    .modal-body > .form-error, .modal-body > .form-status { margin: 0 24px 16px; }

    /* ── Base field controls — the mockup's .ce-input/.ce-select/.ce-textarea ── */
    input[type="text"], input[type="number"], select {
      width: 100%; height: 42px; padding: 0 13px; border: 1px solid var(--border-strong);
      border-radius: 10px; background: var(--surface); color: var(--text); font: inherit; font-size: 14px;
    }
    input[type="text"]::placeholder { color: var(--text-dim); }
    input[type="text"]:focus, input[type="number"]:focus, select:focus {
      outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
    }
    select {
      appearance: none; cursor: pointer; padding-right: 36px;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236c7385' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
      background-repeat: no-repeat; background-position: right 12px center;
    }
    .mount-row input { height: 36px; font-size: 12.5px; }

    /* ── Buttons — accent-colored icons to match .ce-btn ─────────────────────── */
    /* Targets app-icon (the HOST element), not svg: the <svg> lives inside
       app-icon's OWN template, so under Angular's emulated encapsulation a
       scoped ".btn svg" compiles to ".btn[_ngcontent-X] svg[_ngcontent-X]" —
       both sides get THIS component's attribute, but the svg only ever carries
       app-icon's attribute, so it can never match. app-icon itself does belong
       to this template, so styling it and letting color inherit into the
       icon's stroke='currentColor' is the only way to reach it from here. */
    .btn app-icon { color: var(--accent); }
    .btn-primary app-icon { color: #fff; }
    .sc-map-x {
      flex: 0 0 auto; width: 34px; height: 34px; border-radius: 9px; border: 1px solid transparent;
      background: transparent; color: var(--text-dim); display: grid; place-items: center; cursor: pointer;
    }
    .sc-map-x:hover { background: var(--danger-soft); color: var(--danger); }
    .sc-map-x:disabled { opacity: .4; cursor: not-allowed; }

    /* margin-bottom, not gap on the parent: consecutive rows need space
       between them, but this collapses (max, not sum) with .mount-add's own
       margin-top: 11px below the last row — since 8px < 11px that collapsed
       margin stays 11px, so the "Add folder" button doesn't end up doubly
       spaced away from the last row. */
    .mount-row { display: flex; gap: .5rem; align-items: center; margin-bottom: 8px; }
    .mount-row .mount-host { flex: 1; min-width: 0; }
    .mount-row .mount-arrow { flex: 0 0 auto; color: var(--text-dim); }
    .mount-row input { flex: 1; min-width: 0; }
    .mount-row .btn { flex: 0 0 auto; }
    .mount-hint { font-size: 12px; margin: 7px 0 0; }
    .mount-add { display: flex; gap: 9px; margin-top: 11px; }
    .mount-row .ro-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: .3rem; font-size: 11.5px; color: var(--text-muted); }
    /* Project-folder rows only: host path and the container-path group (arrow
       + editable path + read-only toggle) sit side by side as two flex items,
       each with its own flex-basis, in a row that's allowed to wrap. When the
       column is wide enough both fit on one line; when it isn't, flex-wrap
       breaks the line BETWEEN the two items (neither item's own children wrap
       internally), so host path drops to its own line and the arrow+path+
       toggle group moves to the next line as one unit — exactly the "split
       before the arrow" layout, with no media query needed. The remove button
       is a third, non-shrinking item that wraps along with whichever line has
       room for it. */
    .mount-row.sc-mount-row { flex-wrap: wrap; }
    .mount-row.sc-mount-row .mount-host { flex: 1 1 200px; min-width: 0; }
    /* The container-path group: a chevron, and the path field itself (an
       input plus its own read-only toggle button, attached to the trailing
       edge of the input rather than sitting beside the whole row — it's the
       path's own toggle, not the row's). */
    .mount-target { display: flex; align-items: center; gap: 8px; flex: 1 1 220px; min-width: 0; }
    /* The read-only toggle lives INSIDE the destination-path input rather
       than beside it — same absolute-positioned-over-the-field technique as
       the IDE-select logo below (.sc-select-wrap--icon) and
       FolderSelectComponent's browseMode="icon" (position: relative
       wrapper, absolutely positioned control, extra input padding so text
       never runs under it) — kept consistent with those two rather than
       inventing a third variant. */
    .mount-path-field { position: relative; flex: 1; min-width: 0; }
    .mount-path-field input { width: 100%; padding-right: 34px; }
    .mount-ro-toggle {
      position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
      width: 26px; height: 26px; padding: 0; border-radius: 7px; border: 1px solid transparent;
      background: transparent; color: var(--text-dim); display: grid; place-items: center; cursor: pointer;
    }
    .mount-ro-toggle:hover { background: var(--surface-hover); color: var(--accent); border-color: var(--border-strong); }
    /* Subtle tint on the destination-path field, gated on containerPath being
       non-empty (mount-target-input--tint) — an untouched row (no source
       folder picked yet) shows no tint and no toggle at all, see the
       @if around the toggle button in the template. Once a path exists:
       orange (--accent-soft) = writable (the default), blue (--info-soft) =
       read-only ("safe"). A soft bottom-up gradient rather than a flat fill,
       so it reads as a hint rather than a solid color block — and it doesn't
       fight the :focus rule above (that rule owns box-shadow/border-color
       for the ring; this rule only ever touches the background property, so
       the two never clobber each other when a tinted field is focused). */
    .mount-target input.mount-target-input--tint {
      background: linear-gradient(to top, var(--accent-soft), transparent 25%);
    }
    .mount-target input.mount-target-input--tint.mount-target-input--ro {
      background: linear-gradient(to top, var(--info-soft), transparent 25%);
    }

    /* ── Split "Add folder" button ──────────────────────────── */
    .sc-split-btn { position: relative; display: inline-flex; }
    .sc-split-btn .sc-split-main { border-top-right-radius: 0; border-bottom-right-radius: 0; }
    .sc-split-btn .sc-split-chevron { border-top-left-radius: 0; border-bottom-left-radius: 0; border-left: 0; padding: 0 8px; }
    .sc-split-menu {
      position: absolute; top: 100%; right: 0; margin-top: 4px; min-width: 130px; z-index: 20;
      display: flex; flex-direction: column; gap: 1px; padding: 4px;
      background: var(--surface); border: 1px solid var(--border-strong); border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.16);
    }
    .sc-split-menu button {
      border: 0; background: none; text-align: left; padding: 7px 9px; border-radius: 7px;
      font-size: 12.5px; color: var(--text); cursor: pointer; white-space: nowrap;
    }
    .sc-split-menu button:hover { background: var(--surface-hover); }
    /* ── Environment-type cards ───────────────────────────────────────────── */
    .sc-head-icon {
      width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
      background: var(--accent-soft); color: var(--accent); display: grid; place-items: center;
    }
    .sc-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .sc-head-text h2 { flex: unset; }
    .sc-head-text p { margin: 3px 0 0; font-size: 13.5px; color: var(--text-muted); font-weight: 400; }

    /* ── Two-column layout ─────────────────────────────── */
    .sc-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.05fr); gap: 0; flex: 1; min-height: 0; overflow: hidden; }
    @media (max-width: 760px) { .sc-grid { grid-template-columns: 1fr; } }
    /* Padding lives on the column itself (not the grid, which has gap: 0 and
       no padding of its own) — a border here is a border of THIS box, so it
       sits at the box's outer edge with the column's own padding inside it
       on both sides. No matching removal is needed anywhere else: standard
       box model (content -> padding -> border -> margin), nothing doubles up. */
    .sc-col { overflow-y: auto; min-height: 0; padding: 22px 24px 26px; }
    .sc-col + .sc-col { border-left: 1px solid var(--border); background: var(--surface-2); }
    .sc-col-title { font-family: 'Space Grotesk', sans-serif; font-size: 16.5px; font-weight: 600; margin: 0; color: var(--text); }
    .sc-col-sub { font-size: 12.5px; margin: 3px 0 20px; }
    .sc-col-head { display: flex; align-items: flex-start; flex-wrap: wrap; gap: 10px 14px; margin-bottom: 20px; }
    .sc-col-head > div { flex: 1 1 220px; min-width: 0; }
    .sc-col-head .btn { flex: none; margin-left: auto; }
    .sc-field { margin-bottom: 12px; }
    .sc-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 7px; color: var(--text); }
    /* ── Provider steps when a create failed ─────────────────────────────────── */
    .sc-steps { margin: 0 24px 16px; padding: 0; list-style: none; font-size: 12px; }
    .sc-steps li { margin-bottom: 8px; }
    .sc-steps code { font-size: 11.5px; }
    .sc-steps pre {
      margin: 4px 0 0; padding: 8px 10px; max-height: 160px; overflow: auto; white-space: pre-wrap;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-size: 11.5px;
    }

    /* ── Footer panel ────────────────────────────────────────────────────────── */
    .sc-foot-panel { justify-content: space-between; align-items: center; padding: 14px 22px; background: var(--surface-2); }
    .sc-foot-art { flex: none; margin: -10px 0; }
    .sc-foot-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .sc-foot-text b { font-size: 13.5px; color: var(--text); }
    .sc-foot-text span { font-size: 12.5px; color: var(--text-muted); }
    .sc-foot-actions { display: flex; gap: 10px; }
  `]
})
export class CreateSandboxModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);

  /** The provider this modal was opened for, once GET /api/environments answered. */
  provider: ProviderStatus | null = null;
  /** Set when the providers could not be listed at all (host agent offline, …). */
  providersError = '';
  providersLoaded = false;

  // A sandbox can hold several folders: the FIRST is the one the agent starts
  // in (never read-only, docs/host-pipe.md), the rest ride along.
  mounts: FolderRow[] = [this.newRow()];
  sbxName = '';
  sbxAgent = '';
  // What the provider ran, shown when creating the sandbox failed.
  sandboxSteps: SandboxStep[] = [];
  folderPickerOpen = false;
  // The split "Add folder" button's little "Browse..." menu.
  addMenuOpen = false;
  error = '';
  status = '';
  loading = false;

  get open() { return this.modalService.sandboxProvider() !== null; }

  /** A provider sandboxes can be created with right now: switched on and reachable. */
  get usable(): boolean { return !!this.provider && this.provider.enabled && this.provider.available; }

  /** Why the provider cannot be used right now, or '' when it can. */
  get unusableHint(): string {
    if (this.providersError) return `Sandboxes unavailable: ${this.providersError}`;
    const p = this.provider;
    if (!this.providersLoaded || this.usable) return '';
    if (!p) return 'This environment type is not available.';
    if (!p.enabled) return `${p.label} is switched off in Huddle.`;
    return `${p.label} unavailable: ${p.error || 'not available on this host.'}`;
  }

  constructor() {
    effect(() => {
      const id = this.modalService.sandboxProvider();
      if (id !== null) this.onOpen(id);
    });
  }

  private newRow(hostPath = '', readOnly = false): FolderRow { return { hostPath, readOnly }; }

  onOpen(providerId: string): void {
    this.mounts = [this.newRow()];
    this.addMenuOpen = false;
    this.folderPickerOpen = false;
    this.sbxName = '';
    this.sbxAgent = '';
    this.sandboxSteps = [];
    this.error = '';
    this.status = '';
    this.loading = false;
    this.restoreRemembered();
    this.loadProvider(providerId);
  }

  private loadProvider(providerId: string): void {
    this.provider = null;
    this.providersError = '';
    this.providersLoaded = false;
    this.api.listEnvironments().subscribe({
      next: (r) => {
        this.provider = (r.providers ?? []).find((p) => p.id === providerId) ?? null;
        this.providersLoaded = true;
        if (this.provider && !this.provider.agents.includes(this.sbxAgent)) this.sbxAgent = this.provider.agents[0] ?? '';
      },
      error: (e) => {
        this.providersLoaded = true;
        this.providersError = isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : (e?.message || 'Environment providers could not be listed.');
      },
    });
  }

  addMount(): void { this.mounts.push(this.newRow()); }

  // The split "Add folder" button's chevron segment: opens/closes the tiny
  // "Browse..." menu. stopPropagation so the same click that opens it doesn't
  // also reach the document:click listener below and instantly close it again.
  toggleAddMenu(ev: Event): void {
    ev.stopPropagation();
    this.addMenuOpen = !this.addMenuOpen;
  }

  openFolderPicker(): void {
    this.addMenuOpen = false;
    this.folderPickerOpen = true;
  }

  @HostListener('document:click') onDocClick(): void {
    if (this.addMenuOpen) this.addMenuOpen = false;
  }
  @HostListener('window:scroll') @HostListener('window:resize') onViewportChange(): void {
    this.addMenuOpen = false;
  }

  // Browse once, Ctrl-click the folders, and every one of them lands as its own
  // row. Purely additive: filled rows stay, a folder already there is not added twice.
  onFoldersPicked(paths: string[]): void {
    this.folderPickerOpen = false;
    const known = new Set(this.mounts.map((m) => m.hostPath.trim().toLowerCase()).filter(Boolean));
    for (const path of paths) {
      if (known.has(path.toLowerCase())) continue;
      known.add(path.toLowerCase());
      let row = this.mounts.find((m) => !m.hostPath.trim());
      if (!row) {
        row = this.newRow();
        this.mounts.push(row);
      }
      row.hostPath = path;
    }
    this.fixPrimary();
  }

  removeMount(i: number): void {
    this.mounts.splice(i, 1);
    if (this.mounts.length === 0) this.mounts.push(this.newRow());
    this.fixPrimary();
  }

  /** Same from a folder row: the first folder fills the row, the rest add rows. */
  onMountPicked(paths: string[]): void {
    if (paths.length > 1) this.onFoldersPicked(paths.slice(1));
  }

  onHostPathInput(row: FolderRow, value: string): void { row.hostPath = value; }

  // The first folder is the primary workspace and can never be read-only.
  // Corrected here rather than only hidden in the template: a row can arrive at
  // index 0 already read-only (a row above it was removed).
  private fixPrimary(): void { if (this.mounts[0]) this.mounts[0].readOnly = false; }

  /** Tooltip/aria-label for a folder row's icon-only read-only toggle. */
  mountRoLabel(m: FolderRow): string {
    return m.readOnly ? 'Read-only — click to allow writes' : 'Writable — click to make read-only';
  }

  /** Every folder but the primary one can be made read-only. */
  showRoToggle(m: FolderRow, i: number): boolean { return i > 0 && !!m.hostPath.trim(); }

  /** Non-empty folders, as the provider wants them. */
  private workspaces(): { path: string; readOnly: boolean }[] {
    return this.mounts
      .map((m) => ({ path: m.hostPath.trim(), readOnly: m.readOnly === true }))
      .filter((w) => w.path !== '');
  }

  private validate(): string | null {
    if (!this.usable) return this.unusableHint || 'This environment type is not available right now';
    const name = this.sbxName.trim();
    if (name && !SANDBOX_NAME_PATTERN.test(name)) {
      return 'Name: lower-case letters, digits and dashes only, starting with a letter or digit (max 63)';
    }
    if (!this.sbxAgent) return 'Pick an agent';
    const folders = this.workspaces();
    if (folders.length === 0) return 'Add at least one folder';
    const seen = new Set<string>();
    for (const f of folders) {
      const key = f.path.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return `Duplicate folder: ${f.path}`;
      seen.add(key);
    }
    return null;
  }

  confirm(): void {
    const err = this.validate();
    if (err) { this.error = err; return; }
    const p = this.provider!;
    this.error = '';
    this.sandboxSteps = [];
    this.loading = true;
    this.status = 'Creating sandbox… (this can take a few minutes the first time)';
    this.api.createSandbox(p.id, {
      name: this.sbxName.trim() || undefined,
      agent: this.sbxAgent,
      workspaces: this.workspaces(),
    }).subscribe({
      next: (r) => {
        this.loading = false;
        this.status = '';
        if (r.ok) {
          this.remember();
          this.modalService.notifySandboxesChanged();
          this.modalService.closeSandbox();
        } else {
          this.sandboxSteps = r.steps ?? [];
          this.error = this.sandboxSteps.find((s) => s.code !== 0)?.stderr?.trim() || 'Sandbox creation failed';
        }
      },
      error: (e) => {
        this.loading = false;
        this.status = '';
        if (isProviderDisabled(e)) {
          // Switched off since the modal opened: say so and reload its status.
          this.error = `${p.label} is switched off in Huddle.`;
          this.loadProvider(p.id);
          return;
        }
        this.error = isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : (e?.message || 'Sandbox creation failed');
      },
    });
  }

  private remember(): void {
    const layout: RememberedLayout = {
      mounts: this.mounts
        .map((m) => ({ hostPath: m.hostPath.trim(), readOnly: m.readOnly === true }))
        .filter((m) => m.hostPath !== ''),
    };
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }

  private restoreRemembered(): void {
    let layout: RememberedLayout | null = null;
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (raw) layout = JSON.parse(raw) as RememberedLayout;
    } catch { layout = null; }
    if (layout && Array.isArray(layout.mounts) && layout.mounts.length) {
      const restored = layout.mounts
        .filter((m): m is NonNullable<typeof m> => !!m && typeof m.hostPath === 'string' && m.hostPath.trim() !== '')
        .map((m) => this.newRow(m.hostPath, m.readOnly === true));
      if (restored.length) this.mounts = restored;
    }
    this.fixPrimary();
  }

  close(): void { this.modalService.closeSandbox(); }
}
