import { Injectable, inject, DestroyRef } from '@angular/core';
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

  containers$ = new BehaviorSubject<Container[]>([]);
  rules$ = new BehaviorSubject<Rule[]>([]);
  grants$ = new BehaviorSubject<GrantMap>({});
  loaded$ = new BehaviorSubject<boolean>(false);

  constructor() {
    this.loadAll();
    timer(5000, 5000)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.loadAll());
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
