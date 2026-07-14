import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { firstValueFrom } from 'rxjs';

// Operator-authenticatie voor de portal. De session-cookie is httpOnly (niet
// leesbaar vanuit JS); we kennen dus alleen de status via /api/auth/status. Het
// `authenticated`-signal stuurt de app-shell: null = nog onbekend (laden),
// false = login tonen, true = app tonen. De 401-interceptor zet 'm op false
// zodra een API-call ongeauthenticeerd terugkomt (bv. na cookie-expiry).
@Injectable({ providedIn: 'root' })
export class AuthService {
  private http = inject(HttpClient);
  readonly authenticated = signal<boolean | null>(null);

  async refresh(): Promise<boolean> {
    try {
      const res = await firstValueFrom(
        this.http.get<{ authenticated: boolean }>('/api/auth/status'),
      );
      this.authenticated.set(res.authenticated);
      return res.authenticated;
    } catch {
      this.authenticated.set(false);
      return false;
    }
  }

  async login(token: string): Promise<boolean> {
    try {
      await firstValueFrom(this.http.post('/api/auth/login', { token }));
      this.authenticated.set(true);
      return true;
    } catch {
      this.authenticated.set(false);
      return false;
    }
  }

  async logout(): Promise<void> {
    try {
      await firstValueFrom(this.http.post('/api/auth/logout', {}));
    } finally {
      this.authenticated.set(false);
    }
  }
}
