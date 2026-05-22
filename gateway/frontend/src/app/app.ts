import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { TopbarComponent } from './layout/topbar/topbar.component';
import { SnapshotModalComponent } from './shared/modals/snapshot-modal/snapshot-modal.component';
import { StartContainerModalComponent } from './shared/modals/start-container-modal/start-container-modal.component';
import { ConfirmModalComponent } from './shared/modals/confirm-modal/confirm-modal.component';
import { BugButtonComponent } from './shared/components/bug-button/bug-button.component';
import { ModalService } from './core/services/modal.service';
import { StateService } from './core/services/state.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, TopbarComponent, SnapshotModalComponent, StartContainerModalComponent, ConfirmModalComponent, BugButtonComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App {
  modalService = inject(ModalService);
  stateService = inject(StateService);
}
