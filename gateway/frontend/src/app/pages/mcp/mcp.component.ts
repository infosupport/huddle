import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { McpServer } from '../../core/models/mcp.model';

@Component({
  selector: 'app-mcp',
  standalone: true,
  imports: [RouterLink],
  template: `
    <div class="page-header">
      <h1>MCP Servers</h1>
      <label class="btn btn--accent" [class.btn--busy]="uploading()">
        {{ uploading() ? 'Uploaden…' : 'Manifest uploaden (.json)' }}
        <input type="file" accept=".json" (change)="uploadManifest($event)" [disabled]="uploading()" hidden>
      </label>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }
    <div class="card">
      @if (servers().length === 0) {
        <p class="empty-note">Geen MCP-servers geconfigureerd</p>
      } @else {
        <ul class="mcp-list">
          @for (srv of servers(); track srv.id) {
            <li class="mcp-item">
              <span class="mcp-status" [class]="'status-' + srv.status" [title]="srv.status"></span>
              <span class="mcp-name">{{ srv.name }}</span>
              <span class="mcp-meta">{{ srv.image }} · {{ srv.transport }}</span>
              <span class="mcp-version muted">v{{ srv.version }}</span>
              @if (srv.settings.length > 0) {
                <a class="mcp-link" [routerLink]="['/mcp', srv.id, 'settings']">Instellingen</a>
              }
              @if (srv.status === 'stopped' || srv.status === 'error') {
                <button class="btn-start" type="button" (click)="start(srv)" [disabled]="busy() === srv.id">Starten</button>
              } @else if (srv.status === 'running') {
                <button class="btn-stop" type="button" (click)="stop(srv)" [disabled]="busy() === srv.id">Stoppen</button>
              } @else {
                <span class="mcp-starting">bezig…</span>
              }
              <button class="mcp-del" type="button" (click)="remove(srv)">Verwijderen</button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 16px; }
    .btn--busy { opacity: 0.6; pointer-events: none; }
    .error-note { color: var(--danger, #e06c75); margin: 0 0 12px; }
    .mcp-list { list-style: none; margin: 0; padding: 0; }
    .mcp-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border, #2a2a2a); }
    .mcp-item:last-child { border-bottom: none; }
    .mcp-status { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; background: var(--muted, #888); }
    .mcp-status.status-running { background: #4caf50; }
    .mcp-status.status-error { background: var(--danger, #e06c75); }
    .mcp-status.status-starting { background: #ff9800; }
    .mcp-name { font-weight: 600; }
    .mcp-meta { color: var(--muted, #888); font-size: 0.82em; flex: 1; }
    .mcp-version { font-size: 0.82em; }
    .muted { color: var(--muted, #888); }
    .mcp-link { color: var(--accent, #4da3ff); text-decoration: none; }
    .mcp-link:hover { text-decoration: underline; }
    .btn-start { background: var(--accent, #4da3ff); color: #fff; border: none; border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 0.85em; }
    .btn-start:disabled, .btn-stop:disabled { opacity: 0.5; cursor: default; }
    .btn-stop { background: none; border: 1px solid var(--muted, #888); border-radius: 4px; padding: 4px 12px; cursor: pointer; font-size: 0.85em; color: inherit; }
    .mcp-starting { font-size: 0.85em; color: #ff9800; }
    .mcp-del { background: none; border: none; color: var(--danger, #e06c75); cursor: pointer; padding: 0; margin-left: auto; }
    .mcp-del:hover { text-decoration: underline; }
  `]
})
export class McpPageComponent implements OnInit {
  private api = inject(ApiService);

  servers = signal<McpServer[]>([]);
  error = signal<string | null>(null);
  uploading = signal(false);
  busy = signal<string | null>(null);

  ngOnInit(): void { this.load(); }

  private load(): void {
    this.api.getMcpServers().subscribe({
      next: (s) => this.servers.set(s),
      error: (e) => this.error.set(e.message),
    });
  }

  uploadManifest(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    this.error.set(null);
    const reader = new FileReader();
    reader.onload = () => {
      let parsed: object;
      try { parsed = JSON.parse(reader.result as string); } catch {
        this.error.set('Ongeldig JSON-bestand');
        this.uploading.set(false);
        input.value = '';
        return;
      }
      this.api.uploadMcpManifest(parsed).subscribe({
        next: () => { this.uploading.set(false); input.value = ''; this.load(); },
        error: (e) => { this.uploading.set(false); input.value = ''; this.error.set(e.message); },
      });
    };
    reader.readAsText(file);
  }

  start(srv: McpServer): void {
    this.busy.set(srv.id);
    this.error.set(null);
    this.api.startMcpServer(srv.id).subscribe({
      next: () => { this.busy.set(null); this.load(); },
      error: (e) => { this.busy.set(null); this.error.set(e.message); this.load(); },
    });
  }

  stop(srv: McpServer): void {
    this.busy.set(srv.id);
    this.api.stopMcpServer(srv.id).subscribe({
      next: () => { this.busy.set(null); this.load(); },
      error: (e) => { this.busy.set(null); this.error.set(e.message); this.load(); },
    });
  }

  remove(srv: McpServer): void {
    if (!confirm(`MCP server "${srv.name}" verwijderen?`)) return;
    this.api.deleteMcpServer(srv.id).subscribe({
      next: () => this.load(),
      error: (e) => this.error.set(e.message),
    });
  }
}
