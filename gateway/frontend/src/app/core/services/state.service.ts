import { Injectable, inject, DestroyRef, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';
import { BehaviorSubject, forkJoin } from 'rxjs';
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
  // Handle van de zichtbaarheidsgebonden voorgrond-poll.
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  // Timestamp of the last loadAll — basis voor de refetch-throttle.
  private lastLoadAt = 0;
  // Poll-interval terwijl het tabblad zichtbaar is. De WebSocket is de primaire
  // push; deze poll is de vangnet-laag zodat nieuwe firewall-requests óók
  // verschijnen als de WS niet levert (dev-proxy zonder /ws, verbroken socket,
  // gethrottelde achtergrond-tab). Achtergrond → gestopt (zie visibilitychange).
  private static readonly VISIBLE_POLL_MS = 5_000;
  // Kort venster waarin een focus/visibility-event géén extra fetch triggert:
  // de data is dan nog vers (WS/poll of een refetch van net).
  private static readonly REFETCH_STALE_MS = 2_000;

  constructor() {
    this.loadAll();
    if (isPlatformBrowser(this.platformId)) {
      this.connectWs();
      // Refetch zodra het tabblad/venster terug in focus/zicht komt — het
      // Angular-equivalent van TanStack Query's refetchOnWindowFocus. Wie vanuit
      // z'n terminal/devcontainer terugschakelt naar Huddle ziet meteen de
      // nieuwe firewall-requests. `focus` dekt alt-tab tussen apps; `visibility`
      // dekt tab-wissels binnen de browser.
      window.addEventListener('focus', this.onWindowFocus);
      document.addEventListener('visibilitychange', this.onVisibilityChange);
      // Start meteen de voorgrond-poll (tab is bij load per definitie zichtbaar).
      this.startPolling();
      this.destroyRef.onDestroy(() => {
        window.removeEventListener('focus', this.onWindowFocus);
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.stopPolling();
      });
    }
  }

  // Arrow-properties zodat `this` klopt als event-listener en add/remove
  // dezelfde referentie delen.
  private onWindowFocus = (): void => {
    if (document.visibilityState === 'hidden') return;
    this.refetchIfStale();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      // Verborgen tab: browsers throttlen timers zwaar en de WS kan sluimeren —
      // stop de poll en synchroniseer weer bij terugkeer.
      this.stopPolling();
      return;
    }
    this.refetchIfStale();
    this.startPolling();
  };

  private refetchIfStale(): void {
    if (Date.now() - this.lastLoadAt < StateService.REFETCH_STALE_MS) return;
    this.triggerLoad();
  }

  private startPolling(): void {
    if (this.pollHandle !== null) return;
    this.pollHandle = setInterval(() => {
      if (document.visibilityState !== 'hidden') this.triggerLoad();
    }, StateService.VISIBLE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
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
