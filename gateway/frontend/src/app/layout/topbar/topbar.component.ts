import { Component, inject } from '@angular/core';
import { AsyncPipe } from '@angular/common';
import { ThemeService } from '../../core/services/theme.service';
import { ModalService } from '../../core/services/modal.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [AsyncPipe],
  templateUrl: './topbar.component.html',
  styles: []
})
export class TopbarComponent {
  themeService = inject(ThemeService);
  modalService = inject(ModalService);
}
