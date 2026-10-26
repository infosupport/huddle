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
import { PathRequestRow, PendingRequestsComponent, buildDomainRequests, buildPathRequests } from '../../shared/components/pending-requests/pending-requests.component';
import { PathAllowlistComponent } from '../../shared/components/path-allowlist/path-allowlist.component';
import { buildPathDomains, excludePathModeRules } from '../../shared/components/path-allowlist/path-allowlist.util';
import { ContainerTerminalComponent } from '../../shared/components/container-terminal/container-terminal.component';
import { IconComponent } from '../../shared/components/icon/icon.component';
import { DockerRightsPanelComponent } from '../../shared/components/docker-rights-panel/docker-rights-panel.component';
import { FirewallGroupsPanelComponent } from '../firewall/firewall-groups-panel.component';
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

// Only hand the OS a JetBrains Gateway link: anything else the gateway might
// return, such as a javascript: URL, would run in the portal's origin.
const GATEWAY_LINK_PREFIX = 'jetbrains-gateway://';

function openGatewayLink(link: string): string {
  if (typeof link !== 'string' || !link.startsWith(GATEWAY_LINK_PREFIX)) return 'Unexpected link from the gateway; not opened.';
  window.open(link, '_self');
  return '';
}

@Component({
  selector: 'app-container-detail',
  standalone: true,
  imports: [AsyncPipe, RouterLink, RelTimePipe, DatePipe, FormsModule, PendingRequestsComponent, PathAllowlistComponent, ContainerTerminalComponent, IconComponent, DockerRightsPanelComponent, FirewallGroupsPanelComponent],
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

  pathRequests(rules: Rule[], globalRules: Rule[]): PathRequestRow[] { return buildPathRequests(rules, globalRules); }

  pathDomains(rules: Rule[]) { return buildPathDomains(rules); }
  excludePathMode(rules: Rule[]) { return excludePathModeRules(rules); }

  parseMounts(raw: string | undefined): { hostPath: string; containerPath: string }[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

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
  sshLinkStatus = '';

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
  requestedRules(rules: Rule[]) { return buildDomainRequests(rules); }
  tempAllowRules(rules: Rule[]) {
    const now = Math.floor(Date.now() / 1000);
    return rules.filter(r => r.status === 'allow' && r.expires_at && r.expires_at > now);
  }
  permanentAllowRules(rules: Rule[]) { return rules.filter(r => r.status === 'allow' && !r.expires_at); }

  copyPassword(): void {
    if (!this.sudoPassword) return;
    navigator.clipboard.writeText(this.sudoPassword).then(() => {
      this.copied = true;
      setTimeout(() => { this.copied = false; }, 2000);
    });
  }

  setTab(t: DetailTab): void { this.activeTab = t; }

  // Sets up the relay + sshd on the gateway side (can take a moment the first
  // time) and hands the jetbrains-gateway:// link to the OS, which opens Gateway.
  openSsh(): void {
    this.sshLinkStatus = 'Preparing SSH...';
    this.api.getSshLink(this.name).subscribe({
      next: ({ link }) => { this.sshLinkStatus = openGatewayLink(link); },
      error: (err) => { this.sshLinkStatus = err.message; },
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
