import { Injectable, inject, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, forkJoin } from 'rxjs';
import { ApiService } from './api.service';
import { ForegroundSyncService } from './foreground-sync.service';
import { Container } from '../models/container.model';
import { Rule } from '../models/rule.model';
import { GrantMap } from '../models/grant.model';

@Injectable({ providedIn: 'root' })
export class StateService {
  private api = inject(ApiService);
  private platformId = inject(PLATFORM_ID);
  // Browser-lifecycle (focus/visibility) + vangnet-poll leven hier; StateService
  // zelf gaat enkel over state + API/WebSocket-sync.
  private foregroundSync = inject(ForegroundSyncService);

  containers$ = new BehaviorSubject<Container[]>([]);
  rules$ = new BehaviorSubject<Rule[]>([]);
  grants$ = new BehaviorSubject<GrantMap>({});
  loaded$ = new BehaviorSubject<boolean>(false);

  private ws: WebSocket | null = null;
  // Debounce rapid consecutive triggers (e.g. WS message + timer race, or reconnect overlap)
  private loadDebounce: ReturnType<typeof setTimeout> | null = null;
  // Timestamp of the last loadAll — basis voor de refetch-throttle.
  private lastLoadAt = 0;
  // Kort venster waarin een focus/visibility/poll-event géén extra fetch triggert:
  // de data is dan nog vers (WS/poll of een refetch van net).
  private static readonly REFETCH_STALE_MS = 2_000;

  constructor() {
    this.loadAll();
    if (isPlatformBrowser(this.platformId)) {
      this.connectWs();
      // De vangnet-laag vraagt een resync aan zodra dat zinvol is (tab weer in
      // focus/zicht, of een poll-tick terwijl de WS niet levert).
      this.foregroundSync.start(() => this.refetchIfStale());
    }
  }

  private refetchIfStale(): void {
    if (Date.now() - this.lastLoadAt < StateService.REFETCH_STALE_MS) return;
    this.triggerLoad();
  }

  private connectWs(): void {
    // Close existing connection before creating a new one to prevent multiple active WS instances
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      this.ws.onclose = null;
      this.ws.close();
    }
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    this.ws = new WebSocket(`${proto}//${location.host}/ws`);
    // Open socket = primaire push levert → vangnet-poll uit. Sluiten/fout →
    // poll weer aan zodat updates blijven binnenkomen tot de WS terug is.
    this.ws.onopen = () => this.foregroundSync.setRealtimeLive(true);
    this.ws.onmessage = () => this.triggerLoad();
    this.ws.onerror = () => this.ws?.close();
    this.ws.onclose = () => {
      this.foregroundSync.setRealtimeLive(false);
      setTimeout(() => this.connectWs(), 3000);
    };
  }

  private triggerLoad(): void {
    if (this.loadDebounce) clearTimeout(this.loadDebounce);
    this.loadDebounce = setTimeout(() => this.loadAll(), 50);
  }

  loadAll(): void {
    this.lastLoadAt = Date.now();
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
