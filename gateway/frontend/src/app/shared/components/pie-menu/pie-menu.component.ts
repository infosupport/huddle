import {
  Component, Input, Output, EventEmitter, ElementRef, OnDestroy,
  ViewChild, inject, ChangeDetectionStrategy, ChangeDetectorRef,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { PieMenuConfig, PIE_TONES, PIE_ARCS, PieIconName } from './pie-menu.model';

// ── Geometry helpers ──────────────────────────────────────────────────────────
const SIZE = 240, C = SIZE / 2, RIN = 22, RMID = 56, ROUT = 96, GAP = 3;

function pol(deg: number, r: number): [number, number] {
  const rad = deg * Math.PI / 180;
  return [C + Math.cos(rad) * r, C + Math.sin(rad) * r];
}
function arcPath(a0: number, a1: number, r0: number, r1: number): string {
  const [x0, y0] = pol(a0, r1), [x1, y1] = pol(a1, r1);
  const [x2, y2] = pol(a1, r0), [x3, y3] = pol(a0, r0);
  const lg = (a1 - a0) > 180 ? 1 : 0;
  return `M${x0} ${y0}A${r1} ${r1} 0 ${lg} 1 ${x1} ${y1}L${x2} ${y2}A${r0} ${r0} 0 ${lg} 0 ${x3} ${y3}Z`;
}
function arcMid(a0: number, a1: number, r0: number, r1: number): [number, number] {
  return pol((a0 + a1) / 2, (r0 + r1) / 2);
}
function splitArcs(a0: number, a1: number, n: number): [number, number][] {
  if (n === 0) return [];
  if (n === 1) return [[a0, a1]];
  const m = (a0 + a1) / 2;
  return [[a0, m - 1.5], [m + 1.5, a1]];
}

// ── SVG icon paths (viewBox 0 0 24 24) ───────────────────────────────────────
const ICONS: Record<PieIconName, string> = {
  'approve':     `<path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  'approve-all': `<path d="M3 12.5l4.5 4.5L17 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>
                  <path d="M10 12.5l4.5 4.5L24 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/>`,
  'deny':        `<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="1.8" fill="none"/>
                  <path d="M6 6l12 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>`,
  'deny-all':    `<circle cx="8" cy="12" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/>
                  <path d="M3.5 7l9 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
                  <circle cx="18" cy="12" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/>
                  <path d="M13.5 7l9 10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>`,
  'timer':       `<circle cx="12" cy="13" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/>
                  <path d="M12 9v4l2.5 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
                  <path d="M9 2h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  'timer-long':  `<circle cx="12" cy="13" r="7" stroke="currentColor" stroke-width="1.8" fill="none"/>
                  <path d="M12 13l4-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
                  <path d="M9 2h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>`,
  'later':       `<path d="M8.5 9a3.5 3.5 0 116.2 2.2c-.8.9-1.7 1.3-1.7 2.8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>
                  <circle cx="13" cy="18" r="0.6" fill="currentColor"/>`,
};

// ── Component ─────────────────────────────────────────────────────────────────
@Component({
  selector: 'app-pie-menu',
  standalone: true,
  imports: [],
  template: `
    <button
      #trigger
      class="pie-trigger"
      [class.pie-trigger--open]="isOpen"
      (click)="onTriggerClick()"
      (mouseenter)="onTriggerEnter()"
      (mouseleave)="scheduleClose()"
      aria-label="Acties"
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        @if (isOpen) {
          <path d="M6 6l12 12M6 18L18 6"/>
        } @else {
          <path d="M12 5v14M5 12h14"/>
        }
      </svg>
    </button>
  `,
  styles: [`
    :host { display: inline-block; }
    .pie-trigger {
      display: grid !important;
      place-items: center !important;
      width: 30px !important;
      height: 30px !important;
      padding: 0 !important;
      border-radius: 50% !important;
      border: 1px solid var(--border) !important;
      background: var(--surface-2) !important;
      color: var(--text) !important;
      cursor: pointer !important;
      transition: background 160ms, color 160ms, border-color 160ms !important;
      box-sizing: border-box !important;
    }
    .pie-trigger--open {
      background: #1a1a18 !important;
      color: #faf8f3 !important;
      border-color: #1a1a18 !important;
    }
  `],
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PieMenuComponent implements OnDestroy {
  @Input({ required: true }) config!: PieMenuConfig;
  @Output() action = new EventEmitter<string>();
  @ViewChild('trigger') triggerEl!: ElementRef<HTMLButtonElement>;

  isOpen = false;
  openMode: 'hover' | 'click' = 'hover';
  hoveredFamily: string | null = null;

  private doc = inject(DOCUMENT);
  private cdr = inject(ChangeDetectorRef);
  private overlayEl: HTMLDivElement | null = null;
  private closeTimer: ReturnType<typeof setTimeout> | null = null;
  private outsideHandler: ((e: MouseEvent) => void) | null = null;
  private scrollHandler: (() => void) | null = null;

  // ── Trigger interactions ────────────────────────────────────────────────────

  onTriggerClick(): void {
    if (this.isOpen && this.openMode === 'click') { this.close(); return; }
    if (this.isOpen && this.openMode === 'hover') {
      this.openMode = 'click';
      this.cancelClose();
      this.updateVariantVisibility();
      return;
    }
    this.openPie('click');
  }

  onTriggerEnter(): void { this.openPie('hover'); }

  scheduleClose(): void {
    this.cancelClose();
    this.closeTimer = setTimeout(() => this.close(), 220);
  }
  cancelClose(): void {
    if (this.closeTimer) { clearTimeout(this.closeTimer); this.closeTimer = null; }
  }

  // ── Open / close ────────────────────────────────────────────────────────────

  private openPie(mode: 'hover' | 'click'): void {
    this.cancelClose();
    this.openMode = mode;
    if (!this.isOpen) {
      this.isOpen = true;
      this.cdr.markForCheck();
    }
    const rect = this.triggerEl.nativeElement.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;

    if (this.overlayEl) {
      this.overlayEl.style.left = `${cx}px`;
      this.overlayEl.style.top = `${cy}px`;
    } else {
      this.createOverlay(cx, cy);
    }
  }

  close(): void {
    this.isOpen = false;
    this.hoveredFamily = null;
    this.cdr.markForCheck();
    this.destroyOverlay();
  }

  // ── Portal: build and manage overlay DOM element ────────────────────────────

  private createOverlay(cx: number, cy: number): void {
    const div = this.doc.createElement('div');
    div.style.cssText = `
      position:fixed;
      left:${cx}px; top:${cy}px;
      width:${SIZE}px; height:${SIZE}px;
      transform:translate(-50%,-50%);
      z-index:9999;
      pointer-events:none;
    `;
    div.innerHTML = this.buildSvgHtml();
    this.doc.body.appendChild(div);
    this.overlayEl = div;
    this.attachListeners();
    this.attachOutsideHandler();
  }

  private buildSvgHtml(): string {
    const ro = ROUT + 8;
    const backdrop = `M${C-ro} ${C}A${ro} ${ro} 0 1 0 ${C+ro} ${C}A${ro} ${ro} 0 1 0 ${C-ro} ${C}Z M${C-22} ${C}A22 22 0 1 1 ${C+22} ${C}A22 22 0 1 1 ${C-22} ${C}Z`;

    let inner = `<path d="${backdrop}" fill-rule="evenodd" fill="transparent" pointer-events="all"/>`;

    this.config.families.forEach((family, i) => {
      const arc = PIE_ARCS[i];
      const a0 = arc.start + GAP, a1 = arc.end - GAP;
      const tone = PIE_TONES[family.tone];
      const [px, py] = arcMid(a0, a1, RIN + 4, RMID);
      const vArcs = splitArcs(a0, a1, (family.variants ?? []).length);

      inner += `
        <path data-primary data-family="${family.id}" data-action="${family.id}"
          d="${arcPath(a0, a1, RIN + 4, RMID)}"
          fill="${tone.bg}" stroke="rgba(0,0,0,.04)" stroke-width="1"
          style="cursor:pointer;transition:fill 140ms,stroke 140ms" pointer-events="all">
          <title>${family.label}</title>
        </path>
        <svg x="${px - 9}" y="${py - 9}" width="18" height="18" viewBox="0 0 24 24"
          fill="none" color="${tone.fg}" style="pointer-events:none;overflow:visible">
          ${ICONS[family.icon] ?? ''}
        </svg>
        <g data-variants data-family="${family.id}" style="display:${this.openMode === 'click' ? '' : 'none'}">
      `;

      (family.variants ?? []).forEach((variant, vi) => {
        const [va0, va1] = vArcs[vi];
        const [vx, vy] = arcMid(va0, va1, RMID + 4, ROUT);
        inner += `
          <path data-variant data-family="${family.id}" data-action="${variant.id}"
            d="${arcPath(va0, va1, RMID + 4, ROUT)}"
            fill="${tone.bg}" stroke="rgba(0,0,0,.04)" stroke-width="1"
            style="cursor:pointer;transition:fill 140ms,stroke 140ms" pointer-events="all">
            <title>${family.label} → ${variant.label}</title>
          </path>
          <svg x="${vx - 8}" y="${vy - 8}" width="16" height="16" viewBox="0 0 24 24"
            fill="none" color="${tone.fg}" style="pointer-events:none;overflow:visible">
            ${ICONS[variant.icon] ?? ''}
          </svg>
        `;
      });

      inner += `</g>`;
    });

    return `
      <svg viewBox="0 0 ${SIZE} ${SIZE}" width="${SIZE}" height="${SIZE}"
        style="overflow:visible;filter:drop-shadow(0 10px 24px rgba(0,0,0,.18));
               animation:pie-pop 320ms cubic-bezier(.34,1.56,.64,1) both;transform-origin:center">
        ${inner}
      </svg>
    `;
  }

  private attachListeners(): void {
    if (!this.overlayEl) return;

    this.overlayEl.addEventListener('mouseenter', () => this.cancelClose());
    this.overlayEl.addEventListener('mouseleave', () => this.scheduleClose());

    this.overlayEl.querySelectorAll<SVGPathElement>('[data-action]').forEach(path => {
      const familyId = path.getAttribute('data-family')!;
      const actionId = path.getAttribute('data-action')!;

      path.addEventListener('mouseenter', () => {
        this.cancelClose();
        if (this.hoveredFamily !== familyId) {
          this.hoveredFamily = familyId;
          this.applyHoverStyles();
        }
      });

      path.addEventListener('click', (e: Event) => {
        e.stopPropagation();
        this.action.emit(actionId);
        this.close();
      });
    });
  }

  private applyHoverStyles(): void {
    if (!this.overlayEl) return;
    this.config.families.forEach((family) => {
      const tone = PIE_TONES[family.tone];
      const isHover = this.hoveredFamily === family.id;
      const showVariants = this.openMode === 'click' || isHover;

      // Primary path fill/stroke
      const primary = this.overlayEl!.querySelector<SVGPathElement>(`[data-primary][data-family="${family.id}"]`);
      if (primary) {
        primary.setAttribute('fill', isHover ? tone.bgHover : tone.bg);
        primary.setAttribute('stroke', isHover ? tone.ring : 'rgba(0,0,0,.04)');
      }

      // Variant group show/hide + fill/stroke
      const varGroup = this.overlayEl!.querySelector<SVGGElement>(`[data-variants][data-family="${family.id}"]`);
      if (varGroup) {
        varGroup.style.display = showVariants ? '' : 'none';
        varGroup.querySelectorAll<SVGPathElement>('path[data-variant]').forEach(p => {
          p.setAttribute('fill', isHover ? tone.bgHover : tone.bg);
          p.setAttribute('stroke', isHover ? tone.ring : 'rgba(0,0,0,.04)');
        });
      }
    });
  }

  private updateVariantVisibility(): void {
    if (!this.overlayEl) return;
    this.overlayEl.querySelectorAll<SVGGElement>('[data-variants]').forEach(g => {
      g.style.display = '';
    });
  }

  private attachOutsideHandler(): void {
    const handler = (e: MouseEvent) => {
      const t = e.target as Node;
      if (this.overlayEl?.contains(t)) return;
      if (this.triggerEl?.nativeElement.contains(t)) return;
      this.close();
    };
    // slight delay so the opening click doesn't immediately close
    setTimeout(() => this.doc.addEventListener('mousedown', handler));
    this.outsideHandler = handler;
  }

  private destroyOverlay(): void {
    if (this.overlayEl) {
      this.doc.body.removeChild(this.overlayEl);
      this.overlayEl = null;
    }
    if (this.outsideHandler) {
      this.doc.removeEventListener('mousedown', this.outsideHandler);
      this.outsideHandler = null;
    }
  }

  ngOnDestroy(): void {
    this.cancelClose();
    this.destroyOverlay();
  }
}
