import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../services/auth.service';

// Login-scherm voor de operator. Vraagt het operator-token (uit de huddle-
// container-logs of `huddle init`-output) en wisselt het via /api/auth/login in
// voor een httpOnly session-cookie. Getoond door de app-shell zolang de
// operator niet geauthenticeerd is.
@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="login-backdrop">
      <form class="login-card" (ngSubmit)="submit()">
        <h1>Huddle</h1>
        <p class="login-hint">Operator login required. Use the auto-login link from the <code>huddle init</code> output, or paste the operator token below (also shown in the huddle container logs).</p>
        <input
          type="password"
          name="token"
          [(ngModel)]="token"
          placeholder="Operator token"
          autocomplete="off"
          autofocus
          [disabled]="busy()" />
        @if (error()) { <p class="login-error">{{ error() }}</p> }
        <button type="submit" [disabled]="busy() || !token">
          {{ busy() ? 'Signing in…' : 'Sign in' }}
        </button>
      </form>
    </div>
  `,
  styles: [`
    .login-backdrop {
      position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
      background: var(--bg, #12141a); z-index: 1000;
    }
    .login-card {
      display: flex; flex-direction: column; gap: 12px; width: 340px; max-width: 90vw;
      padding: 28px; border-radius: 12px; background: var(--card, #1b1e26);
      box-shadow: 0 8px 40px rgba(0,0,0,.4); border: 1px solid var(--border, #2a2e3a);
    }
    .login-card h1 { margin: 0; font-size: 22px; }
    .login-hint { margin: 0; font-size: 13px; color: var(--muted, #8a90a2); line-height: 1.5; }
    .login-hint code { background: rgba(255,255,255,.06); padding: 1px 5px; border-radius: 4px; }
    .login-card input {
      padding: 10px 12px; border-radius: 8px; border: 1px solid var(--border, #2a2e3a);
      background: var(--input, #12141a); color: inherit; font-size: 14px;
    }
    .login-error { margin: 0; font-size: 13px; color: #ff6b6b; }
    .login-card button {
      padding: 10px 12px; border-radius: 8px; border: none; cursor: pointer;
      background: var(--accent, #4a7dff); color: #fff; font-size: 14px; font-weight: 600;
    }
    .login-card button:disabled { opacity: .6; cursor: default; }
  `],
})
export class LoginComponent {
  private auth = inject(AuthService);
  token = '';
  busy = signal(false);
  error = signal('');

  async submit(): Promise<void> {
    if (!this.token || this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    const ok = await this.auth.login(this.token);
    this.busy.set(false);
    if (!ok) {
      this.error.set('Invalid token.');
      return;
    }
    // Herlaad zodat state-service/WS met de nieuwe cookie (her)initialiseren.
    location.reload();
  }
}
