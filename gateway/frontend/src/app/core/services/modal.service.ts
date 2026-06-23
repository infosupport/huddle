import { Injectable, signal } from '@angular/core';
import { Rule } from '../models/rule.model';

export interface SnapshotModalData { containerName: string; }
export interface ConfirmModalData { rule: Rule; status: 'allow' | 'deny'; }

@Injectable({ providedIn: 'root' })
export class ModalService {
  snapshotOpen = signal(false);
  snapshotData = signal<SnapshotModalData | null>(null);
  startOpen = signal(false);
  confirmOpen = signal(false);
  confirmData = signal<ConfirmModalData | null>(null);

  openSnapshot(containerName: string): void {
    this.snapshotData.set({ containerName });
    this.snapshotOpen.set(true);
  }
  closeSnapshot(): void { this.snapshotOpen.set(false); }
  openStart(): void { this.startOpen.set(true); }
  closeStart(): void { this.startOpen.set(false); }
  openConfirm(rule: Rule, status: 'allow' | 'deny'): void {
    this.confirmData.set({ rule, status });
    this.confirmOpen.set(true);
  }
  closeConfirm(): void { this.confirmOpen.set(false); }
}
