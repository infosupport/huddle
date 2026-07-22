import { Component, inject } from '@angular/core';
import { ModalService } from '../../../core/services/modal.service';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';

@Component({
  selector: 'app-confirm-modal',
  standalone: true,
  imports: [],
  templateUrl: './confirm-modal.component.html',
  styles: []
})
export class ConfirmModalComponent {
  modalService = inject(ModalService);
  private api = inject(ApiService);
  private state = inject(StateService);

  get open() { return this.modalService.confirmOpen(); }
  get data() { return this.modalService.confirmData(); }

  get message(): string {
    if (!this.data) return '';
    const verb = this.data.status === 'allow' ? 'allow' : 'block';
    return `Globally ${verb} "${this.data.rule.domain}" for all containers?`;
  }

  confirm(): void {
    if (!this.data) return;
    const { rule, status } = this.data;
    this.api.resolveRule(rule.id, status, 'global').subscribe(() => {
      this.modalService.closeConfirm();
      // Ververst de gedeelde rules$-stroom; pagina's met eigen lokale data
      // (container-detail) luisteren daarop en herladen hun view mee.
      this.state.loadAll();
    });
  }

  close(): void { this.modalService.closeConfirm(); }
}
