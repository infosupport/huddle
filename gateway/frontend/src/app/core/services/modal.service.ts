import { Injectable, signal } from '@angular/core';
import { Rule } from '../models/rule.model';

export interface SnapshotModalData { containerName: string; }
export interface ConfirmModalData { rule: Rule; status: 'allow' | 'deny'; }

/**
 * Which announcement the update notice currently carries.
 *
 * Bump this when the modal gets NEW content. What gets stored on dismissal is
 * this number, not a boolean — so a later announcement reappears for everyone
 * without dragging the current one back for the people who already closed it.
 *
 * A boolean here would be a one-way door: introducing a version afterwards
 * means every operator who had already dismissed the notice sees it one more
 * time, because there is no way to tell "dismissed the old one" apart from
 * "never saw anything".
 */
export const UPDATE_NOTICE_VERSION = 1;
const UPDATE_NOTICE_KEY = 'huddle.update-notice';

/** The highest notice version this browser has dismissed; 0 if none. */
function dismissedNoticeVersion(): number {
  try {
    return Number(localStorage.getItem(UPDATE_NOTICE_KEY)) || 0;
  } catch {
    // Storage disabled or partitioned (private windows, some enterprise
    // policies). Show the notice rather than hide it: seeing it twice is a
    // nuisance, never seeing it defeats the point of having it.
    return 0;
  }
}

@Injectable({ providedIn: 'root' })
export class ModalService {
  snapshotOpen = signal(false);
  snapshotData = signal<SnapshotModalData | null>(null);
  startOpen = signal(false);
  confirmOpen = signal(false);
  confirmData = signal<ConfirmModalData | null>(null);

  // Opens itself, unlike every other modal here: it announces something rather
  // than answering an action. The template that renders it only exists once
  // authenticated, so this cannot flash over the login screen.
  updateOpen = signal(dismissedNoticeVersion() < UPDATE_NOTICE_VERSION);

  openSnapshot(containerName: string): void {
    this.snapshotData.set({ containerName });
    this.snapshotOpen.set(true);
  }
  closeSnapshot(): void { this.snapshotOpen.set(false); }
  openStart(): void { this.startOpen.set(true); }
  closeStart(): void { this.startOpen.set(false); }

  // Bumped when a sandbox is created/removed so list views (Dev Environments) can
  // refresh — sandboxes aren't in StateService (they come from sbx via the bridge).
  sandboxesTick = signal(0);
  notifySandboxesChanged(): void { this.sandboxesTick.update((n) => n + 1); }
  openConfirm(rule: Rule, status: 'allow' | 'deny'): void {
    this.confirmData.set({ rule, status });
    this.confirmOpen.set(true);
  }
  closeConfirm(): void { this.confirmOpen.set(false); }

  /** Reopen the notice on demand — for a "what changed?" entry point later. */
  openUpdate(): void { this.updateOpen.set(true); }

  closeUpdate(): void {
    this.updateOpen.set(false);
    try {
      localStorage.setItem(UPDATE_NOTICE_KEY, String(UPDATE_NOTICE_VERSION));
    } catch {
      // Nothing to do: without storage the notice returns next load. Better
      // that than swallowing the close and leaving the operator stuck.
    }
  }
}
