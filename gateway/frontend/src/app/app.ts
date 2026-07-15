import { Component, inject, OnInit } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SidebarComponent } from './layout/sidebar/sidebar.component';
import { TopbarComponent } from './layout/topbar/topbar.component';
import { SnapshotModalComponent } from './shared/modals/snapshot-modal/snapshot-modal.component';
import { StartContainerModalComponent } from './shared/modals/start-container-modal/start-container-modal.component';
import { ConfirmModalComponent } from './shared/modals/confirm-modal/confirm-modal.component';
import { BugButtonComponent } from './shared/components/bug-button/bug-button.component';
import { LoginComponent } from './core/components/login.component';
import { AuthService } from './core/services/auth.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SidebarComponent, TopbarComponent, SnapshotModalComponent, StartContainerModalComponent, ConfirmModalComponent, BugButtonComponent, LoginComponent],
  templateUrl: './app.html',
  styleUrl: './app.css'
})
export class App implements OnInit {
  auth = inject(AuthService);

  // Bepaal de auth-status vóór de shell rendert. De shell-componenten
  // (sidebar/topbar/router-outlet) injecteren StateService, die bij constructie
  // meteen API-calls + WS opent; door de shell pas te tonen wanneer
  // geauthenticeerd, doen we die calls niet vanaf het login-scherm.
  async ngOnInit(): Promise<void> {
    // Auto-login via ?token=... in de URL (de link die `huddle init` logt), zodat
    // de operator niets hoeft te plakken. Na gebruik strippen we het token uit de
    // adresbalk zodat het niet in history/bookmarks blijft hangen.
    const params = new URLSearchParams(location.search);
    const urlToken = params.get('token');
    if (urlToken) {
      await this.auth.login(urlToken);
      params.delete('token');
      const qs = params.toString();
      history.replaceState(null, '', location.pathname + (qs ? `?${qs}` : '') + location.hash);
    }
    // Al ingelogd via het URL-token? Dan is de status al bekend; anders opvragen.
    if (this.auth.authenticated() !== true) {
      await this.auth.refresh();
    }
  }
}
