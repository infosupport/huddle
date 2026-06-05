import { Component, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AsyncPipe, NgClass } from '@angular/common';
import { StateService } from '../../core/services/state.service';
import { ApiService } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';
import { Container } from '../../core/models/container.model';
import { Rule } from '../../core/models/rule.model';
import { combineLatest, map } from 'rxjs';

@Component({
  selector: 'app-containers',
  standalone: true,
  imports: [AsyncPipe, NgClass, RouterLink],
  templateUrl: './containers.component.html',
  styles: [`:host { display: contents; }`]
})
export class ContainersComponent {
  private state = inject(StateService);
  private api = inject(ApiService);
  modal = inject(ModalService);

  vm$ = combineLatest([this.state.containers$, this.state.rules$, this.state.grants$]).pipe(
    map(([containers, rules, grants]) => ({
      containers, rules, grants,
      now: Math.floor(Date.now() / 1000),
    }))
  );

  isRunning(c: Container) { return (c.status || '').toLowerCase().includes('up'); }
  isRogue(c: Container) { return this.isRunning(c) && c.inNetwork === false; }
  statusClass(c: Container) { return this.isRogue(c) ? 'rogue' : this.isRunning(c) ? 'running' : 'stopped'; }
  statusLabel(c: Container) { return this.isRogue(c) ? 'Rogue' : this.isRunning(c) ? 'Running' : 'Stopped'; }
  scoreOf(name: string, rules: Rule[]) {
    const r = rules.filter(x => x.container_id === name);
    const a = r.filter(x => x.status === 'allow').length;
    const d = r.filter(x => x.status === 'deny').length;
    return a + d === 0 ? null : Math.round((a / (a + d)) * 100);
  }
  scoreClass(s: number | null) { return s === null ? 'muted' : s > 70 ? 'green' : s > 40 ? 'yellow' : 'red'; }
  sourcesLeaf(c: Container) {
    const p = c.workspacePath || c.labels?.['com.intellij.devcontainer.sources.path'] || c.Labels?.['com.intellij.devcontainer.sources.path'] || '';
    return p ? p.replace(/\\/g, '/').split('/').filter(Boolean).pop() || '—' : '—';
  }
  imageName(c: Container) { return (c.image || '').split('/').pop() || '—'; }
  requestedCount(name: string, rules: Rule[]) {
    return rules.filter(r => r.container_id === name && r.status === 'requested').length;
  }
  openSnapshot(c: Container) { this.modal.openSnapshot(c.name); }
  resumeContainer(name: string): void {
    this.api.resumeContainer(name).subscribe(() => this.state.loadAll());
  }
  deleteContainer(name: string): void {
    this.api.deleteContainer(name).subscribe(() => this.state.loadAll());
  }
}
