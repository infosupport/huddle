import { Component, inject, OnInit, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService, HuddleSettings, FolderMapping } from '../../core/services/api.service';
import { IconComponent } from '../../shared/components/icon/icon.component';

@Component({
  selector: 'app-settings',
  standalone: true,
  imports: [FormsModule, IconComponent],
  template: `
    <div class="page-header">
      <h1>Settings</h1>
    </div>
    @if (error()) { <p class="error-note">{{ error() }}</p> }

    @if (configMounted() === false) {
      <p class="error-note">
        The CLI config (<code>~/.huddle/config.json</code>) is not mounted into Huddle, so
        nothing on this page can be saved. Run <code>huddle restart</code> on the host first.
      </p>
    }

    <div class="card">
      <h2>Resource limits</h2>
      <p class="hint">
        Default CPU and memory limits for new devcontainers. Leave empty for no limit.
        Stored in <code>~/.huddle/config.json</code>; applies to the next devcontainer you start.
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
          @if (resourceNote()) { <span class="saved-note">{{ resourceNote() }}</span> }
        </div>
      </form>
    </div>

    <div class="card">
      <h2>Folder mappings</h2>
      <p class="hint">
        Folders or volumes that are automatically mounted in every new devcontainer.
        Use a host path for bind mounts, or a volume name for Docker volumes.
        Stored in <code>~/.huddle/config.json</code> so the team can review them in version control.
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

    <div class="card card--new">
      <div class="tmd-head">
        <span class="tmd-folder"><app-icon name="folder" [size]="26" /></span>
        <h2 class="tmd-title">
          Team-managed defaults (extension &amp; firewall rules)
          <span class="pill pill--new">NEW</span>
        </h2>
      </div>

      <div class="field-row tmd-cols">
        <div class="field">
          <label>Extensions folder</label>
          <p class="hint">Path to folder containing extension definitions (read on startup &amp; reload).</p>
          <div class="tmd-input-row">
            <input [(ngModel)]="resources.extensionsFolder" name="extensionsFolder"
                   placeholder="/path/to/extensions" autocomplete="off" spellcheck="false">
            <button type="button" class="btn btn-ghost" (click)="saveFolders()" [disabled]="savingFolders()">Save</button>
          </div>
        </div>
        <div class="field">
          <label>Firewall rules folder</label>
          <p class="hint">Path to folder containing firewall rules (read on startup &amp; reload).</p>
          <div class="tmd-input-row">
            <input [(ngModel)]="resources.firewallRulesFolder" name="firewallRulesFolder"
                   placeholder="/path/to/firewall_rules" autocomplete="off" spellcheck="false">
            <button type="button" class="btn btn-ghost" (click)="reloadFirewallFolder()" [disabled]="savingFolders()">Reload</button>
          </div>
        </div>
      </div>
      @if (folderNote()) { <span class="saved-note">{{ folderNote() }}</span> }
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

    /* Team-managed defaults (#69) */
    .card--new { border: 1px solid var(--accent); }
    .tmd-head { display: flex; align-items: center; gap: 14px; margin-bottom: 20px; }
    .tmd-folder { display: inline-flex; align-items: center; justify-content: center; color: var(--accent); }
    .tmd-title { display: flex; align-items: center; gap: 10px; margin: 0; }
    .pill--new { background: var(--info-soft, #e6f0ff); color: var(--info, #2f6feb); font-size: 0.62em; font-weight: 700; letter-spacing: 0.04em; padding: 3px 7px; border-radius: 999px; text-transform: uppercase; }
    .tmd-cols { gap: 40px; }
    .tmd-cols .field { min-width: 260px; }
    .tmd-input-row { display: flex; gap: 10px; align-items: stretch; }
    .tmd-input-row input { flex: 1; }
    .btn-ghost { background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; padding: 8px 16px; cursor: pointer; font-size: 0.9em; }
    .btn-ghost:hover { background: var(--surface-hover); }
    .btn-ghost:disabled { opacity: 0.5; cursor: default; }
  `]
})
export class SettingsComponent implements OnInit {
  private api = inject(ApiService);

  resources: HuddleSettings = { defaultMemory: '', defaultCpus: '', extensionsFolder: '', firewallRulesFolder: '' };
  mappings = signal<FolderMapping[]>([]);
  error = signal<string | null>(null);
  savingResources = signal(false);
  resourceNote = signal<string | null>(null);
  configMounted = signal<boolean | null>(null);
  addingMapping = signal(false);
  savingFolders = signal(false);
  folderNote = signal<string | null>(null);

  newMapping = { name: '', host_path: '', volume_name: '', container_path: '' };
  newMappingReadOnly = false;

  ngOnInit(): void {
    this.api.getSettings().subscribe({
      next: (s) => { this.resources = { ...s }; this.configMounted.set(s.hostConfigMounted ?? null); },
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

  // The limits are written into the mounted ~/.huddle/config.json (#98), so a
  // failed write means the config is not mounted — say so instead of "Saved".
  saveResources(): void {
    this.savingResources.set(true);
    this.resourceNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      defaultMemory: this.resources.defaultMemory,
      defaultCpus: this.resources.defaultCpus,
    }).subscribe({
      next: (res) => {
        this.savingResources.set(false);
        if (res.persisted === false) {
          this.configMounted.set(false);
          this.error.set('Could not save — the CLI config is not mounted into Huddle. Run `huddle restart` on the host first.');
        } else {
          this.resourceNote.set('Saved');
        }
      },
      error: (e) => { this.savingResources.set(false); this.error.set(e.message); },
    });
  }

  // Save both folder paths. They are written into the mounted ~/.huddle/config.json
  // and only take effect once the CLI re-mounts them — so tell the operator to
  // restart. Used by the Extensions-folder Reload button too.
  saveFolders(): void {
    this.savingFolders.set(true);
    this.folderNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      extensionsFolder: this.resources.extensionsFolder,
      firewallRulesFolder: this.resources.firewallRulesFolder,
    }).subscribe({
      next: (res) => {
        this.savingFolders.set(false);
        if (res.persisted === false) {
          this.folderNote.set('Could not save — the CLI config is not mounted into Huddle. Run `huddle restart` on the host first.');
        } else {
          this.folderNote.set('Saved to config. Run `huddle restart` on the host to (re)mount the folder(s).');
        }
      },
      error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
    });
  }

  // Save the folder paths, then re-read whatever is currently mounted.
  reloadFirewallFolder(): void {
    this.savingFolders.set(true);
    this.folderNote.set(null);
    this.error.set(null);
    this.api.saveSettings({
      extensionsFolder: this.resources.extensionsFolder,
      firewallRulesFolder: this.resources.firewallRulesFolder,
    }).subscribe({
      next: () => {
        this.api.reloadFirewallRulesFolder().subscribe({
          next: (r) => {
            this.savingFolders.set(false);
            if (!r.mounted) {
              this.folderNote.set('Saved to config, but the folder is not mounted into Huddle yet — run `huddle restart` on the host, then Reload.');
            } else {
              const errs = r.errors.length ? `, ${r.errors.length} error(s)` : '';
              this.folderNote.set(`Loaded ${r.groups} group(s), ${r.imported} rule(s)${errs}`);
            }
          },
          error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
        });
      },
      error: (e) => { this.savingFolders.set(false); this.error.set(e.message); },
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
