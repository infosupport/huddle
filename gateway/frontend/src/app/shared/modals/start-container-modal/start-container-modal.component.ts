import { Component, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { IndexedFolder, SbxSettingsFolders } from '../../../core/services/api.service';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';
import { FolderSelectComponent } from '../../components/folder-select/folder-select.component';
import { FolderPickerModalComponent } from '../folder-picker-modal/folder-picker-modal.component';

// Remembers the last-used multi-folder layout so the modal pre-fills it next time.
const REMEMBER_KEY = 'huddle.start-modal.v1';

interface RememberedLayout {
  mode: 'single' | 'multi';
  workspace: string;
  mounts: { hostPath: string; containerPath: string }[];
  /** Last-used sandbox folder list (host paths; sbx mounts them at the same path). */
  sbxFolders?: { path: string; readOnly: boolean }[];
}

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, FmtBytesPipe, FolderSelectComponent, FolderPickerModalComponent],
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
    .env-kind { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 14px; }
    .env-kind__opt { display: flex; flex-direction: column; gap: 2px; text-align: left; cursor: pointer;
      border: 1px solid var(--border); border-radius: 10px; padding: 10px 12px; background: var(--surface); color: var(--text); }
    .env-kind__opt:hover { border-color: var(--border-strong); }
    .env-kind__opt.on { border-color: var(--accent, #5865f2); box-shadow: 0 0 0 1px var(--accent, #5865f2) inset; }
    .env-kind__opt b { font-size: 13.5px; }
    .env-kind__opt span { font-size: 11px; color: var(--text-muted); }
  `]
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  // Which kind of dev environment to create. Always defaults to 'sandbox' on open
  // (the primary box type); the user can switch to 'container' per-open.
  kind: 'sandbox' | 'container' = 'sandbox';

  // sandbox fields. A sandbox can hold several folders: the FIRST is the one the
  // agent starts in, the rest ride along. Unlike a devcontainer mount there is no
  // container path to pick — sbx mounts every folder at its own host path.
  sbxName = '';
  sbxAgent = 'claude';
  sbxFolders: { path: string; readOnly: boolean }[] = [{ path: '', readOnly: false }];
  sbxSettings: SbxSettingsFolders | null = null;

  images: DockerImage[] = [];
  // Host folders indexed by `huddle indexfolder`; loaded once per open and passed
  // to every folder input, so N mount rows do not each fetch the same list.
  indexedFolders: IndexedFolder[] = [];
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
    this.kind = 'sandbox'; // always default to Sandbox on open (the primary box type)
    this.restoreRemembered();
    this.loadImagesForIde();
    this.api.getIndexedFolders().subscribe({
      next: r => { this.indexedFolders = r.folders; },
      // No index is a normal state (nobody ran `huddle indexfolder` yet), and the
      // inputs still take free text — so a failure here must not block the modal.
      error: () => { this.indexedFolders = []; },
    });
    // Show which settings folders (folder mappings) the sandbox will get, and
    // which mappings cannot travel — that difference is otherwise invisible.
    this.api.sbxSettingsFolders().subscribe({
      next: (s) => { this.sbxSettings = s; },
      error: () => { this.sbxSettings = null; },
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
  // paths that are not indexed) stay, and a folder already listed is not added
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
  // already filled in (including hand-typed paths that are not indexed) stay,
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

  confirm(): void {
    if (this.kind === 'sandbox') { this.confirmSandbox(); return; }
    const err = this.validate();
    if (err) { this.error = err; return; }
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
    }).subscribe({
      next: () => { this.remember(); this.loading = false; this.modalService.closeStart(); this.state.loadAll(); },
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
