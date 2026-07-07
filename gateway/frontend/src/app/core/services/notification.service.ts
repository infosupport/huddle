import { Injectable, inject, DestroyRef } from '@angular/core';
import { BehaviorSubject } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { StateService } from './state.service';
import { Rule } from '../models/rule.model';

@Injectable({ providedIn: 'root' })
export class NotificationService {
  private state = inject(StateService);
  private destroyRef = inject(DestroyRef);

  enabled$ = new BehaviorSubject<boolean>(false);

  private knownIds = new Set<number>();
  private initialized = false;

  constructor() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/notification-sw.js').catch(() => {});
    }

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
          this.showNotification(r);
        }
      }
    });
  }

  private async showNotification(r: Rule): Promise<void> {
    const title = 'Huddle – URL requested';
    const options = {
      body: `${r.container_name || r.container_id || 'Unknown'} → ${r.domain}`,
      icon: '/assets/hex-2d.png',
      requireInteraction: true,
      data: { ruleId: r.id, domain: r.domain },
      actions: [
        { action: 'allow-all', title: 'Allow all' },
        { action: 'block-all', title: 'Block all' },
        { action: '5min',      title: '5 minutes' },
      ],
    } as NotificationOptions;

    if ('serviceWorker' in navigator) {
      try {
        const reg = await navigator.serviceWorker.ready;
        await reg.showNotification(title, options);
        return;
      } catch { /* fall back to default notification */ }
    }

    new Notification(title, { body: options.body, icon: options.icon });
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
