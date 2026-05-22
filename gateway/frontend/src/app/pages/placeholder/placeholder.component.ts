import { Component, inject } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { AsyncPipe } from '@angular/common';
import { map } from 'rxjs/operators';

@Component({
  selector: 'app-placeholder',
  standalone: true,
  imports: [AsyncPipe],
  template: `
    <div class="page-header"><h1>{{ title$ | async }}</h1></div>
    <div class="card">
      <p class="empty-note">Binnenkort beschikbaar</p>
    </div>
  `,
  styles: [`:host { display: contents; }`]
})
export class PlaceholderComponent {
  private route = inject(ActivatedRoute);
  title$ = this.route.data.pipe(map(d => d['title'] ?? 'Pagina'));
}
