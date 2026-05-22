import { Component, inject } from '@angular/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { combineLatest, map } from 'rxjs';

@Component({
  selector: 'app-docker-access',
  standalone: true,
  imports: [AsyncPipe, NgClass, FormsModule],
  templateUrl: './docker-access.component.html',
  styles: []
})
export class DockerAccessComponent {
  private state = inject(StateService);
  private api = inject(ApiService);

  selectedContainer = '';
  selectedMinutes = 15;
  minuteOptions = [5, 10, 15, 20, 30];

  vm$ = combineLatest([this.state.grants$, this.state.containers$]).pipe(
    map(([grants, containers]) => ({
      entries: Object.entries(grants),
      containers,
      now: Math.floor(Date.now() / 1000),
    }))
  );

  remainingMinutes(until: number): number {
    return Math.ceil((until - Math.floor(Date.now() / 1000)) / 60);
  }

  revoke(container: string): void {
    this.api.deleteGrant(container).subscribe(() => this.state.loadAll());
  }

  grantAccess(): void {
    if (!this.selectedContainer || !this.selectedMinutes) return;
    this.api.setGrant(this.selectedContainer, this.selectedMinutes).subscribe(() => this.state.loadAll());
  }
}
