import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

export type Theme = 'light' | 'dark';

@Injectable({ providedIn: 'root' })
export class ThemeService {
  private _theme$ = new BehaviorSubject<Theme>(
    (localStorage.getItem('huddle-theme') as Theme) ?? 'light'
  );
  readonly theme$ = this._theme$.asObservable();

  constructor() {
    this.apply(this._theme$.value);
  }

  toggle(): void {
    this.apply(this._theme$.value === 'light' ? 'dark' : 'light');
  }

  private apply(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('huddle-theme', theme);
    this._theme$.next(theme);
  }
}
