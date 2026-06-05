import { Component, OnInit, OnDestroy, ElementRef, ViewChild, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
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
  private api = inject(ApiService);

  ready = false;
  error: string | null = null;

  private scriptEl: HTMLScriptElement | null = null;

  ngOnInit(): void {
    const id = this.route.snapshot.paramMap.get('id')!;
    this.loadExtension(id);
  }

  private async loadExtension(id: string): Promise<void> {
    // Controleer of de extensie bestaat
    this.api.getExtensions().subscribe({
      next: (exts) => {
        const ext = exts.find(e => e.id === id);
        if (!ext) { this.error = `Extensie "${id}" niet gevonden.`; return; }
        this.mountWebComponent(id, ext.name);
      },
      error: () => { this.error = 'Kon extensielijst niet ophalen.'; }
    });
  }

  private mountWebComponent(id: string, name: string): void {
    const tagName = `ext-${id}`;
    const scriptSrc = `/ext/${id}/component.js`;

    const mount = () => {
      const el = document.createElement(tagName);
      this.hostRef.nativeElement.appendChild(el);
      this.ready = true;
    };

    // Als het custom element al geregistreerd is (bijv. na navigatie terug), direct mounten
    if (customElements.get(tagName)) { mount(); return; }

    // Script laden en daarna mounten
    this.scriptEl = document.createElement('script');
    this.scriptEl.src = scriptSrc;
    this.scriptEl.onload = () => {
      // Geef het custom element even tijd om te registreren
      customElements.whenDefined(tagName).then(mount);
    };
    this.scriptEl.onerror = () => {
      // Geen component.js → fallback: toon foutmelding
      this.error = `"${name}" heeft geen in-app UI (component.js ontbreekt). Open de extensie via de Openen-knop.`;
    };
    document.head.appendChild(this.scriptEl);
  }

  ngOnDestroy(): void {
    // Verwijder het custom element uit de host maar laat het script staan
    // zodat het element geregistreerd blijft bij navigatie terug.
    this.hostRef.nativeElement.innerHTML = '';
  }
}
