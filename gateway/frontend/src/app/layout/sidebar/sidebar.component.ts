import { Component, inject, OnInit, signal, ChangeDetectionStrategy } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { ApiService } from '../../core/services/api.service';
import { Extension } from '../../core/extensions/extension.model';

@Component({
  changeDetection: ChangeDetectionStrategy.Eager,
  selector: 'app-sidebar',
  standalone: true,
  imports: [RouterLink, RouterLinkActive, IconComponent],
  templateUrl: './sidebar.component.html',
  styles: []
})
export class SidebarComponent implements OnInit {
  private api = inject(ApiService);
  extensions = signal<Extension[]>([]);

  ngOnInit(): void {
    this.api.getExtensions().subscribe({ next: (e) => this.extensions.set(e), error: () => {} });
  }
}
