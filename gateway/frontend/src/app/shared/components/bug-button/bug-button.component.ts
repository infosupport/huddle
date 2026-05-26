import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DOCUMENT } from '@angular/common';
import { ApiService } from '../../../core/services/api.service';

@Component({
  selector: 'app-bug-button',
  standalone: true,
  imports: [FormsModule],
  template: `
    <div class="bug-fab">
      @if (isOpen()) {
        <div class="bug-panel">
          <div class="bug-panel__head">
            <span>Bug melden</span>
            <button class="bug-close" (click)="close()" aria-label="Sluiten">✕</button>
          </div>
          @if (done()) {
            <p class="bug-success">✓ Bug opgeslagen!</p>
          } @else {
            <div class="bug-panel__body">
              <input
                class="bug-input"
                type="text"
                placeholder="Korte omschrijving…"
                [(ngModel)]="title"
                (keydown.enter)="submit()"
                (keydown.escape)="close()"
                #titleInput
                autofocus
              />
              <textarea
                class="bug-textarea"
                placeholder="Extra details (optioneel)"
                [(ngModel)]="description"
                rows="3"
                (keydown.escape)="close()"
              ></textarea>
              @if (errorMsg()) {
                <p class="bug-error">{{ errorMsg() }}</p>
              }
              <div class="bug-panel__foot">
                <span class="bug-url">{{ currentUrl }}</span>
                <button class="btn btn-allow btn-sm" [disabled]="submitting()" (click)="submit()">
                  {{ submitting() ? '…' : 'Opslaan' }}
                </button>
              </div>
            </div>
          }
        </div>
      }
      <button class="bug-trigger" (click)="toggle()" [class.bug-trigger--open]="isOpen()" aria-label="Bug melden">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2l1.5 1.5"/><path d="M14.5 3.5L16 2"/>
          <path d="M9 7.5a5 5 0 0 0-3 4.5v1a5 5 0 0 0 10 0v-1a5 5 0 0 0-3-4.5"/>
          <path d="M3 13h2m14 0h2"/><path d="M5 19l1.5-1.5M17.5 17.5L19 19"/>
          <path d="M9 21h6"/>
        </svg>
        Bug
      </button>
    </div>
  `,
  styles: [`
    .bug-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2000;
      display: flex;
      flex-direction: column;
      align-items: flex-end;
      gap: 8px;
    }
    .bug-trigger {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 8px 14px;
      background: var(--surface-2);
      border: 1px solid var(--border);
      border-radius: 20px;
      color: var(--text-muted);
      font-size: 13px;
      font-weight: 500;
      cursor: pointer;
      transition: background 140ms, color 140ms, border-color 140ms;
      box-shadow: 0 2px 8px rgba(0,0,0,.12);
    }
    .bug-trigger:hover, .bug-trigger--open {
      background: var(--surface-hover);
      color: var(--text);
      border-color: var(--text-muted);
    }
    .bug-panel {
      width: 300px;
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      box-shadow: 0 8px 24px rgba(0,0,0,.14);
      overflow: hidden;
    }
    .bug-panel__head {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      background: var(--surface-2);
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      font-weight: 600;
    }
    .bug-close {
      background: none;
      border: none;
      cursor: pointer;
      color: var(--text-muted);
      font-size: 14px;
      padding: 0 2px;
      line-height: 1;
    }
    .bug-close:hover { color: var(--text); }
    .bug-panel__body { padding: 12px; display: flex; flex-direction: column; gap: 8px; }
    .bug-input, .bug-textarea {
      width: 100%;
      box-sizing: border-box;
      padding: 7px 10px;
      border: 1px solid var(--border);
      border-radius: 6px;
      background: var(--surface-2);
      color: var(--text);
      font-size: 13px;
      font-family: inherit;
      resize: vertical;
    }
    .bug-input:focus, .bug-textarea:focus {
      outline: none;
      border-color: var(--text-muted);
    }
    .bug-panel__foot {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 8px;
    }
    .bug-url {
      font-size: 11px;
      color: var(--text-muted);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 180px;
    }
    .bug-success { padding: 16px 14px; font-size: 13px; color: #1f7a47; margin: 0; }
    .bug-error { font-size: 12px; color: var(--color-red, #c0392b); margin: 0; }
  `],
})
export class BugButtonComponent {
  private api = inject(ApiService);
  private doc = inject(DOCUMENT);

  isOpen = signal(false);
  submitting = signal(false);
  done = signal(false);
  errorMsg = signal<string | null>(null);

  title = '';
  description = '';
  currentUrl = '';

  toggle(): void {
    if (this.isOpen()) { this.close(); } else { this.open(); }
  }

  open(): void {
    this.title = '';
    this.description = '';
    this.done.set(false);
    this.errorMsg.set(null);
    this.currentUrl = this.doc.defaultView?.location.href ?? '';
    this.isOpen.set(true);
  }

  close(): void {
    this.isOpen.set(false);
  }

  submit(): void {
    if (!this.title.trim()) { this.errorMsg.set('Omschrijving is verplicht'); return; }
    this.submitting.set(true);
    this.errorMsg.set(null);
    this.api.reportBug({ title: this.title.trim(), url: this.currentUrl, body: this.description.trim() || undefined }).subscribe({
      next: () => {
        this.done.set(true);
        this.submitting.set(false);
        setTimeout(() => this.close(), 1500);
      },
      error: (err) => {
        this.errorMsg.set(err?.message ?? 'Opslaan mislukt');
        this.submitting.set(false);
      },
    });
  }
}
