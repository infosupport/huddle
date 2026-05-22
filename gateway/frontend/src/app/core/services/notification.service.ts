import { Injectable, inject, DestroyRef } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { StateService } from './state.service';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private state = inject(StateService);
  private destroyRef = inject(DestroyRef);

  enabled$ = new BehaviorSubject<boolean>(false);

  private knownIds = new Set<number>();
  private initialized = false;

  constructor() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      this.enabled$.next(true);
    }

    this.state.rules$.pipe(takeUntilDestroyed(this.destroyRef)).subscribe(rules => {
      const requested = rules.filter(r => r.status === 'requested');

      if (!this.initialized) {
        this.knownIds = new Set(requested.map(r => r.id));
        this.initialized = true;
        return;
      }

      if (!this.enabled$.value) return;

      for (const r of requested) {
        if (!this.knownIds.has(r.id)) {
          this.knownIds.add(r.id);
          new Notification('Huddle – URL aangevraagd', {
            body: `${r.container_name || r.container_id || 'Onbekend'} → ${r.domain}`,
            icon: '/assets/hex-2d.png',
          });
        }
      }
    });
  }

  async toggle(): Promise<void> {
    if (typeof Notification === 'undefined') return;

    if (this.enabled$.value) {
      this.enabled$.next(false);
      return;
    }

    if (Notification.permission === 'granted') {
      this.enabled$.next(true);
    } else if (Notification.permission !== 'denied') {
      const perm = await Notification.requestPermission();
      this.enabled$.next(perm === 'granted');
    }
  }
}
