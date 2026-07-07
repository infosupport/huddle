import { Component, inject, effect } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { DockerImage } from '../../../core/models/container.model';
import { FmtBytesPipe } from '../../pipes/fmt-bytes.pipe';

@Component({
  selector: 'app-start-container-modal',
  standalone: true,
  imports: [FormsModule, FmtBytesPipe],
  templateUrl: './start-container-modal.component.html',
  styles: []
})
export class StartContainerModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  images: DockerImage[] = [];
  baseImage = '';
  selectedImage = '';
  ide: 'rider' | 'intellij' | 'vscode' = 'intellij';
  workspace = '';
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
    this.workspace = '';
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

  onWorkspaceInput(): void {
    if (!this.nameTouched) {
      const leaf = this.workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      this.containerName = leaf ? `devcontainer-${leaf}` : '';
    }
  }

  onEmptyToggle(): void {
    if (this.empty) {
      this.workspace = '';
      if (!this.nameTouched && !this.containerName) {
        this.containerName = 'devcontainer-empty';
      }
    }
  }

  confirm(): void {
    if (!this.selectedImage || !this.containerName || (!this.empty && !this.workspace)) {
      this.error = 'All fields are required'; return;
    }
    this.error = '';
    this.loading = true;
    this.status = 'Starting container…';
    this.api.startContainer({
      image: this.selectedImage,
      ide: this.ide,
      workspace: this.workspace,
      containerName: this.containerName,
      empty: this.empty,
    }).subscribe({
      next: () => { this.loading = false; this.modalService.closeStart(); this.state.loadAll(); },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  close(): void { this.modalService.closeStart(); }
}
