import { Component, inject } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';

@Component({
  selector: 'app-snapshot-modal',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './snapshot-modal.component.html',
  styles: []
})
export class SnapshotModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  imageName = '';
  error = '';

  get open() { return this.modalService.snapshotOpen(); }
  get data() { return this.modalService.snapshotData(); }

  confirm(): void {
    if (!this.imageName.trim()) { this.error = 'Name is required'; return; }
    this.error = '';
    this.api.snapshotContainer(this.data!.containerName, this.imageName).subscribe({
      next: () => { this.modalService.closeSnapshot(); this.state.loadAll(); },
      error: (err) => { this.error = err.message; },
    });
  }

  close(): void { this.modalService.closeSnapshot(); }
}
