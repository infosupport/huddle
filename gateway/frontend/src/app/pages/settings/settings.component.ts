import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, HuddleSettings } from '../../core/services/api.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page-header">
      <h1>Instellingen</h1>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }
    <div class="card">
      <h2>Resource limieten</h2>
      <p class="hint">
        Standaard CPU- en geheugenlimieten voor nieuwe devcontainers. Laat leeg voor geen limiet.
      </p>
      <form (ngSubmit)="save()">
        <div class="field-row">
          <div class="field">
            <label>Standaard geheugen (bijv. 4g, 2048m)</label>
            <input [(ngModel)]="values.defaultMemory" name="defaultMemory"
                   placeholder="bijv. 4g" autocomplete="off">
          </div>
          <div class="field">
            <label>Standaard CPU (bijv. 2, 0.5)</label>
            <input [(ngModel)]="values.defaultCpus" name="defaultCpus"
                   placeholder="bijv. 2" autocomplete="off">
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn--accent" [disabled]="saving()">
            {{ saving() ? 'Opslaan…' : 'Opslaan' }}
          </button>
          @if (saved()) { <span class="saved-note">Opgeslagen</span> }
        </div>
      </form>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .page-header { margin-bottom: 16px; }
    .error-note { color: var(--danger, #e06c75); }
    h2 { margin: 0 0 8px; font-size: 1.1em; }
    .hint { color: var(--muted, #888); font-size: 0.9em; margin: 0 0 16px; }
    .field { margin-bottom: 16px; flex: 1; }
    .field-row { display: flex; gap: 16px; flex-wrap: wrap; }
    label { display: block; margin-bottom: 4px; font-size: 0.9em; color: var(--muted, #888); }
    input { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 0.95em; box-sizing: border-box; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .saved-note { color: #4caf50; font-size: 0.9em; }
  `]
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  values: HuddleSettings = { defaultMemory: '', defaultCpus: '' };
  error = signal<string | null>(null);
  saving = signal(false);
  saved = signal(false);

  ngOnInit(): void {
    this.api.getSettings().subscribe({
      next: (s) => { this.values = { ...s }; },
      error: (e) => this.error.set(e.message),
    });
  }

  save(): void {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    this.api.saveSettings(this.values).subscribe({
      next: () => { this.saving.set(false); this.saved.set(true); },
      error: (e) => { this.saving.set(false); this.error.set(e.message); },
    });
  }
}
