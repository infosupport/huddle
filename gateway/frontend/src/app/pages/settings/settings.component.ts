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
      <h2>Gedeelde AI CLI-instellingen</h2>
      <p class="hint">
        Elke devcontainer mount deze named Docker-volumes zodat sessies en tokens
        gedeeld blijven en een recreate overleven. Laat een veld leeg om voor die
        provider geen gedeeld volume te gebruiken (terugvallen op de image-default).
      </p>
      <form (ngSubmit)="save()">
        <div class="field">
          <label>Claude settings volume</label>
          <input [(ngModel)]="values.claudeSettingsVolume" name="claudeSettingsVolume"
                 placeholder="huddle-claude-settings" autocomplete="off">
        </div>
        <div class="field">
          <label>Codex settings volume</label>
          <input [(ngModel)]="values.codexSettingsVolume" name="codexSettingsVolume"
                 placeholder="huddle-codex-settings" autocomplete="off">
        </div>
        <div class="field">
          <label>OpenCode settings volume</label>
          <input [(ngModel)]="values.opencodeSettingsVolume" name="opencodeSettingsVolume"
                 placeholder="huddle-opencode-settings" autocomplete="off">
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
    .field { margin-bottom: 16px; }
    label { display: block; margin-bottom: 4px; font-size: 0.9em; color: var(--muted, #888); }
    input { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border, #2a2a2a); background: var(--bg2, #1a1a2e); color: inherit; font-size: 0.95em; box-sizing: border-box; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .saved-note { color: #4caf50; font-size: 0.9em; }
  `]
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  values: HuddleSettings = { claudeSettingsVolume: '', codexSettingsVolume: '', opencodeSettingsVolume: '' };
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
