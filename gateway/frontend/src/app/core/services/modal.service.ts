import { Injectable, signal } from '@angular/core';
import { Subject } from 'rxjs';
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

  // Vuurt nadat de globale allow/deny-bevestiging is doorgevoerd. Pagina's die
  // hun eigen lokale data tonen (bv. container-detail via getContainerDetail)
  // i.p.v. state.rules$ luisteren hierop om te herladen — de modal kent hun
  // lokale load() niet, dus zonder dit bleef hun view staan tot een refresh.
  private confirmResolved = new Subject<void>();
  confirmResolved$ = this.confirmResolved.asObservable();
  notifyConfirmResolved(): void { this.confirmResolved.next(); }

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
