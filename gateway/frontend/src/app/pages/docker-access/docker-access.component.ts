import { Component, DestroyRef, OnInit, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { StateService } from '../../core/services/state.service';
import { ApiService, ApprovedHostPort } from '../../core/services/api.service';
import { DockerRightsPanelComponent } from '../../shared/components/docker-rights-panel/docker-rights-panel.component';

@Component({
  selector: 'app-docker-access',
  standalone: true,
  imports: [FormsModule, DockerRightsPanelComponent],
  templateUrl: './docker-access.component.html',
  styleUrl: './docker-access.component.css',
})
export class DockerAccessComponent implements OnInit {
  private state = inject(StateService);
  private api = inject(ApiService);
  private destroyRef = inject(DestroyRef);

  containers = toSignal(this.state.containers$, { initialValue: [] });
  selectedContainer = signal('');

  // ── Approved host ports (existing functionality) ───────────────────────────
  portsContainer = '';
  ports = signal<ApprovedHostPort[]>([]);
  portsError = signal<string | null>(null);
  newPortHost = '';
  newPortContainer = '';
  newPortProto = 'tcp';
  newPortDesc = '';

  ngOnInit(): void {
    this.state.containers$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe(cs => {
        if (!this.selectedContainer() && cs.length > 0) {
          this.selectedContainer.set(cs[0].name);
        }
        if (!this.portsContainer && cs.length > 0) {
          this.portsContainer = cs[0].name;
          this.loadPorts();
        }
      });
  }

  selectContainer(name: string): void {
    this.selectedContainer.set(name);
  }

  // ── Approved host ports (existing functionality) ───────────────────────────
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
