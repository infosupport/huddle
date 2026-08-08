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
import { FirewallGroupsPanelComponent } from '../firewall/firewall-groups-panel.component';
import { BehaviorSubject, skip, forkJoin, Observable } from 'rxjs';

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
  imports: [AsyncPipe, RouterLink, RelTimePipe, DatePipe, FormsModule, PieMenuComponent, PathAllowlistComponent, ContainerTerminalComponent, IconComponent, DockerRightsPanelComponent, FirewallGroupsPanelComponent],
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
  // Ephemeral sudo grant. `sudoUntil` = unix seconds at which the grant expires
  // (null = no active grant). `sudoPassword` is only set right after a grant — it
  // comes from the server only once and is never fetched again.
  sudoUntil: number | null = null;
  sudoPassword: string | null = null;
  // Client-side expiry timer: mirrors the server-side sweep so the "Active" state
  // and the one-time password clear the instant the grant lapses, even if the page
  // is left open and idle. Torn down on destroy.
  private sudoExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  sudoMinutes = 15;
  sudoBusy = false;
  sudoError = '';
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
    // This page shows its own detail$ (getContainerDetail), separate from the
    // global state.rules$. Without this link a new firewall request only appeared
    // after a manual refresh. rules$ is refreshed by the WS, the foreground poll
    // (StateService) and every allow/deny (including the shared "For everyone"
    // confirmation modal, which calls state.loadAll()); reload the local detail
    // along with it.
    // skip(1): the BehaviorSubject fires immediately on subscribe — that first emit
    // already covers the load() above, so only later changes trigger a reload.
    this.state.rules$
      .pipe(skip(1), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => { if (this.name) this.load(); });
    this.loadSudoGrant();
    this.destroyRef.onDestroy(() => this.clearSudoExpiryTimer());
  }

  get sudoActive(): boolean { return this.sudoUntil != null && this.sudoUntil > this.nowTs; }

  loadSudoGrant(): void {
    this.api.getSudoGrant(this.name).subscribe({
      next: (g) => { this.setSudoUntil(g.active ? g.until : null); },
      error: () => { this.setSudoUntil(null); },
    });
  }

  grantSudo(): void {
    this.sudoBusy = true;
    this.sudoError = '';
    this.sudoPassword = null;
    this.api.grantSudo(this.name, this.sudoMinutes).subscribe({
      next: (r) => {
        this.sudoBusy = false;
        this.setSudoUntil(r.until);
        this.sudoPassword = r.password; // show once
        this.passwordVisible = true;
      },
      error: (err) => { this.sudoBusy = false; this.sudoError = err.message; },
    });
  }

  revokeSudo(): void {
    this.sudoBusy = true;
    this.sudoError = '';
    this.api.revokeSudo(this.name).subscribe({
      next: () => { this.sudoBusy = false; this.setSudoUntil(null); this.sudoPassword = null; },
      error: (err) => { this.sudoBusy = false; this.sudoError = err.message; },
    });
  }

  // Set the grant expiry and (re)arm the client-side timer. When the grant lapses
  // we drop the active state and wipe the (now server-invalidated) one-time
  // password from the screen — no manual refresh or poll needed.
  private setSudoUntil(until: number | null): void {
    this.sudoUntil = until;
    this.clearSudoExpiryTimer();
    if (until == null) return;
    const ms = (until - this.nowTs) * 1000;
    if (ms <= 0) { this.expireSudoGrant(); return; }
    this.sudoExpiryTimer = setTimeout(() => this.expireSudoGrant(), ms);
  }

  private expireSudoGrant(): void {
    this.clearSudoExpiryTimer();
    this.sudoUntil = null;
    this.sudoPassword = null;
    this.passwordVisible = false;
  }

  private clearSudoExpiryTimer(): void {
    if (this.sudoExpiryTimer != null) {
      clearTimeout(this.sudoExpiryTimer);
      this.sudoExpiryTimer = null;
    }
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

  // ── Pending selection (per section: domain requests vs path requests) ────────
  pendingSel = new Set<number>();
  pendingChecked(id: number): boolean { return this.pendingSel.has(id); }
  togglePending(id: number): void {
    this.pendingSel.has(id) ? this.pendingSel.delete(id) : this.pendingSel.add(id);
  }
  private allChecked(ids: number[]): boolean { return ids.length > 0 && ids.every((i) => this.pendingSel.has(i)); }
  private toggleAll(ids: number[]): void {
    if (ids.every((i) => this.pendingSel.has(i))) ids.forEach((i) => this.pendingSel.delete(i));
    else ids.forEach((i) => this.pendingSel.add(i));
  }
  private selectedCount(ids: number[]): number { return ids.filter((i) => this.pendingSel.has(i)).length; }

  domainAllChecked(rs: Rule[]): boolean { return this.allChecked(rs.map((r) => r.id)); }
  toggleDomainAll(rs: Rule[]): void { this.toggleAll(rs.map((r) => r.id)); }
  domainSelectedCount(rs: Rule[]): number { return this.selectedCount(rs.map((r) => r.id)); }
  pathAllChecked(rows: PathRequestRow[]): boolean { return this.allChecked(rows.map((p) => p.rule.id)); }
  togglePathAll(rows: PathRequestRow[]): void { this.toggleAll(rows.map((p) => p.rule.id)); }
  pathSelectedCount(rows: PathRequestRow[]): number { return this.selectedCount(rows.map((p) => p.rule.id)); }

  private afterBulk(ids: number[]): void {
    ids.forEach((i) => this.pendingSel.delete(i));
    this.state.loadAll();
    this.load();
  }

  // Bulk pie for domain requests — same config/actions as a single row (pieConfig).
  onBulkPie(actionId: string, requested: Rule[]): void {
    const rules = requested.filter((r) => this.pendingSel.has(r.id));
    if (!rules.length) return;
    const now = Math.floor(Date.now() / 1000);
    const call = (r: Rule): Observable<unknown> => {
      switch (actionId) {
        case 'approve':     return this.api.resolveRule(r.id, 'allow', 'rule');
        case 'approve-all': return this.api.resolveRule(r.id, 'allow', 'global');
        case 'temp':        return this.api.resolveRule(r.id, 'allow', 'rule', now + 5 * 60);
        case 'temp-10':     return this.api.resolveRule(r.id, 'allow', 'rule', now + 10 * 60);
        case 'later':       return this.api.deleteRule(r.id) as unknown as Observable<unknown>;
        case 'deny':        return this.api.resolveRule(r.id, 'deny', 'rule');
        case 'deny-all':    return this.api.resolveRule(r.id, 'deny', 'global');
        case 'pathmode':    return this.api.setPathMode(r.id, true);
        default:            return this.api.resolveRule(r.id, 'allow', 'rule');
      }
    };
    forkJoin(rules.map(call)).subscribe(() => this.afterBulk(rules.map((r) => r.id)));
  }

  // Bulk pie for path sub-requests — mirrors pieConfigPath / onPathPieAction.
  onBulkPathPie(actionId: string, pathReq: PathRequestRow[]): void {
    const rows = pathReq.filter((p) => this.pendingSel.has(p.rule.id));
    if (!rows.length) return;
    const call = (row: PathRequestRow): Observable<unknown> => {
      switch (actionId) {
        case 'path-allow':  return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, row.path_pattern);
        case 'path-prefix': return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, this.toPrefix(row.path_pattern));
        case 'path-deny':   return this.api.resolveRule(row.rule.id, 'deny', 'rule', undefined, row.path_pattern);
        case 'path-later':  return this.api.deleteRule(row.rule.id) as unknown as Observable<unknown>;
        default:            return this.api.resolveRule(row.rule.id, 'allow', 'rule', undefined, row.path_pattern);
      }
    };
    forkJoin(rows.map(call)).subscribe(() => this.afterBulk(rows.map((p) => p.rule.id)));
  }

  copyPassword(): void {
    if (!this.sudoPassword) return;
    navigator.clipboard.writeText(this.sudoPassword).then(() => {
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
