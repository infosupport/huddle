import { Component, inject, OnInit, signal, DestroyRef } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { AsyncPipe, DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService, ApprovedHostPort } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { ModalService } from '../../core/services/modal.service';
import { RelTimePipe } from '../../shared/pipes/rel-time.pipe';
import { Rule } from '../../core/models/rule.model';
import { PieMenuComponent } from '../../shared/components/pie-menu/pie-menu.component';
import { PieMenuConfig } from '../../shared/components/pie-menu/pie-menu.model';
import { PathAllowlistComponent } from '../../shared/components/path-allowlist/path-allowlist.component';
import { buildPathDomains, excludePathModeRules } from '../../shared/components/path-allowlist/path-allowlist.util';
import { ContainerTerminalComponent } from '../../shared/components/container-terminal/container-terminal.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { DockerRightsPanelComponent } from '../../shared/components/docker-rights-panel/docker-rights-panel.component';
import { BehaviorSubject, skip } from 'rxjs';

interface DetailData {
  inspect: any;
  rules: Rule[];
  globalRules: Rule[];
  huddleInNetwork?: boolean;
  airlocked?: boolean;
}

type DetailTab = 'firewall' | 'docker' | 'noot' | 'terminal';
type RulesTab  = 'allow' | 'deny' | 'path';

/** A path sub-request row for the pending inbox flat list */
interface PathRequestRow {
  rule: Rule;
  domain: string;
  path_pattern: string;
  last_path: string | null;
}

@Component({
  selector: 'app-container-detail',
  standalone: true,
  imports: [AsyncPipe, RouterLink, RelTimePipe, DatePipe, FormsModule, PieMenuComponent, PathAllowlistComponent, ContainerTerminalComponent, IconComponent, DockerRightsPanelComponent],
  templateUrl: './container-detail.component.html',
  styleUrl: './container-detail.component.css',
})
export class ContainerDetailComponent implements OnInit {
  private route = inject(ActivatedRoute);
  private api = inject(ApiService);
  private state = inject(StateService);
  private destroyRef = inject(DestroyRef);
  modal = inject(ModalService);

  get nowTs(): number { return Math.floor(Date.now() / 1000); }

  readonly pieConfig: PieMenuConfig = {
    families: [
      {
        id: 'approve', label: 'Allow', tone: 'green', icon: 'approve',
        variants: [{ id: 'approve-all', label: 'For everyone', icon: 'approve-all' }],
      },
      {
        id: 'temp', label: 'Temporary 5 min', tone: 'blue', icon: 'timer',
        variants: [
          { id: 'temp-10', label: 'Temporary 10 min', icon: 'timer-long' },
          { id: 'later',   label: 'Hide',              icon: 'later'      },
        ],
      },
      {
        id: 'deny', label: 'Deny', tone: 'red', icon: 'deny',
        variants: [{ id: 'deny-all', label: 'For everyone', icon: 'deny-all' }],
      },
      { id: 'pathmode', label: 'Path allowlist', tone: 'neutral', icon: 'filter' },
    ],
  };

  /** Pie for path sub-requests — same layout as the firewall inbox:
   *  path-related actions on the left (0=top,1=right,2=bottom,3=left). */
  readonly pieConfigPath: PieMenuConfig = {
    families: [
      { id: 'path-allow', label: 'Allow exact', tone: 'green', icon: 'approve' },
      { id: 'path-later', label: 'Dismiss', tone: 'neutral', icon: 'later' },
      { id: 'path-deny', label: 'Deny', tone: 'red', icon: 'deny' },
      { id: 'path-prefix', label: 'Allow prefix/*', tone: 'blue', icon: 'filter' },
    ],
  };

  /** Pending path sub-requests across this container's path-mode domains
   *  (container-scoped + global markers), flattened for the inbox — mirrors
   *  the firewall view's pathRequested list. */
  pathRequests(rules: Rule[], globalRules: Rule[]): PathRequestRow[] {
    const domains = [...buildPathDomains(rules), ...buildPathDomains(globalRules)];
    return domains.flatMap(pd =>
      pd.requested
        .filter(r => !!r.path_pattern)
        .map(r => ({
          rule: r,
          domain: pd.domain,
          path_pattern: r.path_pattern!,
          last_path: (r as any).last_path ?? null,
        })),
    );
  }

  onPathPieAction(actionId: string, row: PathRequestRow): void {
    const { rule } = row;
    switch (actionId) {
      case 'path-allow':
        this.api.resolveRule(rule.id, 'allow', 'rule', undefined, row.path_pattern)
          .subscribe(() => this.reload());
        break;
      case 'path-prefix': {
        const prefix = this.toPrefix(row.path_pattern);
        this.api.resolveRule(rule.id, 'allow', 'rule', undefined, prefix)
          .subscribe(() => this.reload());
        break;
      }
      case 'path-deny':
        this.api.resolveRule(rule.id, 'deny', 'rule', undefined, row.path_pattern)
          .subscribe(() => this.reload());
        break;
      case 'path-later':
        this.deleteRule(rule);
        break;
    }
  }

  private toPrefix(path: string): string {
    const parts = path.replace(/\/+$/, '').split('/');
    return parts.slice(0, -1).join('/') + '/*';
  }

  onPieAction(actionId: string, rule: Rule): void {
    switch (actionId) {
      case 'approve':     this.allowRule(rule); break;
      case 'approve-all': this.modal.openConfirm(rule, 'allow'); break;
      case 'temp':        this.allowTimed(rule, 5); break;
      case 'temp-10':     this.allowTimed(rule, 10); break;
      case 'later':       this.deleteRule(rule); break;
      case 'deny':        this.denyRule(rule); break;
      case 'deny-all':    this.modal.openConfirm(rule, 'deny'); break;
      case 'pathmode':    this.enablePathMode(rule); break;
    }
  }

  pathDomains(rules: Rule[]) { return buildPathDomains(rules); }
  excludePathMode(rules: Rule[]) { return excludePathModeRules(rules); }

  enablePathMode(rule: Rule): void {
    this.api.setPathMode(rule.id, true).subscribe(() => { this.state.loadAll(); this.load(); });
  }
  reload(): void { this.state.loadAll(); this.load(); }

  name = '';
  get shortName(): string { return this.name.replace(/^devcontainer-/, ''); }

  detail$ = new BehaviorSubject<DetailData | null>(null);
  error$ = new BehaviorSubject<string | null>(null);
  credentials: { password: string; createdAt: number } | null = null;
  passwordVisible = false;
  copied = false;
  activeTab: DetailTab = 'firewall';
  rulesTab: RulesTab = 'allow';
  reconnectStatus = '';
  ideLinkStatus = '';

  ports = signal<ApprovedHostPort[]>([]);
  portsError = signal<string | null>(null);
  newPortHost = '';
  newPortContainer = '';
  newPortProto = 'tcp';
  newPortDesc = '';

  ngOnInit(): void {
    this.name = this.route.snapshot.paramMap.get('name') ?? '';
    this.load();
    this.loadPorts();
    // Deze pagina toont zijn eigen detail$ (getContainerDetail), los van de
    // globale state.rules$. Zonder deze koppeling verscheen een nieuw firewall-
    // request pas na een handmatige refresh. rules$ wordt door de WS, de
    // voorgrond-poll (StateService) én elke allow/deny (incl. de gedeelde "For
    // everyone"-bevestigingsmodal, die state.loadAll() aanroept) ververst;
    // herlaad het lokale detail daarop mee.
    // skip(1): de BehaviorSubject vuurt meteen bij subscribe — die eerste emit
    // dekt de load() hierboven al, dus alleen latere wijzigingen triggeren een
    // herlaad.
    this.state.rules$
      .pipe(skip(1), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => { if (this.name) this.load(); });
    this.api.getContainerCredentials(this.name).subscribe({
      next: (c) => this.credentials = c,
      error: () => this.credentials = null,
    });
  }

  loadPorts(): void {
    this.api.getApprovedPorts(this.name).subscribe({
      next: (p) => this.ports.set(p),
      error: () => this.ports.set([]),
    });
  }

  addPort(): void {
    const hp = Number(this.newPortHost);
    if (!hp) return;
    this.portsError.set(null);
    this.api.addApprovedPort(this.name, {
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
    this.api.removeApprovedPort(this.name, id).subscribe(() => this.loadPorts());
  }

  load(): void {
    this.api.getContainerDetail(this.name).subscribe({
      next: (data: any) => this.detail$.next(data),
      error: (err) => this.error$.next(err.message),
    });
  }

  allowRules(rules: Rule[]) { return rules.filter(r => r.status === 'allow'); }
  denyRules(rules: Rule[]) { return rules.filter(r => r.status === 'deny'); }
  requestedRules(rules: Rule[]) { return rules.filter(r => r.status === 'requested'); }
  tempAllowRules(rules: Rule[]) {
    const now = Math.floor(Date.now() / 1000);
    return rules.filter(r => r.status === 'allow' && r.expires_at && r.expires_at > now);
  }
  permanentAllowRules(rules: Rule[]) { return rules.filter(r => r.status === 'allow' && !r.expires_at); }

  allowRule(rule: Rule): void {
    this.api.resolveRule(rule.id, 'allow').subscribe(() => { this.state.loadAll(); this.load(); });
  }
  denyRule(rule: Rule): void {
    this.api.resolveRule(rule.id, 'deny').subscribe(() => { this.state.loadAll(); this.load(); });
  }
  deleteRule(rule: Rule): void {
    this.api.deleteRule(rule.id).subscribe(() => { this.state.loadAll(); this.load(); });
  }
  allowTimed(rule: Rule, minutes: number): void {
    const expires_at = Math.floor(Date.now() / 1000) + minutes * 60;
    this.api.resolveRule(rule.id, 'allow', 'rule', expires_at).subscribe(() => { this.state.loadAll(); this.load(); });
  }

  copyPassword(): void {
    if (!this.credentials) return;
    navigator.clipboard.writeText(this.credentials.password).then(() => {
      this.copied = true;
      setTimeout(() => { this.copied = false; }, 2000);
    });
  }

  setTab(t: DetailTab): void { this.activeTab = t; }

  openIde(): void {
    this.ideLinkStatus = 'Fetching...';
    this.api.getIdeLink(this.name).subscribe({
      next: ({ link }) => { this.ideLinkStatus = ''; window.open(link, '_self'); },
      error: (err) => { this.ideLinkStatus = err.message; },
    });
  }

  toggleAirlock(current: boolean): void {
    this.api.setAirlock(this.name, !current).subscribe(() => { this.state.loadAll(); this.load(); });
  }

  reconnectHuddle(): void {
    this.reconnectStatus = 'Working...';
    this.api.reconnectHuddle(this.name).subscribe({
      next: () => { this.reconnectStatus = 'Connected'; this.load(); setTimeout(() => this.reconnectStatus = '', 2000); },
      error: (err) => { this.reconnectStatus = err.message; },
    });
  }
}
