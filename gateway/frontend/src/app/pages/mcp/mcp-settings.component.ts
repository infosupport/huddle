import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/services/api.service';
import { McpServer } from '../../core/models/mcp.model';

@Component({
  selector: 'app-mcp-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page-header">
      <h1>{{ server()?.name ?? 'MCP' }} — Instellingen</h1>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }
    @if (server()) {
      <div class="card">
        <form (ngSubmit)="save()">
          @for (setting of server()!.settings; track setting.key) {
            <div class="field">
              <label>{{ setting.label }}</label>
              <input
                [type]="setting.secret ? 'password' : 'text'"
                [(ngModel)]="values[setting.key]"
                [name]="setting.key"
                [placeholder]="setting.secret ? '(niet getoond)' : ''"
                autocomplete="off"
              >
            </div>
          }
          <div class="actions">
            <button type="submit" class="btn btn--accent" [disabled]="saving()">
              {{ saving() ? 'Opslaan…' : 'Opslaan' }}
            </button>
            @if (saved()) { <span class="saved-note">Opgeslagen</span> }
          </div>
        </form>
      </div>
    }
  `,
  styles: [`
    :host { display: contents; }
    .page-header { margin-bottom: 16px; }
    .error-note { color: var(--danger, #e06c75); }
    .field { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-size: 0.9em; color: var(--muted, #888); }
    input { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border, #2a2a2a); background: var(--bg2, #1a1a2e); color: inherit; font-size: 0.95em; box-sizing: border-box; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .saved-note { color: #4caf50; font-size: 0.9em; }
  `]
})
export class McpSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  server = signal<McpServer | null>(null);
  values: Record<string, string> = {};
  error = signal<string | null>(null);
  saving = signal(false);
  saved = signal(false);

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.api.getMcpServers().subscribe({
      next: (list) => {
        const srv = list.find(s => s.id === id);
        if (!srv) { this.error.set('MCP server niet gevonden'); return; }
        this.server.set(srv);
        this.api.getMcpSettings(id).subscribe({
          next: (vals) => { this.values = { ...vals }; },
          error: (e) => this.error.set(e.message),
        });
      },
      error: (e) => this.error.set(e.message),
    });
  }

  save(): void {
    const id = this.server()?.id;
    if (!id) return;
    this.saving.set(true);
    this.saved.set(false);
    this.api.saveMcpSettings(id, this.values).subscribe({
      next: () => { this.saving.set(false); this.saved.set(true); },
      error: (e) => { this.saving.set(false); this.error.set(e.message); },
    });
  }
}
