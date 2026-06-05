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
    <div class="page-header"><h1>Extensies</h1></div>
    <div class="card">
      @if (error()) {
        <p class="empty-note">{{ error() }}</p>
      } @else if (extensions().length === 0) {
        <p class="empty-note">Geen extensies geïnstalleerd</p>
      } @else {
        <ul class="ext-list">
          @for (ext of extensions(); track ext.id) {
            <li class="ext-item">
              <app-icon [name]="ext.icon" [size]="22" />
              <span class="ext-name">{{ ext.name }}</span>
              @if (ext.settings.length > 0) {
                <a class="ext-link" [routerLink]="['/extensions', ext.id, 'settings']">Instellingen</a>
              }
            </li>
          }
        </ul>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .ext-list { list-style: none; margin: 0; padding: 0; }
    .ext-item { display: flex; align-items: center; gap: 12px; padding: 12px 0; border-bottom: 1px solid var(--border, #2a2a2a); }
    .ext-item:last-child { border-bottom: none; }
    .ext-name { font-weight: 600; flex: 1; }
    .ext-link { color: var(--accent, #4da3ff); text-decoration: none; }
    .ext-link:hover { text-decoration: underline; }
  `]
})
export class ExtensionsPageComponent implements OnInit {
  private api = inject(ApiService);

  extensions = signal<Extension[]>([]);
  error = signal<string | null>(null);

  ngOnInit(): void {
    this.api.getExtensions().subscribe({
      next: (ext) => this.extensions.set(ext),
      error: (e) => this.error.set(e.message),
    });
  }
}
