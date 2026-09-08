import { Component, inject, effect } from '@angular/core';
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
  mode: 'single' | 'multi';
  workspace: string;
  mounts: { hostPath: string; containerPath: string }[];
  /** Last-used sandbox folder list (host paths; sbx mounts them at the same path). */
  sbxFolders?: { path: string; readOnly: boolean }[];
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
    .mount-row { display: flex; gap: .5rem; align-items: center; }
    .mount-row .mount-host { flex: 1; min-width: 0; }
    .mount-row .mount-arrow { flex: 0 0 auto; color: var(--text-muted); }
    .mount-row input { flex: 1; min-width: 0; }
    .mount-row .btn { flex: 0 0 auto; }
    .mount-hint { font-size: 12px; color: var(--text-muted); margin: -.25rem 0 .5rem; }
    .mount-add { display: flex; gap: .5rem; }
    .mount-row .ro-toggle { flex: 0 0 auto; display: inline-flex; align-items: center; gap: .3rem; font-size: 11.5px; color: var(--text-muted); }
    .settings-list { margin: -.25rem 0 .5rem 1rem; padding: 0; font-size: 11.5px; color: var(--text-muted); }
    .settings-list li { margin: 1px 0; }
    .settings-list code { font-size: 11px; }
    .settings-list--skip li { color: var(--warn, #d08a2a); }

    /* ── Environment-type cards (replaces the old plain env-kind toggle) ────── */
    .sc-cards { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 8px; }
    .sc-card {
      display: flex; align-items: center; gap: 8px; text-align: left; cursor: pointer;
      border: 1px solid var(--border); border-radius: var(--radius-sm);
      padding: 10px 12px; background: var(--surface); color: var(--text); font-family: inherit;
    }
    .sc-card:hover { border-color: var(--border-strong); }
    .sc-card.on { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset; }
    .sc-card app-icon { color: var(--text-muted); flex-shrink: 0; }
    .sc-card.on app-icon { color: var(--accent); }
    .sc-card-name { flex: 1; font-size: 13.5px; font-weight: 600; }
    .sc-radio { width: 14px; height: 14px; border-radius: 50%; border: 2px solid var(--border-strong); flex-shrink: 0; }
    .sc-card.on .sc-radio { border-color: var(--accent); background: radial-gradient(circle, var(--accent) 40%, transparent 46%); }
    .sc-fact { list-style: none; margin: 0 0 12px; padding: 0; display: none; flex-direction: column; gap: 4px; }
    .sc-fact.on { display: flex; }
    .sc-fact li { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text-muted); }
    .sc-fact li app-icon { color: var(--success); flex-shrink: 0; }

    .sc-head-icon {
      width: 30px; height: 30px; border-radius: 8px; flex-shrink: 0;
      background: var(--accent-soft); color: var(--accent); display: grid; place-items: center;
    }
    .sc-head-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
    .sc-head-text h2 { flex: unset; }
    .sc-head-text p { margin: 0; font-size: 11.5px; color: var(--text-muted); font-weight: 400; }

    /* .modal-box--wide (720px, styles.css) is comfortable for one column but
       cramped for two — this component-scoped override widens it further
       rather than touching the shared class other modals rely on. */
    .sc-xwide { width: min(94vw, 960px); }

    /* ── Two-column layout (container kind only) ────────────────────────────── */
    .sc-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 1.5rem; align-items: start; }
    @media (max-width: 760px) { .sc-grid { grid-template-columns: 1fr; } }
    .sc-col-title { font-size: 14px; font-weight: 700; margin: 0 0 2px; }
    .sc-col-sub { font-size: 12px; color: var(--text-muted); margin: 0 0 12px; }
    .sc-col-head { display: flex; justify-content: space-between; align-items: flex-start; gap: .75rem; margin-bottom: 6px; }
    .sc-field { margin-bottom: 14px; }
    .sc-label { font-size: 12.5px; font-weight: 600; margin-bottom: 5px; color: var(--text); }

    .sc-automount { margin-top: 10px; padding-top: 8px; border-top: 1px dashed var(--border); }
    .sc-automount-t { font-size: 11.5px; color: var(--text-muted); margin-bottom: 4px; }
    .sc-automount-t span { opacity: .75; }
    .sc-automount-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; color: var(--text); margin: 2px 0; }
    .sc-automount-row code { font-size: 11px; }

    /* ── Accordions (right column) ──────────────────────────────────────────── */
    .sc-acc { border: 1px solid var(--border); border-radius: var(--radius-sm); margin-bottom: 10px; overflow: hidden; }
    .sc-acc-head {
      width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 12px;
      background: var(--surface); border: 0; cursor: pointer; text-align: left; color: var(--text); font-family: inherit;
    }
    .sc-acc-head:hover { background: var(--surface-hover); }
    .sc-acc-mark { color: var(--text-muted); flex-shrink: 0; }
    .sc-acc-t { flex: 1; display: flex; flex-direction: column; min-width: 0; gap: 1px; }
    .sc-acc-name { font-size: 13px; font-weight: 600; }
    .sc-acc-sub { font-size: 11px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sc-acc-chev { color: var(--text-muted); transition: transform .15s; flex-shrink: 0; }
    .sc-acc-chev.closed { transform: rotate(-90deg); }
    .sc-acc-body { padding: 10px 12px 12px; border-top: 1px solid var(--border); }

    .ide-badge {
      width: 22px; height: 22px; border-radius: 6px; flex-shrink: 0;
      background: var(--accent-soft); color: var(--accent-strong);
      font-size: 10px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center;
    }
    .sc-select-wrap { display: flex; align-items: center; gap: 8px; }
    .sc-select-wrap select { flex: 1; }

    .env-row-warn { font-size: 11px; color: var(--warning); margin: -6px 0 8px; }
    .sc-acc-body textarea {
      width: 100%; min-height: 90px; resize: vertical; font-family: monospace;
      padding: .45rem .65rem; border: 1px solid var(--border-strong); border-radius: .4rem;
      font-size: .8rem; background: var(--surface); color: var(--text);
    }
    .life-row { display: flex; flex-direction: column; gap: 3px; margin-bottom: 10px; }
    .life-row label { font-size: 11px; font-family: monospace; color: var(--text-muted); }
    .life-row input { font-family: monospace; }

    .sc-devcjson-pill { margin-left: 6px; }

    /* ── Footer panel (container kind only) ─────────────────────────────────── */
    .sc-foot-panel { justify-content: space-between; align-items: center; }
    .sc-foot-text { display: flex; flex-direction: column; gap: 2px; }
    .sc-foot-text b { font-size: 13.5px; }
    .sc-foot-text span { font-size: 11.5px; color: var(--text-muted); }
    .sc-foot-actions { display: flex; gap: .5rem; }
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
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  mode: 'single' | 'multi' = 'single';
  workspace = '';
  mounts: { hostPath: string; containerPath: string }[] = [];
  folderPickerOpen = false;
  sbxFolderPickerOpen = false;
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

  // Right-column accordions, all expanded by default: every field in them is
  // optional, so there is no "important" one to single out as pre-opened —
  // unlike the mockup's static screenshot (which shows Base image/Env vars
  // collapsed), an interactive form is better served defaulting open so a
  // first-time user actually sees what is available.
  accOpen: Record<string, boolean> = { baseImage: true, envVars: true, jetbrains: true, lifecycle: true };

  get open() { return this.modalService.startOpen(); }

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
    this.mode = 'single';
    this.workspace = '';
    this.mounts = [];
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

  private loadImagesForIde(): void {
    this.api.getImages(this.ide).subscribe({ next: imgs => { this.images = imgs; }, error: () => {} });
    this.api.getBaseImage(this.ide).subscribe({
      next: b => { this.baseImage = b.imageName; if (!this.selectedImage) this.selectedImage = b.imageName; },
      error: () => { this.baseImage = ''; }
    });
  }

  toggleMultiMode(): void {
    this.mode = this.mode === 'multi' ? 'single' : 'multi';
    if (this.mode === 'multi') {
      this.workspace = '';
      if (this.mounts.length === 0) this.addMount();
    } else {
      this.mounts = [];
    }
    this.updateAutoName();
  }

  addMount(): void {
    this.mounts.push({ hostPath: '', containerPath: '' });
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
        row = { hostPath: '', containerPath: '' };
        this.mounts.push(row);
      }
      this.onHostPathInput(row, path);
    }
  }

  removeMount(i: number): void {
    this.mounts.splice(i, 1);
    this.onMountInput();
  }

  onWorkspaceInput(value: string): void {
    this.workspace = value;
    this.updateAutoName();
  }

  // Picking several folders while the dialog is in single-folder mode is not a
  // mistake — it is the answer to a question we asked badly. Switch to
  // multi-folder mode and lay the folders out, instead of making the user back
  // out, tick the checkbox and pick them all over again.
  onWorkspacePicked(paths: string[]): void {
    if (paths.length < 2) return; // one folder: the text box already has it
    this.mode = 'multi';
    this.workspace = '';
    this.mounts = [];
    this.onFoldersPicked(paths);
  }

  /** Same from a mount row: the first folder fills the row, the rest add rows. */
  onMountPicked(paths: string[]): void {
    if (paths.length > 1) this.onFoldersPicked(paths.slice(1));
  }

  // Picking (or typing) a host folder fills in an empty container path with
  // /workspaces/<leaf>: that is what the single-folder mode does anyway, and it
  // is the answer in nearly every case. Only ever fills a BLANK field, so an
  // explicit choice is never overwritten.
  onHostPathInput(mount: { hostPath: string; containerPath: string }, value: string): void {
    mount.hostPath = value;
    if (!mount.containerPath.trim()) {
      const leaf = value.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      if (leaf && !leaf.endsWith(':')) mount.containerPath = `/workspaces/${leaf}`;
    }
    this.onMountInput();
  }

  onMountInput(): void {
    this.updateAutoName();
  }

  private updateAutoName(): void {
    if (this.nameTouched) return;
    if (this.empty) {
      this.containerName = 'devcontainer-empty';
      return;
    }
    if (this.mode === 'multi') {
      const leaf = (this.mounts[0]?.containerPath ?? '').split('/').filter(Boolean).pop() ?? '';
      this.containerName = leaf ? `devcontainer-${leaf}` : '';
      return;
    }
    const leaf = this.workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
    this.containerName = leaf ? `devcontainer-${leaf}` : '';
  }

  onEmptyToggle(): void {
    if (this.empty) {
      this.workspace = '';
      this.mounts = [];
      this.mode = 'single';
      if (!this.nameTouched && !this.containerName) {
        this.containerName = 'devcontainer-empty';
      }
    }
    this.updateAutoName();
  }

  private validate(): string | null {
    if (!this.selectedImage || !this.containerName) return 'All fields are required';
    if (this.empty) return null;
    if (this.mode === 'multi') {
      if (this.mounts.length === 0) return 'Add at least one folder';
      const seen = new Set<string>();
      for (const m of this.mounts) {
        const hostPath = m.hostPath.trim();
        const containerPath = m.containerPath.trim();
        if (!hostPath || !containerPath) return 'Every folder needs a host path and a container path';
        if (!containerPath.startsWith('/')) return `Container path must be absolute: "${containerPath}"`;
        if (seen.has(containerPath)) return `Duplicate container path: ${containerPath}`;
        seen.add(containerPath);
      }
      return null;
    }
    if (!this.workspace) return 'All fields are required';
    return null;
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

  ideMonogram(ide: 'rider' | 'intellij' | 'vscode'): string {
    // Small fallback badge: shared/components has no IDE logo assets in the
    // app-icon registry today (see icons.ts), and this component's file scope
    // doesn't extend to adding new image assets — a monogram is the smallest
    // thing that still visually distinguishes the IDE next to the select.
    return ide === 'vscode' ? 'VS' : ide === 'rider' ? 'R#' : 'IJ';
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

  confirm(): void {
    if (this.kind === 'sandbox') { this.confirmSandbox(); return; }
    if (this.doneWithWarnings) { this.close(); return; }
    const err = this.validate();
    if (err) { this.error = err; return; }

    // JetBrains settings JSON is parsed eagerly, before anything is sent: a bad
    // paste should surface immediately rather than after Docker has already
    // started creating something.
    let jbSettings: Record<string, unknown> | undefined;
    const rawJbSettings = this.jbSettingsJson.trim();
    if (rawJbSettings) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(rawJbSettings);
      } catch (e) {
        this.error = `JetBrains settings is not valid JSON: ${(e as Error).message}`;
        return;
      }
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        this.error = 'JetBrains settings must be a JSON object';
        return;
      }
      jbSettings = parsed as Record<string, unknown>;
    }

    this.error = '';
    this.loading = true;
    this.status = 'Starting container…';
    const isMulti = this.mode === 'multi' && !this.empty;
    this.api.startContainer({
      image: this.selectedImage,
      ide: this.ide,
      workspace: this.mode === 'single' ? this.workspace : '',
      mounts: isMulti
        ? this.mounts.map(m => ({ hostPath: m.hostPath.trim(), containerPath: m.containerPath.trim() }))
        : undefined,
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
    this.error = '';
    this.loading = true;
    this.status = 'Creating sandbox…';
    this.api.startSbx({
      name: this.sbxName.trim() || undefined,
      agent: this.sbxAgent.trim() || undefined,
      workspaces: this.sbxWorkspaces(),
    }).subscribe({
      next: (r) => {
        this.loading = false;
        if (r.ok) {
          this.remember();
          this.modalService.notifySandboxesChanged();
          this.modalService.closeStart();
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
      mode: this.mode,
      workspace: this.workspace,
      mounts: this.mounts.map(m => ({ hostPath: m.hostPath.trim(), containerPath: m.containerPath.trim() })),
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
    if (!layout) return;
    if (layout.mode === 'multi' && layout.mounts?.length) {
      this.mode = 'multi';
      this.mounts = layout.mounts.map(m => ({ hostPath: m.hostPath ?? '', containerPath: m.containerPath ?? '' }));
    } else if (layout.workspace) {
      this.workspace = layout.workspace;
    }
    if (layout.sbxFolders?.length) {
      this.sbxFolders = layout.sbxFolders.map(f => ({ path: f.path ?? '', readOnly: f.readOnly === true }));
    }
    this.updateAutoName();
  }

  close(): void { this.modalService.closeStart(); }
}
