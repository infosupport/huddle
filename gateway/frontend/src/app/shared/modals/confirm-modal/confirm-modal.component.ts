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
    const verb = this.data.status === 'allow' ? 'toestaan' : 'blokkeren';
    return `"${this.data.domain}" globaal ${verb} voor alle containers?`;
  }

  confirm(): void {
    if (!this.data) return;
    const { domain, status } = this.data;
    this.api.createRule(domain, null, status).subscribe({
      next: () => { this.modalService.closeConfirm(); this.state.loadAll(); },
      error: () => {
        this.api.getRules({ container: '__global__' }).subscribe(rules => {
          const existing = rules.find(r => r.domain === domain);
          if (existing) {
            this.api.updateRule(existing.id, status).subscribe(() => {
              this.modalService.closeConfirm();
              this.state.loadAll();
            });
          }
        });
      },
    });
  }

  close(): void { this.modalService.closeConfirm(); }
}
