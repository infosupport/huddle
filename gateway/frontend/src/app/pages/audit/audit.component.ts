import { Component, inject, DestroyRef, signal } from '@angular/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { combineLatest, interval, startWith, switchMap, catchError, of } from 'rxjs';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ApiService } from '../../core/services/api.service';
import { AuditLog } from '../../core/models/audit-log.model';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';

@Component({
  selector: 'app-audit',
  standalone: true,
  imports: [AsyncPipe, NgClass, ReactiveFormsModule, RelTimePipe],
  templateUrl: './audit.component.html',
  styles: [`:host { display: contents; }`]
})
export class AuditComponent {
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  containerFilter = new FormControl('');
  domainFilter = new FormControl('');
  actionFilter = new FormControl('');
  pathFilter = new FormControl('');
  limitControl = new FormControl(1000);

  containers: string[] = [];
  expandedId = signal<number | null>(null);
  fetchError = signal<string | null>(null);

  logs$ = combineLatest([
    this.containerFilter.valueChanges.pipe(startWith('')),
    this.domainFilter.valueChanges.pipe(startWith('')),
    this.actionFilter.valueChanges.pipe(startWith('')),
    this.pathFilter.valueChanges.pipe(startWith('')),
    this.limitControl.valueChanges.pipe(startWith(1000)),
    interval(10_000).pipe(startWith(0)),
  ]).pipe(
    takeUntilDestroyed(this.destroyRef),
    switchMap(([container, domain, action, path, limit]) =>
      this.api.getAuditLogs({
        container: container || undefined,
        domain: domain || undefined,
        action: action || undefined,
        path: path || undefined,
        limit: limit ?? 1000,
      }).pipe(
        catchError((err) => {
          this.fetchError.set(err?.message ?? 'Fetch failed');
          return of([] as AuditLog[]);
        })
      )
    )
  );

  constructor() {
    this.api.getContainerIds().subscribe({
      next: (ids) => { this.containers = ids.sort(); },
      error: () => {},
    });
  }

  toggle(id: number): void {
    this.expandedId.set(this.expandedId() === id ? null : id);
  }

  actionClass(action: string): string {
    if (action === 'allow' || action.startsWith('admin:rule-allow') || action.startsWith('admin:grant')) return 'badge-allow';
    if (action === 'deny' || action.startsWith('admin:rule-deny') || action.startsWith('admin:rule-delete') || action.startsWith('admin:grant-revoke')) return 'badge-deny';
    return 'badge-pending';
  }

  statusClass(code: number | null): string {
    if (!code) return '';
    if (code < 300) return 'badge-allow';
    if (code < 400) return 'badge-pending';
    return 'badge-deny';
  }

  prettyJson(s: string | null): string {
    if (!s) return '';
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }
  }

  openRawBody(content: string): void {
    let display = content;
    try { display = JSON.stringify(JSON.parse(content), null, 2); } catch { /* keep as-is */ }
    const blob = new Blob([display], { type: 'text/plain; charset=utf-8' });
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  setTokenFilter(): void {
    this.pathFilter.setValue('token');
  }
}
