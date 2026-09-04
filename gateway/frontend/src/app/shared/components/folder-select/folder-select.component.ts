import { Component, EventEmitter, Input, Output } from '@angular/core';
import { FolderPickerModalComponent } from '../../modals/folder-picker-modal/folder-picker-modal.component';

// One host-path input, used everywhere a host folder has to be named.
//
// A browser will not hand a server a folder path, so there is no native folder
// dialog to open: Browse… opens Huddle's own, which browses the host through
// Huddle Node.
//
// The text box stays authoritative on purpose. A path is still the fastest way
// to name a folder you already know, it survives a host Node cannot read, and
// pasting one from a terminal has to keep working.
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
      <button type="button" class="fs-browse" title="Browse the folders on this host"
              (click)="open = true">Browse…</button>
    </div>

    @if (hint) {
      <p class="fs-hint">Browse… opens the folders on this host, or type a path.</p>
    }

    @if (open) {
      <app-folder-picker-modal [value]="value" [multiple]="multiple"
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
  @Input() placeholder = '';
  // The <label for="..."> of the caller points at the text box, not the wrapper.
  @Input() inputId = `folder-input-${++uid}`;
  @Input() hint = false;
  @Input() pickerTitle = 'Select folder';
  @Input() pickerSubtitle = 'Browse the folders on this host.';
  // Let the dialog pick more than one. The field itself still holds a single
  // path — the extra folders are the caller's problem, handed over on
  // valuesChange, because only the caller knows what several folders mean.
  @Input() multiple = false;
  @Output() valueChange = new EventEmitter<string>();
  @Output() valuesChange = new EventEmitter<string[]>();

  open = false;

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
