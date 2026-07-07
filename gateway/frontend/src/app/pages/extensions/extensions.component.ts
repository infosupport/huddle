import { Component, inject, OnInit, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { ApiService } from '../../core/services/api.service';
import { Extension } from '../../core/extensions/extension.model';
import { IconComponent } from '../../shared/components/icon/icon.component';

@Component({
  selector: 'app-extensions',
  standalone: true,
  imports: [RouterLink, IconComponent],
  template: `
    <div class="page-header">
      <h1>Extensions</h1>
      <label class="btn btn--accent" [class.btn--busy]="uploading()">
        {{ uploading() ? 'Uploading…' : 'Upload extension (.zip)' }}
        <input type="file" accept=".zip" (change)="uploadExtension($event)" [disabled]="uploading()" hidden>
      </label>
    </div>
    <div class="card">
      @if (error()) {
        <p class="empty-note">{{ error() }}</p>
      }
      @if (notice()) {
        <p class="notice">{{ notice() }}</p>
      }
      @if (extensions().length === 0) {
        <p class="empty-note">No extensions installed</p>
      } @else {
        <ul class="ext-list">
          @for (ext of extensions(); track ext.id) {
            <li class="ext-item">
              <app-icon [name]="ext.icon" [size]="22" />
              <span class="ext-name">{{ ext.name }}</span>
              @if (ext.version) { <span class="ext-version">v{{ ext.version }}</span> }
              <a class="ext-open" [routerLink]="['/extensions/view', ext.id]">Open</a>
              @if (ext.settings.length > 0) {
                <a class="ext-link" [routerLink]="['/extensions', ext.id, 'settings']">Settings</a>
              }
              <button class="ext-del" type="button" (click)="removeExtension(ext)">Remove</button>
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .page-header { display: flex; align-items: center; justify-content: space-between; gap: 16px; }
    .btn--busy { opacity: 0.6; pointer-events: none; }
    .ext-list { list-style: none; margin: 0; padding: 0; }
    .ext-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border, #2a2a2a); }
    .ext-item:last-child { border-bottom: none; }
    .ext-name { font-weight: 600; }
    .ext-version { color: var(--muted, #888); font-size: 0.85em; flex: 1; }
    .ext-name:last-of-type { flex: 1; }
    .ext-open { background: var(--accent, #4da3ff); color: #fff; text-decoration: none; padding: 3px 10px; border-radius: 4px; font-size: 0.85em; }
    .ext-open:hover { opacity: 0.85; }
    .ext-link { color: var(--accent, #4da3ff); text-decoration: none; }
    .ext-link:hover { text-decoration: underline; }
    .ext-del { background: none; border: none; color: var(--danger, #e06c75); cursor: pointer; padding: 0; }
    .ext-del:hover { text-decoration: underline; }
    .notice { color: var(--accent, #4da3ff); margin: 0 0 12px; }
  `]
})
export class ExtensionsPageComponent implements OnInit {
  private api = inject(ApiService);

  extensions = signal<Extension[]>([]);
  error = signal<string | null>(null);
  notice = signal<string | null>(null);
  uploading = signal(false);

  ngOnInit(): void {
    this.loadExtensions();
  }

  private loadExtensions(): void {
    this.api.getExtensions().subscribe({
      next: (ext) => this.extensions.set(ext),
      error: (e) => this.error.set(e.message),
    });
  }

  uploadExtension(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.uploading.set(true);
    this.error.set(null);
    this.api.uploadExtension(file).subscribe({
      next: (res) => {
        this.uploading.set(false);
        input.value = '';
        if (res.restartRequired) {
          this.notice.set(`"${res.name}" uploaded — restart Huddle to activate the new version.`);
        } else {
          this.notice.set(null);
        }
        this.loadExtensions();
      },
      error: (e) => { this.uploading.set(false); input.value = ''; this.error.set(e.message); },
    });
  }

  removeExtension(ext: Extension): void {
    if (!confirm(`Remove extension "${ext.name}"?`)) return;
    this.api.deleteExtension(ext.id).subscribe({
      next: () => {
        this.notice.set(`"${ext.name}" removed — restart Huddle to release the routes.`);
        this.loadExtensions();
      },
      error: (e) => this.error.set(e.message),
    });
  }
}
