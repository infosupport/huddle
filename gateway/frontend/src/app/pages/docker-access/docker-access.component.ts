import { Component, inject, OnInit, signal } from '@angular/core';
import { AsyncPipe, NgClass } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { StateService } from '../../core/services/state.service';
import { ApiService, ApprovedHostPort } from '../../core/services/api.service';
import { combineLatest, map } from 'rxjs';

@Component({
  selector: 'app-docker-access',
  standalone: true,
  imports: [AsyncPipe, NgClass, FormsModule],
  templateUrl: './docker-access.component.html',
  styles: [`:host { display: contents; }`]
})
export class DockerAccessComponent implements OnInit {
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

  // Ports
  portsContainer = '';
  ports = signal<ApprovedHostPort[]>([]);
  portsError = signal<string | null>(null);
  newPortHost = '';
  newPortContainer = '';
  newPortProto = 'tcp';
  newPortDesc = '';

  ngOnInit(): void {
    this.state.containers$.subscribe(cs => {
      if (!this.portsContainer && cs.length > 0) {
        this.portsContainer = cs[0].name;
        this.loadPorts();
      }
    });
  }

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

  onPortsContainerChange(): void { this.loadPorts(); }

  loadPorts(): void {
    if (!this.portsContainer) return;
    this.api.getApprovedPorts(this.portsContainer).subscribe({
      next: (p) => this.ports.set(p),
      error: () => this.ports.set([]),
    });
  }

  addPort(): void {
    const hp = Number(this.newPortHost);
    if (!hp || !this.portsContainer) return;
    this.portsError.set(null);
    this.api.addApprovedPort(this.portsContainer, {
      host_port: hp,
      container_port: Number(this.newPortContainer) || hp,
      protocol: this.newPortProto,
      description: this.newPortDesc,
    }).subscribe({
      next: () => { this.newPortHost = ''; this.newPortContainer = ''; this.newPortDesc = ''; this.loadPorts(); },
      error: (e) => this.portsError.set(e.message),
    });
  }

  removePort(id: number): void {
    this.api.removeApprovedPort(this.portsContainer, id).subscribe(() => this.loadPorts());
  }
}
