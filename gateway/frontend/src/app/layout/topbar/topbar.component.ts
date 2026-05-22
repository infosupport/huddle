import { Component, inject } from '@angular/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { ThemeService } from '../../core/services/theme.service';
import { ModalService } from '../../core/services/modal.service';
import { NotificationService } from '../../core/services/notification.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [AsyncPipe, NgClass],
  templateUrl: './topbar.component.html',
  styles: []
})
export class TopbarComponent {
  themeService = inject(ThemeService);
  modalService = inject(ModalService);
  notificationService = inject(NotificationService);
}
