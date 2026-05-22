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
  ide = 'intellij';
  workspace = '';
  containerName = '';
  nameTouched = false;
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
    this.error = '';
    this.status = '';
    this.loading = false;

    this.api.getImages().subscribe({ next: imgs => { this.images = imgs; }, error: () => {} });
    this.api.getBaseImage().subscribe({ next: b => { this.baseImage = b.imageName; }, error: () => {} });
  }

  onWorkspaceInput(): void {
    if (!this.nameTouched) {
      const leaf = this.workspace.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
      this.containerName = leaf ? `devcontainer-${leaf}` : '';
    }
  }

  confirm(): void {
    if (!this.selectedImage || !this.workspace || !this.containerName) {
      this.error = 'Alle velden zijn verplicht'; return;
    }
    this.error = '';
    this.loading = true;
    this.status = 'Container wordt gestart…';
    this.api.startContainer({
      image: this.selectedImage,
      ide: this.ide,
      workspace: this.workspace,
      containerName: this.containerName,
    }).subscribe({
      next: () => { this.loading = false; this.modalService.closeStart(); this.state.loadAll(); },
      error: (err) => { this.error = err.message; this.status = ''; this.loading = false; },
    });
  }

  close(): void { this.modalService.closeStart(); }
}
