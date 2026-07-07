import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, HuddleSettings, FolderMapping } from '../../core/services/api.service';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="page-header">
      <h1>Settings</h1>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }

    <div class="card">
      <h2>Resource limits</h2>
      <p class="hint">
        Default CPU and memory limits for new devcontainers. Leave empty for no limit.
      </p>
      <form (ngSubmit)="saveResources()">
        <div class="field-row">
          <div class="field">
            <label>Default memory (e.g. 4g, 2048m)</label>
            <input [(ngModel)]="resources.defaultMemory" name="defaultMemory"
                   placeholder="e.g. 4g" autocomplete="off">
          </div>
          <div class="field">
            <label>Default CPU (e.g. 2, 0.5)</label>
            <input [(ngModel)]="resources.defaultCpus" name="defaultCpus"
                   placeholder="e.g. 2" autocomplete="off">
          </div>
        </div>
        <div class="actions">
          <button type="submit" class="btn btn--accent" [disabled]="savingResources()">
            {{ savingResources() ? 'Saving…' : 'Save' }}
          </button>
          @if (savedResources()) { <span class="saved-note">Saved</span> }
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Folder mappings</h2>
      <p class="hint">
        Folders or volumes that are automatically mounted in every new devcontainer.
        Use a host path for bind mounts, or a volume name for Docker volumes.
      </p>

      <table class="mappings-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Source (host path or volume)</th>
            <th>Container path</th>
            <th>RO</th>
            <th>On</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          @for (m of mappings(); track m.id) {
            <tr [class.disabled-row]="!m.enabled">
              <td>{{ m.name }}</td>
              <td class="source-cell">{{ m.host_path || m.volume_name || '—' }}</td>
              <td class="mono">{{ m.container_path }}</td>
              <td>{{ m.read_only ? 'RO' : 'RW' }}</td>
              <td>
                <input type="checkbox" [checked]="m.enabled"
                       (change)="toggleMapping(m)">
              </td>
              <td>
                <button class="btn btn--danger btn--sm" (click)="deleteMapping(m.id)">
                  Delete
                </button>
              </td>
            </tr>
          }
        </tbody>
      </table>

      <details class="add-form">
        <summary>+ Add mapping</summary>
        <form (ngSubmit)="addMapping()" class="add-mapping-form">
          <div class="field-row">
            <div class="field">
              <label>Name</label>
              <input [(ngModel)]="newMapping.name" name="nm_name" placeholder="e.g. My tool config" autocomplete="off" required>
            </div>
            <div class="field">
              <label>Container path</label>
              <input [(ngModel)]="newMapping.container_path" name="nm_cpath" placeholder="/home/vscode/.mytool" autocomplete="off" required>
            </div>
          </div>
          <div class="field-row">
            <div class="field">
              <label>Host path (bind mount, optional)</label>
              <input [(ngModel)]="newMapping.host_path" name="nm_hpath" placeholder="~/.mytool" autocomplete="off">
            </div>
            <div class="field">
              <label>Volume name (Docker volume, optional)</label>
              <input [(ngModel)]="newMapping.volume_name" name="nm_vol" placeholder="huddle-mytool-settings" autocomplete="off">
            </div>
          </div>
          <div class="field-row">
            <label class="checkbox-label">
              <input type="checkbox" [(ngModel)]="newMappingReadOnly" name="nm_ro"> Read-only
            </label>
          </div>
          <div class="actions">
            <button type="submit" class="btn btn--accent" [disabled]="addingMapping()">
              {{ addingMapping() ? 'Adding…' : 'Add' }}
            </button>
          </div>
        </form>
      </details>
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
    input[type=text], input:not([type]) { width: 100%; padding: 8px 12px; border-radius: 6px; border: 1px solid var(--border); background: var(--surface-2); color: var(--text); font-size: 0.95em; box-sizing: border-box; }
    .checkbox-label { display: flex; align-items: center; gap: 8px; font-size: 0.9em; cursor: pointer; }
    .actions { display: flex; align-items: center; gap: 12px; margin-top: 8px; }
    .saved-note { color: #4caf50; font-size: 0.9em; }
    .mappings-table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 0.9em; }
    .mappings-table th { text-align: left; padding: 6px 8px; color: var(--muted); border-bottom: 1px solid var(--border); }
    .mappings-table td { padding: 6px 8px; border-bottom: 1px solid var(--border); }
    .mappings-table tr.disabled-row td { opacity: 0.4; }
    .source-cell { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .mono { font-family: monospace; font-size: 0.85em; }
    .btn--sm { padding: 3px 8px; font-size: 0.8em; }
    .btn--danger { background: var(--danger, #e06c75); color: #fff; border: none; border-radius: 4px; cursor: pointer; }
    .add-form { margin-top: 16px; }
    .add-form summary { cursor: pointer; color: var(--accent); font-size: 0.9em; padding: 4px 0; }
    .add-mapping-form { margin-top: 12px; }
  `]
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  resources: HuddleSettings = { defaultMemory: '', defaultCpus: '' };
  mappings = signal<FolderMapping[]>([]);
  error = signal<string | null>(null);
  savingResources = signal(false);
  savedResources = signal(false);
  addingMapping = signal(false);

  newMapping = { name: '', host_path: '', volume_name: '', container_path: '' };
  newMappingReadOnly = false;

  ngOnInit(): void {
    this.api.getSettings().subscribe({
      next: (s) => { this.resources = { ...s }; },
      error: (e) => this.error.set(e.message),
    });
    this.loadMappings();
  }

  private loadMappings(): void {
    this.api.getFolderMappings().subscribe({
      next: (m) => this.mappings.set(m),
      error: (e) => this.error.set(e.message),
    });
  }

  saveResources(): void {
    this.savingResources.set(true);
    this.savedResources.set(false);
    this.error.set(null);
    this.api.saveSettings(this.resources).subscribe({
      next: () => { this.savingResources.set(false); this.savedResources.set(true); },
      error: (e) => { this.savingResources.set(false); this.error.set(e.message); },
    });
  }

  toggleMapping(m: FolderMapping): void {
    this.api.updateFolderMapping(m.id, { enabled: m.enabled ? 0 : 1 }).subscribe({
      next: () => this.loadMappings(),
      error: (e) => this.error.set(e.message),
    });
  }

  deleteMapping(id: number): void {
    this.api.deleteFolderMapping(id).subscribe({
      next: () => this.loadMappings(),
      error: (e) => this.error.set(e.message),
    });
  }

  addMapping(): void {
    const { name, host_path, volume_name, container_path } = this.newMapping;
    if (!name || !container_path) return;
    this.addingMapping.set(true);
    this.api.createFolderMapping({
      name, host_path, volume_name, container_path,
      read_only: this.newMappingReadOnly ? 1 : 0,
      enabled: 1, sort_order: 0,
    }).subscribe({
      next: () => {
        this.addingMapping.set(false);
        this.newMapping = { name: '', host_path: '', volume_name: '', container_path: '' };
        this.newMappingReadOnly = false;
        this.loadMappings();
      },
      error: (e) => { this.addingMapping.set(false); this.error.set(e.message); },
    });
  }
}
