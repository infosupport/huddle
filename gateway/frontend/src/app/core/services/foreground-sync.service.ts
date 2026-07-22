import { Injectable, inject, DestroyRef, PLATFORM_ID } from '@angular/core';
import { isPlatformBrowser } from '@angular/common';

/**
 * Browser-lifecycle laag voor de state-sync: luistert naar focus/visibility en
 * draait een vangnet-poll. Bewust losgetrokken van StateService zodat die zich
 * enkel met state + API/WebSocket-sync bezighoudt (single responsibility).
 *
 * De WebSocket is de primaire push. Deze poll is puur het vangnet en draait
 * daarom alléén als de realtime-push niet levert — zie {@link setRealtimeLive}.
 * Zo verdwijnt in het normale geval (WS open) de vaste 5s-polling volledig,
 * terwijl nieuwe firewall-requests bij een verbroken/afwezige socket (bijv.
 * dev-proxy zonder /ws) alsnog binnen enkele seconden verschijnen.
 */
@Injectable({ providedIn: 'root' })
export class ForegroundSyncService {
  private platformId = inject(PLATFORM_ID);
  private destroyRef = inject(DestroyRef);

  // Handle van de zichtbaarheidsgebonden voorgrond-poll.
  private pollHandle: ReturnType<typeof setInterval> | null = null;
  private started = false;
  // Levert de primaire push (WebSocket) op dit moment? Zolang dit waar is blijft
  // de vangnet-poll uit.
  private realtimeLive = false;
  // Callback die een resync aanvraagt; de eigenaar (StateService) bepaalt zelf of
  // er daadwerkelijk gefetcht wordt (throttle op basis van laatste load).
  private requestRefresh: () => void = () => {};

  // Poll-interval terwijl het tabblad zichtbaar is én de WS niet levert.
  private static readonly VISIBLE_POLL_MS = 5_000;

  /**
   * Begin te reageren op focus/visibility en draai zo nodig de vangnet-poll.
   * @param requestRefresh wordt aangeroepen zodra een resync gewenst is
   *        (focus terug, tab weer zichtbaar, of een poll-tick).
   */
  start(requestRefresh: () => void): void {
    if (!isPlatformBrowser(this.platformId) || this.started) return;
    this.started = true;
    this.requestRefresh = requestRefresh;
    // Refetch zodra het tabblad/venster terug in focus/zicht komt — het
    // Angular-equivalent van TanStack Query's refetchOnWindowFocus. `focus`
    // dekt alt-tab tussen apps; `visibility` dekt tab-wissels binnen de browser.
    window.addEventListener('focus', this.onWindowFocus);
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    this.evaluatePolling();
    this.destroyRef.onDestroy(() => this.stop());
  }

  /**
   * Meld of de realtime-push (WebSocket) op dit moment levert. Bij `true` stopt
   * de vangnet-poll; bij `false` (verbroken/afwezige socket) start hij weer,
   * mits het tabblad zichtbaar is.
   */
  setRealtimeLive(live: boolean): void {
    if (this.realtimeLive === live) return;
    this.realtimeLive = live;
    this.evaluatePolling();
  }

  // Arrow-properties zodat `this` klopt als event-listener en add/remove
  // dezelfde referentie delen.
  private onWindowFocus = (): void => {
    if (document.visibilityState === 'hidden') return;
    this.requestRefresh();
  };

  private onVisibilityChange = (): void => {
    if (document.visibilityState === 'hidden') {
      // Verborgen tab: browsers throttlen timers zwaar en de WS kan sluimeren —
      // stop de poll en synchroniseer weer bij terugkeer.
      this.stopPolling();
      return;
    }
    this.requestRefresh();
    this.evaluatePolling();
  };

  // De poll draait alleen als het tabblad zichtbaar is én de WS niet levert.
  private evaluatePolling(): void {
    const shouldPoll = !this.realtimeLive && document.visibilityState !== 'hidden';
    if (shouldPoll) this.startPolling();
    else this.stopPolling();
  }

  private startPolling(): void {
    if (this.pollHandle !== null) return;
    this.pollHandle = setInterval(() => {
      if (!this.realtimeLive && document.visibilityState !== 'hidden') this.requestRefresh();
    }, ForegroundSyncService.VISIBLE_POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollHandle !== null) {
      clearInterval(this.pollHandle);
      this.pollHandle = null;
    }
  }

  private stop(): void {
    window.removeEventListener('focus', this.onWindowFocus);
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    this.stopPolling();
    this.started = false;
  }
}
