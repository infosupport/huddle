import { Injectable, inject, DestroyRef, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, forkJoin, timer } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from './api.service';
import { Container } from '../models/container.model';
import { Rule } from '../models/rule.model';
import { GrantMap } from '../models/grant.model';

@Injectable({ providedIn: 'root' })
export class StateService {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);
  private platformId = inject(PLATFORM_ID);

  containers$ = new BehaviorSubject<Container[]>([]);
  rules$ = new BehaviorSubject<Rule[]>([]);
  grants$ = new BehaviorSubject<GrantMap>({});
  loaded$ = new BehaviorSubject<boolean>(false);

  private ws: WebSocket | null = null;
  // Debounce rapid consecutive triggers (e.g. WS message + timer race, or reconnect overlap)
  private loadDebounce: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.loadAll();
    if (isPlatformBrowser(this.platformId)) {
      this.connectWs();
    }
    // Fallback poll every 30s in case WS drops
    timer(30_000, 30_000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.triggerLoad());
  }

  private connectWs(): void {
    // Close existing connection before creating a new one to prevent multiple active WS instances
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.onclose = null;
      this.ws.close();
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    this.ws.onmessage = () => this.triggerLoad();
    this.ws.onerror = () => this.ws?.close();
    this.ws.onclose = () => setTimeout(() => this.connectWs(), 3000);
  }

  private triggerLoad(): void {
    if (this.loadDebounce) clearTimeout(this.loadDebounce);
    this.loadDebounce = setTimeout(() => this.loadAll(), 50);
  }

  loadAll(): void {
    forkJoin([
      this.api.getContainers(),
      this.api.getRules(),
      this.api.getGrants(),
    ]).subscribe({
      next: ([containers, rules, grants]) => {
        this.containers$.next(containers);
        this.rules$.next(rules);
        this.grants$.next(grants);
        this.loaded$.next(true);
      },
      error: (err) => console.error('loadAll error', err),
    });
  }
}
