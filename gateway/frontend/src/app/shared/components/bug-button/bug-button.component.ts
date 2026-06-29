import { Component } from '@angular/core';

@Component({
  selector: 'app-bug-button',
  standalone: true,
  template: `
    <div class="bug-fab">
      <a class="bug-trigger" href="https://github.com/infosupport/huddle/issues/new" target="_blank" rel="noopener" aria-label="Bug melden">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M8 2l1.5 1.5"/><path d="M14.5 3.5L16 2"/>
          <path d="M9 7.5a5 5 0 0 0-3 4.5v1a5 5 0 0 0 10 0v-1a5 5 0 0 0-3-4.5"/>
          <path d="M3 13h2m14 0h2"/><path d="M5 19l1.5-1.5M17.5 17.5L19 19"/>
          <path d="M9 21h6"/>
        </svg>
        Bug
      </a>
    </div>
  `,
  styles: [`
    .bug-fab {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 2000;
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
      text-decoration: none;
      transition: background 140ms, color 140ms, border-color 140ms;
      box-shadow: 0 2px 8px rgba(0,0,0,.12);
    }
    .bug-trigger:hover {
      background: var(--surface-hover);
      color: var(--text);
      border-color: var(--text-muted);
    }
  `],
})
export class BugButtonComponent {}
