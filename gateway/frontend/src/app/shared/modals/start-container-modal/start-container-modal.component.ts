import { Component, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';

const MOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, FmtBytesPipe],
  templateUrl: './start-container-modal.component.html',
  styles: [`
    .mount-row { display: flex; gap: .5rem; align-items: center; }
    .mount-row input:first-child { flex: 0 0 35%; }
    .mount-row input:nth-child(2) { flex: 1; }
    .mount-row .btn { flex: 0 0 auto; }
    .btn-context-on { color: var(--warning, #d97706); }
    .mount-context-hint { font-size: 12px; color: var(--text-muted); margin: -.25rem 0 .5rem; }
  `]
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  images: DockerImage[] = [];
  baseImage = '';
  selectedImage = '';
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  mode: 'single' | 'multi' = 'single';
  workspace = '';
  mounts: { name: string; path: string }[] = [];
  contextMountIndex: number | null = null;
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
    this.contextMountIndex = null;
    this.containerName = '';
    this.nameTouched = false;
    this.empty = false;
    this.error = '';
    this.status = '';
    this.loading = false;
    this.loadImagesForIde();
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
      this.contextMountIndex = null;
    }
    this.updateAutoName();
  }

  addMount(): void {
    this.mounts.push({ name: '', path: '' });
  }

  removeMount(i: number): void {
    this.mounts.splice(i, 1);
    if (this.contextMountIndex === i) this.contextMountIndex = null;
    else if (this.contextMountIndex !== null && this.contextMountIndex > i) this.contextMountIndex--;
    this.updateAutoName();
  }

  toggleContext(i: number): void {
    this.contextMountIndex = this.contextMountIndex === i ? null : i;
  }

  onWorkspaceInput(): void {
    this.updateAutoName();
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
      const leaf = (this.mounts[0]?.name ?? '').trim();
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
      this.contextMountIndex = null;
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
        const name = m.name.trim();
        const path = m.path.trim();
        if (!name || !path) return 'Every folder needs a name and a path';
        if (!MOUNT_NAME_RE.test(name)) return `Invalid folder name: "${name}" (letters, digits, '-', '_' only)`;
        if (seen.has(name)) return `Duplicate folder name: ${name}`;
        seen.add(name);
      }
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
        ? this.mounts.map(m => ({ name: m.name.trim(), path: m.path.trim() }))
        : undefined,
      contextMount: isMulti && this.contextMountIndex !== null
        ? this.mounts[this.contextMountIndex].name.trim()
        : undefined,
      containerName: this.containerName,
      empty: this.empty,
    }).subscribe({
      next: () => { this.loading = false; this.modalService.closeStart(); this.state.loadAll(); },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  close(): void { this.modalService.closeStart(); }
}
