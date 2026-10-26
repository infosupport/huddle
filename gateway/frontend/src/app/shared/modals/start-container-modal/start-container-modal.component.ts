import { Component, inject, effect, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NgTemplateOutlet } from '@angular/common';
import { ModalService } from '../../../core/services/modal.service';
import {
  ApiService, FolderMapping, HOST_PIPE_OFFLINE_HINT, ProviderStatus, SandboxStep, isHostPipeOffline, isProviderDisabled,
} from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';
import { FolderSelectComponent } from '../../components/folder-select/folder-select.component';
import { FolderPickerModalComponent } from '../folder-picker-modal/folder-picker-modal.component';
import { IconComponent } from '../../components/icon/icon.component';
import { computeMountTargets } from './folder-mount-targets';

// Remembers the last-used multi-folder layout so the modal pre-fills it next time.
const REMEMBER_KEY = 'huddle.start-modal.v1';

// Same rule the gateway enforces on sandbox names (docs/host-pipe.md).
const SANDBOX_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

interface RememberedLayout {
  /**
   * Last-used project folder list. Container path is never stored, even
   * though it can now be a manual override (see MountRow) — a remembered
   * override could point at a stale/renamed leaf next session, so a restored
   * row always starts non-dirty and gets its containerPath recomputed fresh
   * by refreshMountTargets(). Simpler and safer than trying to preserve a
   * dirty flag across sessions.
   */
  mounts?: { hostPath: string; readOnly: boolean }[];
}

/**
 * One project-folder mount row. `containerPath` is normally kept in sync with
 * `hostPath` (and every other row's hostPath, for collision numbering) by
 * refreshMountTargets() — but the moment the user types into the
 * container-path field directly, `containerPathDirty` latches true and the
 * row is excluded from further auto-recompute, so their explicit choice is
 * never silently clobbered by an unrelated row changing.
 */
interface MountRow {
  hostPath: string;
  containerPath: string;
  readOnly: boolean;
  containerPathDirty: boolean;
}

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, NgTemplateOutlet, FmtBytesPipe, FolderSelectComponent, FolderPickerModalComponent, IconComponent],
  templateUrl: './start-container-modal.component.html',
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
    .mount-row input, .sc-acc-body select { height: 36px; font-size: 12.5px; }

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

    /* ── Split "Add folder" button (container kind) ──────────────────────────── */
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
    .sc-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .sc-card {
      position: relative; display: flex; gap: 11px; padding: 14px 13px; text-align: left; cursor: pointer;
      border: 1px solid var(--border-strong); border-radius: 12px; background: var(--surface); color: var(--text); font-family: inherit;
    }
    .sc-card:hover { background: var(--surface-hover); }
    .sc-card.on { border-color: var(--accent); background: var(--accent-soft); box-shadow: 0 0 0 1px var(--accent) inset; }
    .sc-card-icon {
      width: 30px; height: 30px; flex: none; border-radius: 9px; background: var(--surface);
      border: 1px solid var(--border); color: var(--accent); display: grid; place-items: center;
    }
    .sc-card-b { flex: 1; min-width: 0; display: flex; flex-direction: column; justify-content: center; }
    .sc-card-name { font-size: 13.5px; font-weight: 600; color: var(--text); }
    .sc-radio { width: 16px; height: 16px; flex: none; margin-top: 2px; border-radius: 50%; border: 1.5px solid var(--border-strong); background: var(--surface); display: grid; place-items: center; }
    .sc-card.on .sc-radio { border-color: var(--accent); }
    .sc-card.on .sc-radio::after { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
    .sc-head-icon {
      width: 46px; height: 46px; border-radius: 13px; flex-shrink: 0;
      background: var(--accent-soft); color: var(--accent); display: grid; place-items: center;
    }
    .sc-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .sc-head-text h2 { flex: unset; }
    .sc-head-text p { margin: 3px 0 0; font-size: 13.5px; color: var(--text-muted); font-weight: 400; }

    /* ── Two-column layout (container kind only) ─────────────────────────────── */
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

    .sc-automount { margin-top: 12px; padding: 11px 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface-2); }
    .sc-automount-t { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 8px; font-size: 12px; font-weight: 600; color: var(--text); }
    .sc-automount-t span { font-weight: 400; color: var(--text-muted); }
    .sc-automount-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted); margin-top: 7px; flex-wrap: wrap; }
    .sc-automount-row code { font-size: 11px; }
    /* Bare .pill (no --allow/--deny/etc modifier) carries no background/color
       of its own — give the read-only marker a small, muted fill so it reads
       as a badge rather than invisible padding: the per-row pill flags an
       individual mapping that happens to be read-only, the one in the
       heading flags that the whole automount list is read-only from here. */
    .sc-automount-row .pill, .sc-automount-t .pill { padding: 2px 9px; font-size: 10px; font-weight: 700; background: var(--surface-hover); color: var(--text-muted); border: 1px solid var(--border-strong); }

    /* ── Accordions (right column) ───────────────────────────────────────────── */
    .sc-acc { border: 1px solid var(--border); border-radius: 12px; margin-bottom: 12px; overflow: hidden; background: var(--surface); }
    .sc-acc:last-child { margin-bottom: 0; }
    .sc-acc-head {
      width: 100%; display: flex; align-items: center; gap: 11px; padding: 13px 14px;
      background: transparent; border: 0; cursor: pointer; text-align: left; color: var(--text); font-family: inherit;
    }
    .sc-acc-head:hover { background: var(--surface-hover); }
    .sc-acc-mark { flex-shrink: 0; color: var(--accent); }
    .sc-acc-t { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: 2px; }
    .sc-acc-name { font-size: 13.5px; font-weight: 600; }
    .sc-acc-sub { font-size: 11.5px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sc-acc-chev { color: var(--text-muted); transition: transform .18s ease; flex-shrink: 0; }
    .sc-acc-chev.closed { transform: rotate(-90deg); }
    .sc-acc-body { padding: 2px 14px 14px; border-top: 1px solid var(--border); }
    .sc-acc-body > *:last-child { margin-bottom: 0; }

    .sc-select-wrap--icon { position: relative; display: block; }
    .sc-select-wrap--icon select.sc-select--icon { width: 100%; padding-left: 40px; }
    .sc-ide-icon { position: absolute; left: 11px; top: 50%; transform: translateY(-50%); width: 18px; height: 18px; object-fit: contain; pointer-events: none; }

    .sc-card:disabled { cursor: not-allowed; opacity: .55; }
    .sc-card:disabled:hover { background: var(--surface); }
    .sc-steps { margin: 0 24px 16px; padding: 0; list-style: none; font-size: 12px; }
    .sc-steps li { margin-bottom: 8px; }
    .sc-steps code { font-size: 11.5px; }
    .sc-steps pre {
      margin: 4px 0 0; padding: 8px 10px; max-height: 160px; overflow: auto; white-space: pre-wrap;
      background: var(--surface-2); border: 1px solid var(--border); border-radius: 8px; font-size: 11.5px;
    }

    /* ── Footer panel (container kind only) ─────────────────────────────────── */
    .sc-foot-panel { justify-content: space-between; align-items: center; padding: 14px 22px; background: var(--surface-2); }
    .sc-foot-art { flex: none; margin: -10px 0; }
    .sc-foot-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
    .sc-foot-text b { font-size: 13.5px; color: var(--text); }
    .sc-foot-text span { font-size: 12.5px; color: var(--text-muted); }
    .sc-foot-actions { display: flex; gap: 10px; }
  `]
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  // Which kind of dev environment to create: 'container' (a devcontainer), or
  // the id of an environment provider from GET /api/environments ('sbx'). Every
  // open starts at 'container' — the entry points that open this modal predate
  // sandboxes, so creating a sandbox is an explicit choice made in here.
  kind = 'container';

  // Environment providers (Docker Sandboxes today), one type card each. Loaded
  // per open: availability depends on the host agent and the tool behind it.
  providers: ProviderStatus[] = [];
  // Set when the providers could not be listed at all (host agent offline, …):
  // a single disabled "Sandbox" card carries this as its hint.
  providersError = '';

  // sandbox fields. A sandbox can hold several folders: the FIRST is the one the
  // agent starts in, the rest ride along. Unlike a devcontainer mount there is no
  // container path to pick — every folder is mounted at its own host path (see
  // the shared `mounts` array below and refreshMountTargets()).
  sbxName = '';
  sbxAgent = '';
  // What the provider ran, shown when creating the sandbox failed.
  sandboxSteps: SandboxStep[] = [];

  images: DockerImage[] = [];
  baseImage = '';
  selectedImage = '';
  // Sentinel option value for a free-text image reference.
  readonly CUSTOM_IMAGE = '__custom__';
  customImage = '';
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  // Always multi-capable — no separate single/multi mode. Each row's
  // containerPath defaults to whatever computeMountTargets() (see
  // folder-mount-targets.ts) derives from hostPath, but the user can type
  // over it — see MountRow / refreshMountTargets(). Shared by every kind —
  // see refreshMountTargets() and sandboxWorkspaces() for how sandboxes adapt it.
  mounts: MountRow[] = [this.newMountRow()];
  folderPickerOpen = false;
  // The split "Add folder" button's little "Browse..." menu — closed on any
  // outside click/scroll/resize, same idiom as firewall-groups-panel's row menu.
  addMenuOpen = false;
  containerName = '';
  nameTouched = false;
  error = '';
  status = '';
  loading = false;

  // The folder mappings from Settings that docker.ts mounts into every
  // devcontainer anyway, so the modal can show them (GET /api/folder-mappings).
  containerSettingsFolders: FolderMapping[] = [];

  // Right-column accordions, collapsed by default.
  accOpen: Record<string, boolean> = { baseImage: false };

  get open() { return this.modalService.startOpen(); }

  get isSandbox(): boolean { return this.kind !== 'container'; }

  /** The provider the selected kind stands for, or null for a devcontainer. */
  get provider(): ProviderStatus | null {
    return this.providers.find((p) => p.id === this.kind) ?? null;
  }

  /** Hint under the type cards when a provider cannot be used right now. */
  providerHint(p: ProviderStatus): string {
    if (!p.enabled) return `${p.label} is switched off in Huddle — switch it on under Dev Environments.`;
    return p.error || `${p.label} is not available on this host.`;
  }

  /** A provider sandboxes can be created with right now: switched on and reachable. */
  usable(p: ProviderStatus): boolean { return p.enabled && p.available; }

  /** A fresh, non-dirty mount row — see MountRow. */
  private newMountRow(hostPath = '', readOnly = false): MountRow {
    return { hostPath, containerPath: '', readOnly, containerPathDirty: false };
  }

  /** True when every mount row's hostPath is blank — an intentionally empty
   * environment (user clones manually after create). Derived, not a separate
   * toggle: not specifying any folder mapping simply means "empty". */
  get empty(): boolean {
    return this.mounts.every((m) => !m.hostPath.trim());
  }

  /**
   * Re-derives `containerPath` for every row that hasn't been manually
   * edited (containerPathDirty === false), via computeMountTargets() over
   * ALL rows' host paths, so collision numbering still accounts for every
   * row, including dirty ones. A fresh auto-computed target can in principle
   * still collide with one a user typed by hand — validate() catches that.
   *
   * Called after anything that changes a hostPath or the row set (typing,
   * the folder picker, add/remove row) and on a kind switch.
   */
  private refreshMountTargets(): void {
    const targets = computeMountTargets(this.mounts.map((m) => m.hostPath));
    this.mounts.forEach((m, i) => {
      if (!m.containerPathDirty) m.containerPath = targets[i];
    });
    // A sandbox mounts every folder at its own host path: the template shows the
    // host path as the (disabled) destination and leaves containerPath alone, so
    // switching back to a devcontainer still has what was typed there.
    if (this.isSandbox) {
      // The first folder is the sandbox's primary workspace, which can never be
      // read-only (docs/host-pipe.md). Corrected here rather than only hidden in
      // the template: a row can arrive at index 0 already marked read-only (a
      // row above it was removed), and a hidden flag would be silently ignored.
      if (this.mounts[0]) this.mounts[0].readOnly = false;
    }
  }

  /** What a row's destination field shows. */
  destination(m: MountRow): string {
    return this.isSandbox ? m.hostPath.trim() : m.containerPath;
  }

  // The "Name" field is bound to a different model property per kind
  // (containerName vs sbxName); a getter/setter pair keeps the template's
  // binding kind-agnostic.
  get envName(): string { return this.isSandbox ? this.sbxName : this.containerName; }
  setEnvName(v: string): void {
    if (this.isSandbox) { this.sbxName = v; }
    else { this.containerName = v; this.nameTouched = true; }
  }

  constructor() {
    effect(() => {
      if (this.modalService.startOpen()) {
        this.onOpen();
      }
    });
  }

  onOpen(): void {
    this.selectedImage = '';
    this.ide = 'intellij';
    this.mounts = [this.newMountRow()];
    this.addMenuOpen = false;
    this.containerName = '';
    this.nameTouched = false;
    this.error = '';
    this.status = '';
    this.loading = false;
    this.sbxName = '';
    this.sbxAgent = '';
    this.sandboxSteps = [];
    this.kind = 'container'; // legacy "Start devcontainer" entry points must default to a devcontainer
    this.containerSettingsFolders = [];
    this.restoreRemembered();
    this.loadImagesForIde();
    this.loadProviders();
    this.api.getFolderMappings().subscribe({
      next: (m) => { this.containerSettingsFolders = m.filter((f) => !!f.enabled); },
      error: () => { this.containerSettingsFolders = []; },
    });
  }

  private loadProviders(): void {
    this.providers = [];
    this.providersError = '';
    this.api.listEnvironments().subscribe({
      next: (r) => { this.providers = r.providers ?? []; },
      error: (e) => {
        this.providers = [];
        this.providersError = isHostPipeOffline(e) ? HOST_PIPE_OFFLINE_HINT : (e?.message || 'Environment providers could not be listed.');
      },
    });
  }

  /** Non-empty folders from the shared mounts list, as a sandbox wants them —
   *  the container path is irrelevant there, only hostPath/readOnly are sent. */
  private sandboxWorkspaces(): { path: string; readOnly: boolean }[] {
    return this.mounts
      .map((m) => ({ path: m.hostPath.trim(), readOnly: m.readOnly === true }))
      .filter((w) => w.path !== '');
  }

  private validateSandbox(): string | null {
    const p = this.provider;
    if (!p || !this.usable(p)) return 'This environment type is not available right now';
    const name = this.sbxName.trim();
    if (name && !SANDBOX_NAME_PATTERN.test(name)) {
      return 'Name: lower-case letters, digits and dashes only, starting with a letter or digit (max 63)';
    }
    if (!this.sbxAgent) return 'Pick an agent';
    const folders = this.sandboxWorkspaces();
    if (folders.length === 0) return 'Add at least one folder';
    const seen = new Set<string>();
    for (const f of folders) {
      const key = f.path.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return `Duplicate folder: ${f.path}`;
      seen.add(key);
    }
    return null;
  }

  setKind(k: string): void {
    if (k !== 'container') {
      const p = this.providers.find((x) => x.id === k);
      if (!p || !this.usable(p)) return;
      if (!p.agents.includes(this.sbxAgent)) this.sbxAgent = p.agents[0] ?? '';
    }
    this.kind = k;
    this.error = '';
    this.sandboxSteps = [];
    // A folder already entered under the previous kind must immediately show
    // the destination-field behavior of the newly selected kind.
    this.refreshMountTargets();
  }

  // The IDE choice drives both the default base image and the snapshot filter.
  // Both endpoints are IDE-specific; this method fetches them again.
  onIdeChange(): void {
    this.selectedImage = '';
    this.loadImagesForIde();
  }

  private loadImagesForIde(): void {
    this.api.getImages(this.ide).subscribe({ next: imgs => { this.images = imgs; }, error: () => {} });
    this.api.getBaseImage(this.ide).subscribe({
      next: b => { this.baseImage = b.imageName; if (!this.selectedImage) this.selectedImage = b.imageName; },
      error: () => { this.baseImage = ''; }
    });
  }

  addMount(): void {
    this.mounts.push(this.newMountRow());
    // A new blank row can shift "project"-fallback collision numbering on
    // existing non-dirty rows (see refreshMountTargets()).
    this.refreshMountTargets();
  }

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

  // Picking the folders of a multi-folder environment one dialog at a time is a
  // lot of clicking for what is one decision. Browse once, Ctrl-click the
  // folders, and every one of them lands as its own row. Purely additive: rows
  // already filled in (including hand-typed paths) stay, and a folder that is
  // already mounted is not added twice.
  onFoldersPicked(paths: string[]): void {
    this.folderPickerOpen = false;
    const known = new Set(
      this.mounts.map((m) => m.hostPath.trim().toLowerCase()).filter(Boolean)
    );
    for (const path of paths) {
      if (known.has(path.toLowerCase())) continue;
      known.add(path.toLowerCase());
      let row = this.mounts.find((m) => !m.hostPath.trim());
      if (!row) {
        row = this.newMountRow();
        this.mounts.push(row);
      }
      this.onHostPathInput(row, path);
    }
  }

  removeMount(i: number): void {
    this.mounts.splice(i, 1);
    if (this.mounts.length === 0) this.mounts.push(this.newMountRow());
    this.onMountInput();
  }

  /** Same from a mount row: the first folder fills the row, the rest add rows. */
  onMountPicked(paths: string[]): void {
    if (paths.length > 1) this.onFoldersPicked(paths.slice(1));
  }

  onHostPathInput(mount: MountRow, value: string): void {
    mount.hostPath = value;
    this.onMountInput();
  }

  /** A row's containerPath field was edited directly — latch it dirty so
   *  future hostPath changes elsewhere never clobber the manual choice. */
  onContainerPathInput(mount: MountRow): void {
    mount.containerPathDirty = true;
  }

  /** Tooltip/aria-label for a mount row's icon-only read-only toggle. */
  mountRoLabel(m: MountRow): string {
    if (!this.isSandbox && m.readOnly) return 'Read-only folders are only supported for sandboxes — click to make writable';
    return m.readOnly ? 'Read-only — click to allow writes' : 'Writable — click to make read-only';
  }

  /** Read-only is a sandbox feature (not the primary folder); a devcontainer
   *  only shows the toggle for a row still marked read-only, so it can be undone. */
  showRoToggle(m: MountRow, i: number): boolean {
    if (!this.destination(m)) return false;
    return this.isSandbox ? i > 0 : m.readOnly;
  }

  onMountInput(): void {
    this.refreshMountTargets();
    this.updateAutoName();
  }

  private updateAutoName(): void {
    if (this.nameTouched) return;
    if (this.empty) {
      this.containerName = 'devcontainer-empty';
      return;
    }
    // Reads the actual per-row containerPath (possibly a manual override).
    const leaf = (this.mounts[0]?.containerPath ?? '').split('/').filter(Boolean).pop() ?? '';
    this.containerName = leaf ? `devcontainer-${leaf}` : '';
  }

  imageToStart(): string {
    return this.selectedImage === this.CUSTOM_IMAGE ? this.customImage.trim() : this.selectedImage;
  }

  private validate(): string | null {
    if (!this.imageToStart() || !this.containerName) return 'All fields are required';
    if (this.empty) return null;
    // The devcontainer backend has no read-only workspace mounts yet; refuse
    // rather than quietly mounting a folder writable that was asked read-only.
    const ro = this.mounts.find((m) => m.hostPath.trim() && m.readOnly);
    if (ro) return `Read-only folders are only supported for sandboxes — make ${ro.hostPath.trim()} writable`;
    const hostPaths = this.mounts.map((m) => m.hostPath.trim()).filter(Boolean);
    // Windows paths are case-insensitive, and a trailing slash is not a difference.
    const seen = new Set<string>();
    for (const hostPath of hostPaths) {
      const key = hostPath.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return `Duplicate folder: ${hostPath}`;
      seen.add(key);
    }
    // A manual container path can collide with an auto-computed one (see
    // refreshMountTargets()); catch that rather than send two mounts at one path.
    const seenTargets = new Set<string>();
    for (const m of this.mounts) {
      if (!m.hostPath.trim()) continue;
      const target = m.containerPath.trim();
      if (!target) return `Every folder needs a container path: ${m.hostPath.trim()}`;
      if (!target.startsWith('/')) return `Container path must be absolute: "${target}"`;
      const key = target.replace(/\/+$/, '').toLowerCase();
      if (seenTargets.has(key)) return `Duplicate container path: ${target}`;
      seenTargets.add(key);
    }
    return null;
  }

  /** The `{hostPath, containerPath}` pairs confirm() sends for a devcontainer. */
  private buildMounts(): { hostPath: string; containerPath: string }[] {
    if (this.empty) return [];
    return this.mounts
      .map((m) => ({ hostPath: m.hostPath.trim(), containerPath: m.containerPath.trim() }))
      .filter((m) => m.hostPath !== '');
  }

  toggleAcc(key: string): void {
    this.accOpen[key] = !this.accOpen[key];
  }

  confirm(): void {
    if (this.isSandbox) { this.confirmSandbox(); return; }
    const err = this.validate();
    if (err) { this.error = err; return; }

    this.error = '';
    this.loading = true;
    this.status = this.selectedImage === this.CUSTOM_IMAGE
      ? 'Preparing custom image (first time takes a few minutes)…'
      : 'Starting container…';
    this.api.startContainer({
      image: this.imageToStart(),
      ide: this.ide,
      // mounts always carries the folder(s), even a single one; workspace is
      // only the fallback api.service sends when mounts is empty (the "empty,
      // clone manually" case, where the gateway ignores it).
      workspace: '',
      mounts: this.buildMounts(),
      containerName: this.containerName,
      empty: this.empty,
    }).subscribe({
      next: () => {
        this.remember();
        this.loading = false;
        this.modalService.closeStart();
        this.state.loadAll();
      },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  private confirmSandbox(): void {
    const err = this.validateSandbox();
    if (err) { this.error = err; return; }

    this.error = '';
    this.sandboxSteps = [];
    this.loading = true;
    this.status = 'Creating sandbox… (this can take a few minutes the first time)';
    this.api.createSandbox(this.kind, {
      name: this.sbxName.trim() || undefined,
      agent: this.sbxAgent,
      workspaces: this.sandboxWorkspaces(),
    }).subscribe({
      next: (r) => {
        this.loading = false;
        this.status = '';
        if (r.ok) {
          this.remember();
          this.modalService.notifySandboxesChanged();
          this.modalService.closeStart();
        } else {
          this.sandboxSteps = r.steps ?? [];
          this.error = this.sandboxSteps.find((s) => s.code !== 0)?.stderr?.trim() || 'Sandbox creation failed';
        }
      },
      error: (err) => {
        this.loading = false;
        this.status = '';
        if (isProviderDisabled(err)) {
          // Switched off since the modal opened: say so and reload the type cards.
          this.error = `${this.provider?.label ?? 'This environment'} is switched off in Huddle.`;
          this.loadProviders();
          return;
        }
        this.error = isHostPipeOffline(err) ? HOST_PIPE_OFFLINE_HINT : (err?.message || 'Sandbox creation failed');
      },
    });
  }

  private remember(): void {
    if (!this.isSandbox && this.empty) return;
    const layout: RememberedLayout = {
      mounts: this.mounts
        .map(m => ({ hostPath: m.hostPath.trim(), readOnly: m.readOnly === true }))
        .filter(m => m.hostPath !== ''),
    };
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }

  private restoreRemembered(): void {
    let layout: RememberedLayout | null = null;
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (raw) layout = JSON.parse(raw) as RememberedLayout;
    } catch { layout = null; }
    // A blob saved by an older modal (it stored mode/workspace/containerPath)
    // must degrade to "nothing restored", never throw — hence the guards.
    if (layout && Array.isArray(layout.mounts) && layout.mounts.length) {
      const restored = layout.mounts
        .filter((m): m is NonNullable<typeof m> => !!m && typeof m.hostPath === 'string' && m.hostPath.trim() !== '')
        .map(m => this.newMountRow(m.hostPath, m.readOnly === true));
      if (restored.length) this.mounts = restored;
    }
    // Every restored (or default) row starts non-dirty, so this seeds
    // containerPath for whatever mounts ended up in place above.
    this.refreshMountTargets();
    this.updateAutoName();
  }

  close(): void { this.modalService.closeStart(); }
}
