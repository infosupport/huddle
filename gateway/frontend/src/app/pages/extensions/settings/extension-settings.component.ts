import { Component, inject, OnInit, signal } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { FormsModule } from '@angular/forms';
import { forkJoin } from 'rxjs';
import { ApiService } from '../../../core/services/api.service';
import { Extension, ExtensionSetting } from '../../../core/extensions/extension.model';

@Component({
  selector: 'app-extension-settings',
  standalone: true,
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page-header">
      <h1>{{ extension()?.name ?? 'Extension' }} — settings</h1>
    </div>
    <div class="card">
      @if (error()) {
        <p class="empty-note">{{ error() }}</p>
      } @else if (extension(); as ext) {
        <form (ngSubmit)="save()">
          @for (s of ext.settings; track s.key) {
            <div class="field">
              <label [attr.for]="s.key">{{ s.label }}</label>
              <input
                [id]="s.key"
                [type]="s.secret ? 'password' : 'text'"
                [name]="s.key"
                [(ngModel)]="values[s.key]"
                [placeholder]="placeholder(s)"
                autocomplete="off" />
            </div>
          }
          <div class="actions">
            <button type="submit" class="btn btn--primary" [disabled]="saving()">
              {{ saving() ? 'Saving…' : 'Save' }}
            </button>
            <a class="btn" routerLink="/extensions">Back</a>
            @if (saved()) { <span class="saved-note">Saved</span> }
          </div>
        </form>
      }
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .field { margin-bottom: 16px; max-width: 480px; }
    .field label { display: block; margin-bottom: 6px; font-weight: 600; }
    .field input { width: 100%; padding: 8px 10px; box-sizing: border-box; }
    .actions { display: flex; align-items: center; gap: 12px; }
    .saved-note { color: var(--ok, #3fbf6f); }
  `]
})
export class ExtensionSettingsComponent implements OnInit {
  private api = inject(ApiService);
  private route = inject(ActivatedRoute);

  extension = signal<Extension | null>(null);
  values: Record<string, string> = {};
  hasSecret: Record<string, boolean> = {};
  error = signal<string | null>(null);
  saving = signal(false);
  saved = signal(false);

  private id = '';

  ngOnInit(): void {
    this.id = this.route.snapshot.paramMap.get('id') ?? '';
    forkJoin({
      extensions: this.api.getExtensions(),
      settings: this.api.getExtensionSettings(this.id),
    }).subscribe({
      next: ({ extensions, settings }) => {
        const ext = extensions.find((e) => e.id === this.id) ?? null;
        this.extension.set(ext);
        if (!ext) { this.error.set('Unknown extension'); return; }
        for (const s of ext.settings) {
          if (s.secret) {
            this.hasSecret[s.key] = Boolean(settings[`has${this.cap(s.key)}`]);
            this.values[s.key] = '';
          } else {
            this.values[s.key] = String(settings[s.key] ?? '');
          }
        }
      },
      error: (e) => this.error.set(e.message),
    });
  }

  placeholder(s: ExtensionSetting): string {
    if (s.secret) return this.hasSecret[s.key] ? '•••••••• (leave empty to keep)' : '';
    return '';
  }

  save(): void {
    this.saving.set(true);
    this.saved.set(false);
    const payload: Record<string, string> = {};
    for (const [k, v] of Object.entries(this.values)) {
      if (v !== '') payload[k] = v;
      else if (!this.isSecret(k)) payload[k] = v;
    }
    this.api.saveExtensionSettings(this.id, payload).subscribe({
      next: () => { this.saving.set(false); this.saved.set(true); },
      error: (e) => { this.saving.set(false); this.error.set(e.message); },
    });
  }

  private isSecret(key: string): boolean {
    return this.extension()?.settings.find((s) => s.key === key)?.secret ?? false;
  }

  private cap(s: string): string {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
