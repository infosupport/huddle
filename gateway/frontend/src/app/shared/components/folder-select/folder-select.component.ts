import { Component, EventEmitter, Input, Output } from '@angular/core';
import { IndexedFolder } from '../../../core/services/api.service';
import { FolderPickerModalComponent } from '../../modals/folder-picker-modal/folder-picker-modal.component';

// One host-path input, used everywhere a host folder has to be named.
//
// Huddle's portal runs in a container, so it cannot open a native folder dialog:
// a host path could only ever be typed from memory. `huddle indexfolder` fills an
// index of real folders on the host, and Browse… opens that index in a proper
// picker dialog.
//
// The text box stays authoritative on purpose: the index is a snapshot taken by
// the CLI, not a live view of the host, so a folder created five minutes ago must
// still be usable without re-indexing first.
let uid = 0;

@Component({
  selector: 'app-folder-select',
  standalone: true,
  imports: [FolderPickerModalComponent],
  template: `
    <div class="fs-field">
      <input type="text" [id]="inputId" [value]="value" [placeholder]="placeholder"
             autocomplete="off" spellcheck="false"
             (input)="onInput($any($event.target).value)" />
      <button type="button" class="fs-browse" [title]="browseTitle()" (click)="open = true">Browse…</button>
    </div>

    @if (hint) {
      <p class="fs-hint">
        @if (folders.length) {
          {{ folders.length }} indexed folder(s) available.
        } @else {
          No indexed folders yet — run <code>huddle indexfolder</code> on the host to browse
          your folders here. Typing a path keeps working.
        }
      </p>
    }

    @if (open) {
      <app-folder-picker-modal [folders]="folders" [value]="value" [multiple]="multiple"
                               [title]="pickerTitle" [subtitle]="pickerSubtitle"
                               (picked)="onPicked($event)" (pickedMany)="onPickedMany($event)"
                               (cancel)="open = false" />
    }
  `,
  styles: [`
    :host { display: block; min-width: 0; }
    .fs-field { display: flex; gap: .5rem; align-items: center; }
    .fs-field input { flex: 1; min-width: 0; }
    .fs-browse {
      flex: 0 0 auto; padding: .45rem .75rem; font-size: .82rem; line-height: 1.2; cursor: pointer;
      border: 1px solid var(--border-strong); border-radius: var(--radius-sm);
      background: var(--surface); color: var(--text); white-space: nowrap;
    }
    .fs-browse:hover { background: var(--surface-hover); border-color: var(--accent); color: var(--accent); }
    .fs-hint { font-size: 12px; color: var(--text-muted); margin: .25rem 0 0; }
    .fs-hint code { font-size: 11px; }
  `],
})
export class FolderSelectComponent {
  @Input() value = '';
  @Input() folders: IndexedFolder[] = [];
  @Input() placeholder = '';
  // The <label for="..."> of the caller points at the text box, not the wrapper.
  @Input() inputId = `folder-input-${++uid}`;
  @Input() hint = false;
  @Input() pickerTitle = 'Select folder';
  @Input() pickerSubtitle = 'Choose a folder from your indexed locations.';
  // Let the dialog pick more than one. The field itself still holds a single
  // path — the extra folders are the caller's problem, handed over on
  // valuesChange, because only the caller knows what several folders mean.
  @Input() multiple = false;
  @Output() valueChange = new EventEmitter<string>();
  @Output() valuesChange = new EventEmitter<string[]>();

  open = false;

  browseTitle(): string {
    return this.folders.length
      ? 'Browse indexed host folders'
      : 'No indexed folders yet — run "huddle indexfolder" on the host';
  }

  onPicked(path: string): void {
    this.open = false;
    this.onInput(path);
  }

  onPickedMany(paths: string[]): void {
    this.open = false;
    if (!paths.length) return;
    this.onInput(paths[0]);
    this.valuesChange.emit(paths);
  }

  onInput(v: string): void {
    this.value = v;
    this.valueChange.emit(v);
  }
}
