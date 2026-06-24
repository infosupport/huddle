import { Component, OnInit, OnDestroy, ElementRef, ViewChild, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiService } from '../../../core/services/api.service';

@Component({
  selector: 'app-extension-view',
  standalone: true,
  template: `
    <div class="ext-view-wrap">
      @if (error) {
        <p class="empty-note">{{ error }}</p>
      } @else if (!ready) {
        <p class="empty-note">Extensie laden…</p>
      }
      <div #host class="ext-host"></div>
    </div>
  `,
  styles: [`
    :host { display: contents; }
    .ext-view-wrap { display: flex; flex-direction: column; flex: 1; min-height: 0; padding: 0; }
    .ext-host { flex: 1; }
    .empty-note { padding: 24px; color: var(--text-muted); }
  `]
})
export class ExtensionViewComponent implements OnInit, OnDestroy {
  @ViewChild('host', { static: true }) hostRef!: ElementRef<HTMLDivElement>;
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private api = inject(ApiService);

  ready = false;
  error: string | null = null;

  private scriptEl: HTMLScriptElement | null = null;

  ngOnInit(): void {
    const id   = this.route.snapshot.paramMap.get('id')!;
    const repo = this.route.snapshot.paramMap.get('repo') ?? undefined;
    this.loadExtension(id, repo);
  }

  private async loadExtension(id: string, repo?: string): Promise<void> {
    this.api.getExtensions().subscribe({
      next: (exts) => {
        const ext = exts.find(e => e.id === id);
        if (!ext) { this.error = `Extensie "${id}" niet gevonden.`; return; }
        this.mountWebComponent(id, ext.name, repo);
      },
      error: () => { this.error = 'Kon extensielijst niet ophalen.'; }
    });
  }

  private mountWebComponent(id: string, name: string, initialRepo?: string): void {
    const tagName = `ext-${id}`;
    const scriptSrc = `/ext/${id}/component.js`;

    const mount = () => {
      const el = document.createElement(tagName);
      if (initialRepo) el.setAttribute('initial-repo', initialRepo);

      // Listen for navigation events dispatched by the web component
      el.addEventListener('ext-navigate', (e: Event) => {
        const repo = (e as CustomEvent).detail?.repo as string | undefined;
        if (repo) {
          this.router.navigate(['/extensions/view', id, repo]);
        } else {
          this.router.navigate(['/extensions/view', id]);
        }
      });

      this.hostRef.nativeElement.appendChild(el);
      this.ready = true;
    };

    if (customElements.get(tagName)) { mount(); return; }

    this.scriptEl = document.createElement('script');
    this.scriptEl.src = scriptSrc;
    this.scriptEl.onload = () => {
      customElements.whenDefined(tagName).then(mount);
    };
    this.scriptEl.onerror = () => {
      this.error = `"${name}" heeft geen in-app UI (component.js ontbreekt). Open de extensie via de Openen-knop.`;
    };
    document.head.appendChild(this.scriptEl);
  }

  ngOnDestroy(): void {
    this.hostRef.nativeElement.innerHTML = '';
  }
}
