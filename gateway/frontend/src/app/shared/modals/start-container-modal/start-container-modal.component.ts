import { Component, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { IndexedFolder } from '../../../core/services/api.service';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';
import { FolderSelectComponent } from '../../components/folder-select/folder-select.component';
import { FolderPickerModalComponent } from '../folder-picker-modal/folder-picker-modal.component';

// Remembers the last-used multi-folder layout so the modal pre-fills it next time.
const REMEMBER_KEY = 'huddle.start-modal.v1';

interface RememberedLayout {
  mode: 'single' | 'multi';
  workspace: string;
  mounts: { hostPath: string; containerPath: string }[];
  containerWorkspace: string;
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
  `]
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

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
  // The container path the IDE opens as its project root ("open at"). Editable;
  // auto-suggested from the common parent of the mount targets until touched.
  containerWorkspace = '';
  workspaceRootTouched = false;
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
    this.containerWorkspace = '';
    this.workspaceRootTouched = false;
    this.containerName = '';
    this.nameTouched = false;
    this.empty = false;
    this.error = '';
    this.status = '';
    this.loading = false;
    this.restoreRemembered();
    this.loadImagesForIde();
    this.api.getIndexedFolders().subscribe({
      next: r => { this.indexedFolders = r.folders; },
      // No index is a normal state (nobody ran `huddle indexfolder` yet), and the
      // inputs still take free text — so a failure here must not block the modal.
      error: () => { this.indexedFolders = []; },
    });
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
      this.containerWorkspace = '';
      this.workspaceRootTouched = false;
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
    this.workspaceRootTouched = false;
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
    this.suggestWorkspaceRoot();
    this.updateAutoName();
  }

  onWorkspaceRootInput(): void {
    this.workspaceRootTouched = true;
  }

  // Until the user edits the "open at" field, keep it in sync with the deepest
  // common parent of the container paths typed so far.
  private suggestWorkspaceRoot(): void {
    if (this.workspaceRootTouched) return;
    const targets = this.mounts.map(m => m.containerPath.trim()).filter(p => p.startsWith('/'));
    this.containerWorkspace = targets.length ? this.commonParent(targets) : '';
  }

  private commonParent(paths: string[]): string {
    const split = paths.map(p => p.split('/').filter(Boolean));
    const first = split[0];
    const shared: string[] = [];
    for (let i = 0; i < first.length; i++) {
      const seg = first[i];
      if (split.every(parts => parts[i] === seg)) shared.push(seg);
      else break;
    }
    return '/' + shared.join('/');
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
      this.containerWorkspace = '';
      this.workspaceRootTouched = false;
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
      if (!this.containerWorkspace.trim().startsWith('/')) return 'Open the IDE at an absolute path (e.g. /workspace)';
      return null;
    }
    if (!this.workspace) return 'All fields are required';
    return null;
  }

  confirm(): void {
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
      containerWorkspace: isMulti ? this.containerWorkspace.trim() : undefined,
      containerName: this.containerName,
      empty: this.empty,
    }).subscribe({
      next: () => { this.remember(); this.loading = false; this.modalService.closeStart(); this.state.loadAll(); },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  private remember(): void {
    if (this.empty) return;
    const layout: RememberedLayout = {
      mode: this.mode,
      workspace: this.workspace,
      mounts: this.mounts.map(m => ({ hostPath: m.hostPath.trim(), containerPath: m.containerPath.trim() })),
      containerWorkspace: this.containerWorkspace.trim(),
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
      this.containerWorkspace = layout.containerWorkspace ?? '';
      this.workspaceRootTouched = !!this.containerWorkspace;
    } else if (layout.workspace) {
      this.workspace = layout.workspace;
    }
    this.updateAutoName();
  }

  close(): void { this.modalService.closeStart(); }
}
