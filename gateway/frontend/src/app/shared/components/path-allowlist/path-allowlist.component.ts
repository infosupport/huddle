import { Component, EventEmitter, Input, Output, inject } from '@angular/core';
import { ApiService } from '../../../core/services/api.service';
import { Rule } from '../../../core/models/rule.model';
import { RelTimePipe } from '../../pipes/rel-time.pipe';
import { PathDomainVm } from './path-allowlist.util';

// Presentatie + acties voor pad-allowlist domeinen. Gedeeld tussen de
// firewall-pagina en het container-detail, zodat beide exact dezelfde
// behandeling van subpaden tonen. Doet de API-calls zelf en stuurt `changed`
// uit zodat de ouder zijn state kan herladen.
@Component({
  selector: 'app-path-allowlist',
  standalone: true,
  imports: [RelTimePipe],
  template: `
    @for (pd of domains; track pd.marker.id) {
      <div class="pathmode-domain">
        <h4>
          {{ pd.domain }}
          <span class="badge badge-deny">{{ pd.scope }}</span>
          <button class="btn btn-delete btn-sm" (click)="disablePathMode(pd.marker)" title="Pad-allowlist uitschakelen">✕ modus uit</button>
        </h4>

        <h5>Openstaande subpaden ({{ pd.requested.length }})</h5>
        @if (pd.requested.length === 0) {
          <p class="empty-note">Geen openstaande subpaden</p>
        } @else {
          <table class="data-table">
            <thead><tr><th>Pad-patroon</th><th>Verzoeken</th><th>Laatste</th><th class="col-actions">Acties</th></tr></thead>
            <tbody>
              @for (r of pd.requested; track r.id) {
                <tr>
                  <td>
                    <input class="path-input" type="text"
                           [value]="pathEditValue(r)"
                           (input)="pathEdits[r.id] = $any($event.target).value" />
                    @if (r.last_path) {
                      <div class="full-path" title="Laatst geziene volledige pad">laatst: {{ r.last_path }}</div>
                    }
                  </td>
                  <td>{{ r.request_count }}</td>
                  <td>{{ r.last_seen | relTime }}</td>
                  <td class="col-actions path-actions">
                    <button class="btn btn-sm" (click)="approvePath(r, 'prefix')" title="Sta dit pad én alles eronder toe">Allow /*</button>
                    <button class="btn btn-sm" (click)="approvePath(r, 'exact')" title="Sta alleen exact dit pad toe">Allow exact</button>
                    <button class="btn btn-sm" (click)="approvePath(r, 'prefix', 5)" title="Tijdelijk 5 min (prefix)">5 min</button>
                    <button class="btn btn-sm" (click)="denyPath(r)" title="Blokkeer dit pad">Deny</button>
                    <button class="btn btn-delete btn-sm" (click)="deletePath(r)" title="Verwijder verzoek">✕</button>
                  </td>
                </tr>
              }
            </tbody>
          </table>
        }

        @if (pd.allowed.length > 0) {
          <details class="path-collapse">
            <summary><h5>Toegestane paden ({{ pd.allowed.length }})</h5></summary>
            <table class="data-table">
              <thead><tr><th>Pad-patroon</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
              <tbody>
                @for (r of pd.allowed; track r.id) {
                  <tr>
                    <td>{{ r.path_pattern }}</td>
                    <td>
                      <span class="badge badge-allow">allow</span>
                      @if (r.expires_at && r.expires_at > now) { <span class="badge">tijdelijk · {{ r.expires_at | relTime }}</span> }
                    </td>
                    <td>{{ r.last_seen | relTime }}</td>
                    <td class="col-actions"><button class="btn btn-delete btn-sm" (click)="deletePath(r)">✕</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }

        @if (pd.denied.length > 0) {
          <details class="path-collapse">
            <summary><h5>Geblokkeerde paden ({{ pd.denied.length }})</h5></summary>
            <table class="data-table">
              <thead><tr><th>Pad-patroon</th><th>Status</th><th>Laatste</th><th class="col-actions">Actie</th></tr></thead>
              <tbody>
                @for (r of pd.denied; track r.id) {
                  <tr>
                    <td>{{ r.path_pattern }}</td>
                    <td><span class="badge badge-deny">deny</span></td>
                    <td>{{ r.last_seen | relTime }}</td>
                    <td class="col-actions"><button class="btn btn-delete btn-sm" (click)="deletePath(r)">✕</button></td>
                  </tr>
                }
              </tbody>
            </table>
          </details>
        }
      </div>
    }
  `,
  styles: [`
    .pathmode-domain { padding: 0.5rem 0; border-top: 1px solid var(--border, #e4e0d6); }
    .pathmode-domain:first-of-type { border-top: none; }
    .pathmode-domain h4 { display: flex; align-items: center; gap: 0.5rem; }
    .pathmode-domain h4 .btn { margin-left: auto; }
    .pathmode-domain h5 { margin: 0.5rem 0 0.25rem; font-size: 0.8rem; opacity: 0.8; }
    .path-input { width: 100%; min-width: 12rem; font-family: monospace; font-size: 0.85rem; padding: 0.2rem 0.4rem; box-sizing: border-box; }
    .full-path { margin-top: 0.2rem; font-family: monospace; font-size: 0.75rem; opacity: 0.65; word-break: break-all; }
    .path-actions { display: flex; flex-wrap: wrap; gap: 0.25rem; justify-content: flex-end; }
    .path-collapse > summary { cursor: pointer; list-style: revert; user-select: none; }
    .path-collapse > summary > h5 { display: inline; }
  `],
})
export class PathAllowlistComponent {
  private api = inject(ApiService);

  @Input() domains: PathDomainVm[] = [];
  @Input() now = 0;
  @Output() changed = new EventEmitter<void>();

  // Lokale, bewerkbare padpatronen per requested-subpad (key = rule.id).
  pathEdits: Record<number, string> = {};

  pathEditValue(rule: Rule): string {
    return this.pathEdits[rule.id] ?? rule.path_pattern ?? '';
  }

  // Prefix-match: garandeer een trailing `*` (`/api` → `/api/*`).
  private toPrefix(p: string): string {
    let s = p.trim();
    if (!s.startsWith('/')) s = '/' + s;
    if (s.endsWith('*')) return s;
    return (s.endsWith('/') ? s : s + '/') + '*';
  }
  // Exacte match: strip een eventuele trailing `/*` of `*`.
  private toExact(p: string): string {
    let s = p.trim();
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/?\*+$/, '');
    return s || '/';
  }

  approvePath(rule: Rule, mode: 'prefix' | 'exact', minutes?: number): void {
    const raw = this.pathEditValue(rule);
    const pattern = mode === 'prefix' ? this.toPrefix(raw) : this.toExact(raw);
    const expires = minutes ? Math.floor(Date.now() / 1000) + minutes * 60 : undefined;
    this.api.updateRule(rule.id, 'allow', expires, pattern).subscribe(() => this.changed.emit());
  }
  denyPath(rule: Rule): void {
    this.api.updateRule(rule.id, 'deny', undefined, this.toPrefix(this.pathEditValue(rule))).subscribe(() => this.changed.emit());
  }
  deletePath(rule: Rule): void {
    this.api.deleteRule(rule.id).subscribe(() => this.changed.emit());
  }
  disablePathMode(rule: Rule): void {
    this.api.setPathMode(rule.id, false).subscribe(() => this.changed.emit());
  }
}
