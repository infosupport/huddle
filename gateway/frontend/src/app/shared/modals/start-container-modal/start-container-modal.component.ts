import { Component, inject, effect, HostListener } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService, FolderMapping } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { SbxSettingsFolders } from '../../../core/services/api.service';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';
import { FolderSelectComponent } from '../../components/folder-select/folder-select.component';
import { FolderPickerModalComponent } from '../folder-picker-modal/folder-picker-modal.component';
import { IconComponent } from '../../components/icon/icon.component';
import { computeMountTargets } from './folder-mount-targets';

// Remembers the last-used multi-folder layout so the modal pre-fills it next time.
const REMEMBER_KEY = 'huddle.start-modal.v1';

// Same rule the backend enforces on env var keys (docker.ts / api.ts) — checked
// here too so a bad key is never silently dropped without the user knowing why.
const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Kept in sync BY HAND with docker.ts's RESERVED_ENV_NAMES; the backend is the
// enforcement point (it drops these and reports them in `ignoredEnv`), this is
// just an early hint so the warning shows up while the user is still typing
// instead of only after the create request comes back. Never treat this list
// as the source of truth.
const RESERVED_ENV_NAMES = new Set([
  '_CONTAINER_USER', '_CONTAINER_USER_HOME', '_REMOTE_USER', '_REMOTE_USER_HOME',
  'http_proxy', 'https_proxy', 'HTTP_PROXY', 'HTTPS_PROXY', 'no_proxy', 'NO_PROXY',
  'NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'DOCKER_HOST',
  'DEVCONTAINER_CONFIG_PATH', 'XDG_DATA_HOME', 'JAVA_TOOL_OPTIONS',
]);

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
  /** Last-used sandbox folder list (host paths; sbx mounts them at the same path). */
  sbxFolders?: { path: string; readOnly: boolean }[];
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

/** One devcontainer.json-shaped lifecycle hook, all optional (see docker.ts). */
interface Lifecycle {
  initializeCommand: string;
  onCreateCommand: string;
  updateContentCommand: string;
  postCreateCommand: string;
  postStartCommand: string;
  postAttachCommand: string;
}

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, FmtBytesPipe, FolderSelectComponent, FolderPickerModalComponent, IconComponent],
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
      letter-spacing: -.2px; color: var(--text);
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
    input[type="text"], input[type="number"], select, textarea {
      width: 100%; height: 42px; padding: 0 13px; border: 1px solid var(--border-strong);
      border-radius: 10px; background: var(--surface); color: var(--text); font: inherit; font-size: 14px;
    }
    input[type="text"]::placeholder { color: var(--text-dim); }
    input[type="text"]:focus, input[type="number"]:focus, select:focus, textarea:focus {
      outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft);
    }
    select {
      appearance: none; cursor: pointer; padding-right: 36px;
      background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='16' height='16' viewBox='0 0 24 24' fill='none' stroke='%236c7385' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'><path d='m6 9 6 6 6-6'/></svg>");
      background-repeat: no-repeat; background-position: right 12px center;
    }
    textarea { height: auto; min-height: 92px; padding: 11px 13px; resize: vertical; font-family: monospace; font-size: 12.5px; line-height: 1.6; }
    .mount-row input, .life-row input, .sc-acc-body select { height: 36px; font-size: 12.5px; }

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

    .mount-row { display: flex; gap: .5rem; align-items: center; }
    .mount-row .mount-host { flex: 1; min-width: 0; }
    .mount-row .mount-arrow { flex: 0 0 auto; color: var(--text-dim); }
    .mount-row input { flex: 1; min-width: 0; }
    .mount-row .btn { flex: 0 0 auto; }
    .mount-hint { font-size: 12px; margin: 7px 0 0; }
    .mount-add { display: flex; gap: 9px; margin-top: 11px; }
    .mount-row .ro-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: .3rem; font-size: 11.5px; color: var(--text-muted); }
    /* Project-folder rows only: a second line (the editable container-path
       field + its read-only toggle) sits under the folder field, so the
       row's remove button top-aligns instead of centering against the
       now-taller left column. */
    .mount-row.sc-mount-row { align-items: flex-start; }
    .mount-row.sc-mount-row .sc-map-x { margin-top: 2px; }
    /* The container-path line: a chevron, the editable path input (grows to
       fill the space — sized via the shared ".mount-row input" rule above),
       and the read-only toggle right after it (moved here from beside the
       whole row, per the redesign — it's the path's own toggle, not the
       row's). */
    .mount-target { display: flex; align-items: center; gap: 8px; margin: 6px 0 0 2px; }

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
    .settings-list { margin: -.25rem 0 .5rem 1rem; padding: 0; font-size: 11.5px; color: var(--text-muted); }
    .settings-list li { margin: 1px 0; }
    .settings-list code { font-size: 11px; }
    .settings-list--skip li { color: var(--warning); }

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
    .sc-facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 10px; }
    .sc-fact { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; opacity: .5; }
    .sc-fact.on { opacity: 1; }
    .sc-fact li { display: flex; gap: 7px; align-items: flex-start; font-size: 11.5px; line-height: 1.4; color: var(--text-muted); }
    .sc-fact li app-icon { flex: none; margin-top: 1px; color: var(--text-dim); }
    .sc-fact.on li { color: var(--text); font-weight: 500; }
    .sc-fact.on li app-icon { color: var(--success); }

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
    .sc-field { margin-bottom: 20px; }
    .sc-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 7px; color: var(--text); }

    .sc-automount { margin-top: 12px; padding: 11px 12px; border: 1px dashed var(--border-strong); border-radius: 10px; background: var(--surface-2); }
    .sc-automount-t { font-size: 12px; font-weight: 600; color: var(--text); }
    .sc-automount-t span { font-weight: 400; color: var(--text-muted); }
    .sc-automount-row { display: flex; align-items: center; gap: 8px; font-size: 11.5px; color: var(--text-muted); margin-top: 7px; flex-wrap: wrap; }
    .sc-automount-row code { font-size: 11px; }

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

    .env-row-warn { font-size: 11px; color: var(--warning); margin: -6px 0 8px; }

    /* ── Lifecycle steps — the mockup's connecting-line timeline ─────────────── */
    .sc-life { position: relative; margin: 0; padding: 0 0 0 16px; }
    .sc-life::before { content: ""; position: absolute; left: 3px; top: 8px; bottom: 22px; width: 1.5px; background: var(--border-strong); }
    .life-row { position: relative; display: flex; flex-direction: column; gap: 5px; margin-bottom: 11px; }
    .life-row::before { content: ""; position: absolute; left: -16px; top: 9px; width: 7px; height: 7px; border-radius: 50%; background: var(--surface); border: 1.5px solid var(--border-strong); }
    .life-row:first-child::before { border-color: var(--accent); background: var(--accent); }
    .life-row:last-child { margin-bottom: 0; }
    .life-row label { font-size: 12px; font-weight: 600; font-family: monospace; color: var(--text); }
    .life-row input { font-family: monospace; }

    .sc-devcjson-pill { margin-left: 6px; }

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

  // Which kind of dev environment to create. Defaults to 'container' on open —
  // every entry point that opens this modal predates sandboxes and is still
  // labeled "Start devcontainer", so that must stay the default behavior.
  // Creating a sandbox is an explicit choice the user makes inside the modal.
  kind: 'sandbox' | 'container' = 'container';

  // sandbox fields. A sandbox can hold several folders: the FIRST is the one the
  // agent starts in, the rest ride along. Unlike a devcontainer mount there is no
  // container path to pick — sbx mounts every folder at its own host path.
  sbxName = '';
  sbxAgent = 'claude';
  sbxFolders: { path: string; readOnly: boolean }[] = [{ path: '', readOnly: false }];
  sbxSettings: SbxSettingsFolders | null = null;

  images: DockerImage[] = [];
  baseImage = '';
  selectedImage = '';
  // The visible top-level choice: just the two IDE *families* — which JetBrains
  // product (incl. Rider) is picked via `jbBackend` in the Customisations
  // accordion below, same field either way. `ide` stays the finer-grained value
  // the backend/base-image lookups actually key on (base-devimage-intellij vs
  // -rider are different images) — kept in sync by syncIdeFromFamily().
  ideFamily: 'jetbrains' | 'vscode' = 'jetbrains';
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  // Always multi-capable — no separate single/multi mode. Each row's
  // containerPath defaults to whatever computeMountTargets() (see
  // folder-mount-targets.ts) derives from hostPath, but the user can type
  // over it — see MountRow / refreshMountTargets().
  mounts: MountRow[] = [this.newMountRow()];
  folderPickerOpen = false;
  sbxFolderPickerOpen = false;
  // The split "Add folder" button's little "Browse..." menu (container kind
  // only) — closed on any outside click/scroll/resize, same idiom as
  // firewall-groups-panel.component.ts's row menu.
  addMenuOpen = false;
  containerName = '';
  nameTouched = false;
  empty = false;
  error = '';
  status = '';
  loading = false;

  // ── devcontainer.json-shaped fields (container kind only) ──────────────────
  // A single flat array with a `scope` discriminator, not two separate arrays:
  // the accordion renders container/remote vars in one add/remove-row list (it
  // mirrors how the mockup and the folder-mount rows both work), and the API
  // payload is split into containerEnv/remoteEnv records only at submit time —
  // see buildEnvRecord().
  envVars: { key: string; value: string; scope: 'container' | 'remote' }[] = [];
  jbPlugins: string[] = [];
  // Cosmetic-only for now: the mockup's JetBrains "backend" picker isn't wired
  // to a real per-container "which JB product" concept beyond `ideName` — the
  // backend has no place to put this yet, so it's captured as a plain string
  // and simply not sent.
  jbBackend = 'IntelliJ IDEA';
  jbSettingsJson = ''; // raw textarea; parsed/validated on submit, see confirm()
  lifecycle: Lifecycle = {
    initializeCommand: '', onCreateCommand: '', updateContentCommand: '',
    postCreateCommand: '', postStartCommand: '', postAttachCommand: '',
  };
  // Populated from the create response after a successful submit. The modal
  // normally closes immediately on success, so when this is non-empty we keep
  // it open a beat longer purely to show these — see confirm().
  ignoredEnvWarnings: string[] = [];
  doneWithWarnings = false;

  // Devcontainer mode has the same "settings folders" concept sandbox already
  // shows (host-config.ts folder mappings, applied to every container
  // unconditionally by docker.ts's buildFolderMounts) but the modal never
  // surfaced it for containers before now. Reuses the existing
  // /api/folder-mappings read endpoint (already called by the Settings page) —
  // no backend change needed for this piece.
  containerSettingsFolders: FolderMapping[] = [];

  // Right-column accordions, all collapsed by default. (Previously defaulted
  // open on the theory that an interactive form should show everything up
  // front — reverted per product feedback: a first-time user should see the
  // collapsed section structure, not a wall of open panels.)
  accOpen: Record<string, boolean> = { baseImage: false, envVars: false, jetbrains: false, vscode: false, lifecycle: false };

  get open() { return this.modalService.startOpen(); }

  /** A fresh, non-dirty mount row — see MountRow. */
  private newMountRow(hostPath = '', readOnly = false): MountRow {
    return { hostPath, containerPath: '', readOnly, containerPathDirty: false };
  }

  /**
   * Re-derives `containerPath` for every row that hasn't been manually
   * edited (containerPathDirty === false), via computeMountTargets() over
   * ALL rows' host paths — same as before, so collision numbering still
   * accounts for every row, including dirty ones. A dirty row's own
   * containerPath is left untouched; note this means computeMountTargets()
   * doesn't know a dirty row may have already claimed a target by hand, so
   * a fresh auto-computed target can in principle still collide with one a
   * user typed manually — validate() catches that at submit time rather
   * than this function trying to reverse-engineer manual overrides.
   *
   * Called after anything that changes a hostPath or the row set (typing,
   * the folder picker, add/remove row) — never on a plain re-render, so it's
   * a push model rather than the old always-live `mountTargets` getter.
   */
  private refreshMountTargets(): void {
    const targets = computeMountTargets(this.mounts.map((m) => m.hostPath));
    this.mounts.forEach((m, i) => {
      if (!m.containerPathDirty) m.containerPath = targets[i];
    });
  }

  // The "Name" field is the one Essential-settings field bound to a
  // different model property per kind (containerName vs sbxName) — everything
  // else in the shared grid reads/writes the same properties regardless of
  // kind. A getter/setter pair keeps the template's binding kind-agnostic
  // rather than branching the whole field.
  get envName(): string { return this.kind === 'container' ? this.containerName : this.sbxName; }
  setEnvName(v: string): void {
    if (this.kind === 'container') { this.containerName = v; this.nameTouched = true; }
    else { this.sbxName = v; }
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
    this.ideFamily = 'jetbrains';
    this.ide = 'intellij';
    this.mounts = [this.newMountRow()];
    this.addMenuOpen = false;
    this.containerName = '';
    this.nameTouched = false;
    this.empty = false;
    this.error = '';
    this.status = '';
    this.loading = false;
    this.sbxName = '';
    this.sbxFolders = [{ path: '', readOnly: false }];
    this.sbxAgent = 'claude';
    this.sbxSettings = null;
    this.kind = 'container'; // legacy "Start devcontainer" entry points must default to a devcontainer
    // devcontainer.json-shaped fields: reset every open so a previous
    // environment's env vars/lifecycle commands never bleed into the next one.
    this.envVars = [];
    this.jbPlugins = [];
    this.jbBackend = 'IntelliJ IDEA';
    this.jbSettingsJson = '';
    this.lifecycle = {
      initializeCommand: '', onCreateCommand: '', updateContentCommand: '',
      postCreateCommand: '', postStartCommand: '', postAttachCommand: '',
    };
    this.ignoredEnvWarnings = [];
    this.doneWithWarnings = false;
    this.containerSettingsFolders = [];
    this.restoreRemembered();
    this.loadImagesForIde();
    // Show which settings folders (folder mappings) the sandbox will get, and
    // which mappings cannot travel — that difference is otherwise invisible.
    this.api.sbxSettingsFolders().subscribe({
      next: (s) => { this.sbxSettings = s; },
      error: () => { this.sbxSettings = null; },
    });
    // Same idea for devcontainer mode — see containerSettingsFolders' comment.
    this.api.getFolderMappings().subscribe({
      next: (m) => { this.containerSettingsFolders = m.filter((f) => !!f.enabled); },
      error: () => { this.containerSettingsFolders = []; },
    });
  }

  addSbxFolder(): void {
    this.sbxFolders.push({ path: '', readOnly: false });
  }

  removeSbxFolder(i: number): void {
    this.sbxFolders.splice(i, 1);
    if (this.sbxFolders.length === 0) this.addSbxFolder();
  }

  // Same deal as the devcontainer mounts: browse once, Ctrl-click several
  // folders, and each one lands as its own row rather than making the user open
  // the dialog once per folder. Additive — filled rows (including hand-typed
  // paths never browsed to) stay, and a folder already listed is not added
  // twice.
  onSbxFoldersPicked(paths: string[]): void {
    const known = new Set(
      this.sbxFolders.map((f) => f.path.trim().toLowerCase()).filter(Boolean)
    );
    for (const path of paths) {
      if (known.has(path.toLowerCase())) continue;
      known.add(path.toLowerCase());
      const row = this.sbxFolders.find((f) => !f.path.trim());
      if (row) row.path = path;
      else this.sbxFolders.push({ path, readOnly: false });
    }
    this.updateAutoName();
  }

  /** One row's path, typed or picked. The extra folders arrive separately. */
  onSbxFolderInput(folder: { path: string; readOnly: boolean }, value: string): void {
    folder.path = value;
    this.updateAutoName();
  }

  /** From a row: the first folder filled the row, the rest become new rows. */
  onSbxFolderPicked(paths: string[]): void {
    if (paths.length > 1) this.onSbxFoldersPicked(paths.slice(1));
  }

  /** From the bulk Browse button: nothing was filled in yet, so take them all. */
  onSbxFoldersPickedBulk(paths: string[]): void {
    this.sbxFolderPickerOpen = false;
    this.onSbxFoldersPicked(paths);
  }

  /** Non-empty folders, trimmed — the payload for /api/sbx/start. */
  private sbxWorkspaces(): { path: string; readOnly: boolean }[] {
    return this.sbxFolders
      .map((f) => ({ path: f.path.trim(), readOnly: f.readOnly === true }))
      .filter((f) => f.path !== '');
  }

  private validateSandbox(): string | null {
    const folders = this.sbxWorkspaces();
    if (folders.length === 0) return 'Add at least one folder';
    const seen = new Set<string>();
    for (const f of folders) {
      const key = f.path.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return `Duplicate folder: ${f.path}`;
      seen.add(key);
    }
    return null;
  }

  setKind(k: 'sandbox' | 'container'): void {
    this.kind = k;
    this.error = '';
  }

  // The IDE choice drives both the default base image and the snapshot filter.
  // Both endpoints are now IDE-specific; this method fetches them again.
  onIdeChange(): void {
    this.selectedImage = '';
    this.loadImagesForIde();
  }

  /**
   * The visible "IDE" select only offers the two families — which concrete
   * JetBrains product (including Rider) is `jbBackend`, one level down in the
   * Customisations accordion. `ide` is the finer-grained value base-image
   * lookups key on (base-devimage-intellij vs -rider are different images),
   * so both places that can change the effective IDE resync it here.
   */
  private syncIdeFromFamily(): void {
    this.ide = this.ideFamily === 'vscode' ? 'vscode' : (this.jbBackend === 'Rider' ? 'rider' : 'intellij');
  }

  onIdeFamilyChange(): void {
    this.syncIdeFromFamily();
    this.onIdeChange();
  }

  onJbBackendChange(): void {
    if (this.ideFamily !== 'jetbrains') return;
    this.syncIdeFromFamily();
    this.onIdeChange();
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
    // existing non-dirty rows (see refreshMountTargets()'s doc comment).
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

  // Picking the folders of a multi-folder container one dialog at a time is a
  // lot of clicking for what is one decision. Browse once, Ctrl-click the
  // folders, and every one of them lands as its own row. Purely additive: rows
  // already filled in (including hand-typed paths) stay,
  // and a folder that is already mounted is not added twice.
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
    // Reads the actual per-row containerPath (possibly a manual override)
    // rather than a freshly-recomputed value — more honest about what will
    // actually be created now that the field is real, editable state.
    const leaf = (this.mounts[0]?.containerPath ?? '').split('/').filter(Boolean).pop() ?? '';
    this.containerName = leaf ? `devcontainer-${leaf}` : '';
  }

  onEmptyToggle(): void {
    if (this.empty) {
      this.mounts = [];
      if (!this.nameTouched && !this.containerName) {
        this.containerName = 'devcontainer-empty';
      }
    } else if (this.mounts.length === 0) {
      this.mounts = [this.newMountRow()];
      this.refreshMountTargets();
    }
    this.updateAutoName();
  }

  private validate(): string | null {
    if (!this.selectedImage || !this.containerName) return 'All fields are required';
    if (this.empty) return null;
    const hostPaths = this.mounts.map((m) => m.hostPath.trim()).filter(Boolean);
    if (hostPaths.length === 0) return 'Add at least one folder';
    // Same normalize-and-compare style as validateSandbox() below (Windows
    // paths are case-insensitive, and a trailing slash is not a difference).
    const seen = new Set<string>();
    for (const hostPath of hostPaths) {
      const key = hostPath.replace(/[\\/]+$/, '').toLowerCase();
      if (seen.has(key)) return `Duplicate folder: ${hostPath}`;
      seen.add(key);
    }
    // Container paths USED to be collision-free by construction
    // (computeMountTargets() numbers collisions itself), but that's no longer
    // strictly true now that a row's containerPath can be a manual override:
    // refreshMountTargets() can't know a dirty row already claimed a target
    // by hand, so a freshly auto-computed target on another row can collide
    // with it. Catch that here rather than silently sending two mounts at
    // the same in-environment path.
    const seenTargets = new Set<string>();
    for (const m of this.mounts) {
      if (!m.hostPath.trim()) continue;
      const target = m.containerPath.trim();
      if (!target) continue;
      const key = target.replace(/\/+$/, '').toLowerCase();
      if (seenTargets.has(key)) return `Duplicate container path: ${target}`;
      seenTargets.add(key);
    }
    return null;
  }

  /**
   * The `{hostPath, containerPath, readOnly}` triples confirm() sends, and
   * what remember() persists (minus containerPath/dirty there — see
   * RememberedLayout). containerPath is read straight off each row now (no
   * separate recompute here) since refreshMountTargets() already keeps every
   * non-dirty row's containerPath current as of the last hostPath edit, and a
   * dirty row's containerPath is exactly what the user typed.
   */
  private buildMounts(): { hostPath: string; containerPath: string; readOnly: boolean }[] {
    if (this.empty) return [];
    return this.mounts
      .map((m) => ({ hostPath: m.hostPath.trim(), containerPath: m.containerPath.trim(), readOnly: m.readOnly === true }))
      .filter((m) => m.hostPath !== '');
  }

  // ── Environment variables (container kind) ─────────────────────────────────
  addEnvVar(): void {
    this.envVars.push({ key: '', value: '', scope: 'container' });
  }

  removeEnvVar(i: number): void {
    this.envVars.splice(i, 1);
  }

  /** Live per-row hint. Never blocks submission — see buildEnvRecord(). */
  envRowWarning(row: { key: string }): string | null {
    const key = row.key.trim();
    if (!key) return null;
    if (RESERVED_ENV_NAMES.has(key)) return `\`${key}\` is reserved by Huddle and will be ignored.`;
    if (!ENV_KEY_PATTERN.test(key)) return `"${key}" is not a valid variable name and won't be sent.`;
    return null;
  }

  /**
   * Builds the containerEnv/remoteEnv record for one scope at submit time.
   *
   * Reserved names are still sent through (not filtered here) — the backend is
   * the enforcement point and reports what it dropped via `ignoredEnv`; the
   * inline warning above is what tells the user ahead of time, dropping it
   * silently here would just hide that same information one step earlier.
   * Only a structurally invalid key (fails the identifier regex) is dropped
   * client-side, since the backend would 400 the whole request for that.
   */
  private buildEnvRecord(scope: 'container' | 'remote'): Record<string, string> | undefined {
    const rec: Record<string, string> = {};
    for (const row of this.envVars) {
      if (row.scope !== scope) continue;
      const key = row.key.trim();
      if (!key || !ENV_KEY_PATTERN.test(key)) continue;
      rec[key] = row.value;
    }
    return Object.keys(rec).length ? rec : undefined;
  }

  // ── JetBrains customisations (container kind) ───────────────────────────────
  addJbPlugin(): void {
    this.jbPlugins.push('');
  }

  removeJbPlugin(i: number): void {
    this.jbPlugins.splice(i, 1);
  }

  // ── Lifecycle commands (container kind) ─────────────────────────────────────
  /** Blank fields become `undefined` per-field — no point sending empty noise. */
  private buildLifecycle(): Partial<Lifecycle> | undefined {
    const out: Partial<Lifecycle> = {};
    for (const key of Object.keys(this.lifecycle) as (keyof Lifecycle)[]) {
      const trimmed = this.lifecycle[key].trim();
      if (trimmed) out[key] = trimmed;
    }
    return Object.keys(out).length ? out : undefined;
  }

  toggleAcc(key: string): void {
    this.accOpen[key] = !this.accOpen[key];
  }

  /**
   * Parses the JetBrains "settings" textarea once, shared by both confirm
   * paths (the accordion is common to container and sandbox kinds). Returns
   * `undefined` for a blank textarea, the parsed object on success, or the
   * `'invalid'` sentinel with `this.error` already set — callers bail on that
   * sentinel exactly like the old inline block did, just before anything is
   * sent: a bad paste should surface immediately, not after creation started.
   */
  private parseJbSettings(): Record<string, unknown> | undefined | 'invalid' {
    const raw = this.jbSettingsJson.trim();
    if (!raw) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      this.error = `JetBrains settings is not valid JSON: ${(e as Error).message}`;
      return 'invalid';
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.error = 'JetBrains settings must be a JSON object';
      return 'invalid';
    }
    return parsed as Record<string, unknown>;
  }

  confirm(): void {
    if (this.doneWithWarnings) { this.close(); return; }
    if (this.kind === 'sandbox') { this.confirmSandbox(); return; }
    const err = this.validate();
    if (err) { this.error = err; return; }

    const jbSettings = this.parseJbSettings();
    if (jbSettings === 'invalid') return;

    this.error = '';
    this.loading = true;
    this.status = 'Starting container…';
    this.api.startContainer({
      image: this.selectedImage,
      ide: this.ide,
      // No single-folder path any more — mounts is always what carries the
      // folder(s), even for what used to be "single mode" (a 1-item array is
      // already a supported, already-tested backend path). workspace is only
      // still a param because api.service.ts's ternary falls back to it when
      // mounts is empty (the "empty, clone manually" case) — '' there is fine
      // since createAndStartContainer() ignores workspaceDir when empty=true.
      workspace: '',
      mounts: this.buildMounts(),
      containerName: this.containerName,
      empty: this.empty,
      containerEnv: this.buildEnvRecord('container'),
      remoteEnv: this.buildEnvRecord('remote'),
      jbPlugins: this.jbPlugins.map(p => p.trim()).filter(Boolean),
      jbSettings,
      lifecycle: this.buildLifecycle(),
    }).subscribe({
      next: (r) => {
        this.remember();
        this.loading = false;
        // ignoredEnv is the authoritative version of the same warning the
        // per-row hint above already gave — something could in principle slip
        // past it (e.g. a name added to RESERVED_ENV_NAMES on the backend
        // after this frontend copy was last synced by hand). The modal
        // normally closes immediately on success, and ModalService has no
        // general-purpose "toast after an action" mechanism (only
        // notifySandboxesChanged(), a one-shot refresh tick for a different
        // list) — rather than build a whole notification system for one
        // message, just keep the modal open long enough to show it.
        this.state.loadAll();
        if (r.ignoredEnv?.length) {
          this.ignoredEnvWarnings = r.ignoredEnv;
          this.doneWithWarnings = true;
          this.status = '';
        } else {
          this.modalService.closeStart();
        }
      },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  private confirmSandbox(): void {
    const err = this.validateSandbox();
    if (err) { this.error = err; return; }

    const jbSettings = this.parseJbSettings();
    if (jbSettings === 'invalid') return;

    this.error = '';
    this.loading = true;
    this.status = 'Creating sandbox…';
    this.api.startSbx({
      name: this.sbxName.trim() || undefined,
      agent: this.sbxAgent.trim() || undefined,
      workspaces: this.sbxWorkspaces(),
      // devcontainer.json-shaped extras — same right column as the devcontainer
      // kind, applied best-effort inside the microVM (see sbx.ts's
      // startSandboxExclusive and docs/ADR-workspace-runtime-abstraction.md).
      containerEnv: this.buildEnvRecord('container'),
      remoteEnv: this.buildEnvRecord('remote'),
      jbPlugins: this.jbPlugins.map(p => p.trim()).filter(Boolean),
      jbSettings,
      lifecycle: this.buildLifecycle(),
    }).subscribe({
      next: (r) => {
        this.loading = false;
        if (r.ok) {
          this.remember();
          this.modalService.notifySandboxesChanged();
          // Same "stay open long enough to show what got dropped" treatment
          // as the container path — see the ignoredEnv comment in confirm().
          if (r.ignoredEnv?.length) {
            this.ignoredEnvWarnings = r.ignoredEnv;
            this.doneWithWarnings = true;
            this.status = '';
          } else {
            this.modalService.closeStart();
          }
        } else {
          this.status = '';
          this.error = r.steps.find((s) => s.code !== 0)?.stderr?.trim() || 'Sandbox creation failed';
        }
      },
      error: (err) => { this.loading = false; this.status = ''; this.error = err?.error?.error || err?.message || 'Sandbox creation failed'; },
    });
  }

  private remember(): void {
    if (this.kind === 'container' && this.empty) return;
    const layout: RememberedLayout = {
      mounts: this.mounts
        .map(m => ({ hostPath: m.hostPath.trim(), readOnly: m.readOnly === true }))
        .filter(m => m.hostPath !== ''),
      sbxFolders: this.sbxWorkspaces(),
    };
    try { localStorage.setItem(REMEMBER_KEY, JSON.stringify(layout)); } catch { /* storage unavailable */ }
  }

  private restoreRemembered(): void {
    let layout: RememberedLayout | null = null;
    try {
      const raw = localStorage.getItem(REMEMBER_KEY);
      if (raw) layout = JSON.parse(raw) as RememberedLayout;
    } catch { layout = null; }
    // A blob saved before this refactor (or any other unexpected shape) must
    // degrade to "nothing restored", never throw — hence the Array.isArray
    // and per-field guards rather than trusting the RememberedLayout cast.
    if (layout) {
      if (Array.isArray(layout.mounts) && layout.mounts.length) {
        const restored = layout.mounts
          .filter((m): m is NonNullable<typeof m> => !!m && typeof m.hostPath === 'string' && m.hostPath.trim() !== '')
          .map(m => this.newMountRow(m.hostPath, m.readOnly === true));
        if (restored.length) this.mounts = restored;
      }
      if (Array.isArray(layout.sbxFolders) && layout.sbxFolders.length) {
        const restored = layout.sbxFolders
          .filter((f): f is NonNullable<typeof f> => !!f && typeof f.path === 'string')
          .map(f => ({ path: f.path, readOnly: f.readOnly === true }));
        if (restored.length) this.sbxFolders = restored;
      }
    }
    // Every restored (or default) row starts non-dirty, so this seeds
    // containerPath for whatever mounts ended up in place above — see
    // RememberedLayout's comment for why containerPath itself isn't restored.
    this.refreshMountTargets();
    this.updateAutoName();
  }

  close(): void { this.modalService.closeStart(); }
}
