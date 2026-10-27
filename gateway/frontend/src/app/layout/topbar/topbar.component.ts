import { Component, inject } from '@angular/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { RouterLink } from '@angular/router';
import { ThemeService } from '../../core/services/theme.service';
import { NotificationService } from '../../core/services/notification.service';
import { AuthService } from '../../core/services/auth.service';

@Component({
  selector: 'app-topbar',
  standalone: true,
  imports: [AsyncPipe, NgClass, RouterLink],
  templateUrl: './topbar.component.html',
  styles: []
})
export class TopbarComponent {
  themeService = inject(ThemeService);
  notificationService = inject(NotificationService);
  private auth = inject(AuthService);

  async logout(): Promise<void> {
    await this.auth.logout();
    location.reload();
  }
}
