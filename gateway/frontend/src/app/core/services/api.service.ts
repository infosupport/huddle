import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Container, ContainerDetail, DockerImage } from '../models/container.model';
import { Rule, RuleStatus } from '../models/rule.model';
import { Grant, GrantMap } from '../models/grant.model';
import { DockerActionCatalog, DockerActionPolicies, DockerActionPolicyResult } from '../models/docker-action.model';
import { AuditLog } from '../models/audit-log.model';
import { Extension } from '../extensions/extension.model';
import { FirewallGroup, GroupDetail, ImportGroupResult } from '../models/group.model';

export interface HuddleSettings {
  defaultMemory: string;
  defaultCpus: string;
  extensionsFolder: string;
  firewallRulesFolder: string;
}

export interface ApprovedHostPort {
  id: number;
  container_id: string;
  host_port: number;
  container_port: number;
  protocol: string;
  description: string;
  created_at: number;
}

export interface FolderMapping {
  id: number;
  name: string;
  host_path: string;
  volume_name: string;
  container_path: string;
  read_only: number;
  enabled: number;
  sort_order: number;
}

@Injectable({ providedIn: 'root' })
export class ApiService {
  private http = inject(HttpClient);

  private handle<T>(obs: Observable<T>): Observable<T> {
    return obs.pipe(
      catchError((err) => {
        const msg = err?.error?.error ?? err?.message ?? 'Unknown error';
        return throwError(() => new Error(msg));
      })
    );
  }

  getContainers(): Observable<Container[]> {
    return this.handle(this.http.get<Container[]>('/api/docker/containers'));
  }

  getRules(params?: { status?: string; container?: string }): Observable<Rule[]> {
    return this.handle(this.http.get<Rule[]>('/api/rules', { params: params as any }));
  }

  getGrants(): Observable<GrantMap> {
    return this.handle(this.http.get<GrantMap>('/api/authz/grants'));
  }

  updateRule(id: number, status: RuleStatus, expiresAt?: number, pathPattern?: string | null): Observable<Rule> {
    const body: any = { status };
    if (expiresAt !== undefined) body.expires_at = expiresAt;
    if (pathPattern !== undefined) body.path_pattern = pathPattern;
    return this.handle(this.http.put<Rule>(`/api/rules/${id}`, body));
  }

  resolveRule(
    id: number,
    status: Exclude<RuleStatus, 'requested'>,
    scope: 'rule' | 'global' = 'rule',
    expiresAt?: number,
    pathPattern?: string | null,
  ): Observable<Rule> {
    const body: any = { status, scope };
    if (expiresAt !== undefined) body.expires_at = expiresAt;
    if (pathPattern !== undefined) body.path_pattern = pathPattern;
    return this.handle(this.http.post<Rule>(`/api/rules/${id}/resolve`, body));
  }

  setPathMode(id: number, enabled: boolean): Observable<Rule> {
    return this.handle(this.http.post<Rule>(`/api/rules/${id}/path-mode`, { enabled }));
  }

  deleteRule(id: number): Observable<void> {
    return this.handle(this.http.delete<void>(`/api/rules/${id}`));
  }

  createRule(domain: string, container_id: string | null, status: RuleStatus, path_pattern?: string | null): Observable<Rule> {
    const body: Record<string, unknown> = { domain, container_id, status };
    if (path_pattern != null) body['path_pattern'] = path_pattern;
    return this.handle(this.http.post<Rule>('/api/rules', body));
  }

  // ── Rules export / import (#69) ────────────────────────────────────────────
  exportRules(container?: string): Observable<unknown> {
    const params: Record<string, string> = {};
    if (container) params['container'] = container;
    return this.handle(this.http.get('/api/rules/export', { params }));
  }

  importRules(body: unknown): Observable<{ imported: number; updated: number; skipped: number }> {
    return this.handle(
      this.http.post<{ imported: number; updated: number; skipped: number }>('/api/rules/import', body),
    );
  }

  // ── Firewall groups (#69) ──────────────────────────────────────────────────
  getGroups(): Observable<FirewallGroup[]> {
    return this.handle(this.http.get<FirewallGroup[]>('/api/groups'));
  }

  getGroup(id: number): Observable<GroupDetail> {
    return this.handle(this.http.get<GroupDetail>(`/api/groups/${id}`));
  }

  createGroup(name: string, description = '', shared = false): Observable<FirewallGroup> {
    return this.handle(this.http.post<FirewallGroup>('/api/groups', { name, description, shared }));
  }

  updateGroup(id: number, patch: { name?: string; description?: string; shared?: boolean }): Observable<FirewallGroup> {
    return this.handle(this.http.put<FirewallGroup>(`/api/groups/${id}`, patch));
  }

  deleteGroup(id: number): Observable<{ ok: true }> {
    return this.handle(this.http.delete<{ ok: true }>(`/api/groups/${id}`));
  }

  assignRuleToGroup(groupId: number, ruleId: number): Observable<{ ok: true }> {
    return this.handle(this.http.post<{ ok: true }>(`/api/groups/${groupId}/rules`, { rule_id: ruleId }));
  }

  removeRuleFromGroup(groupId: number, ruleId: number): Observable<{ ok: true }> {
    return this.handle(this.http.delete<{ ok: true }>(`/api/groups/${groupId}/rules/${ruleId}`));
  }

  applyGroup(groupId: number, container: string | null): Observable<{ ok: true; applied: number; updated: number }> {
    return this.handle(this.http.post<{ ok: true; applied: number; updated: number }>(`/api/groups/${groupId}/apply`, { container }));
  }

  exportGroup(groupId: number): Observable<unknown> {
    return this.handle(this.http.get(`/api/groups/${groupId}/export`));
  }

  importGroup(envelope: unknown, mode: 'merge' | 'replace' = 'merge'): Observable<ImportGroupResult> {
    return this.handle(this.http.post<ImportGroupResult>('/api/groups/import', { mode, envelope }));
  }

  reloadFirewallRulesFolder(): Observable<{ folder: string | null; files: number; groups: number; imported: number; updated: number; errors: { file: string; message: string }[] }> {
    return this.handle(this.http.post<any>('/api/firewall-rules-folder/reload', {}));
  }

  getContainerDetail(name: string): Observable<ContainerDetail> {
    return this.handle(this.http.get<ContainerDetail>(`/api/docker/containers/${name}`));
  }

  // Ephemeral sudo grant: 'noot' starts locked without a password. These
  // endpoints grant/show/revoke temporary admin access. The password is
  // returned only once (on grantSudo); status never returns a password.
  getSudoGrant(name: string): Observable<{ active: boolean; until: number | null }> {
    return this.handle(this.http.get<{ active: boolean; until: number | null }>(`/api/docker/containers/${name}/sudo-grant`));
  }

  grantSudo(name: string, minutes: number): Observable<{ password: string; until: number }> {
    return this.handle(this.http.post<{ password: string; until: number }>(`/api/docker/containers/${name}/sudo-grant`, { minutes }));
  }

  revokeSudo(name: string): Observable<{ ok: boolean }> {
    return this.handle(this.http.delete<{ ok: boolean }>(`/api/docker/containers/${name}/sudo-grant`));
  }

  snapshotContainer(name: string, imageName: string): Observable<{ imageId: string }> {
    return this.handle(this.http.post<{ imageId: string }>(`/api/docker/containers/${name}/snapshot`, { imageName }));
  }

  getImages(ide?: string): Observable<DockerImage[]> {
    const params = ide ? { ide } : undefined;
    return this.handle(this.http.get<DockerImage[]>('/api/docker/images', params ? { params } : undefined));
  }

  getBaseImage(ide: string): Observable<{ imageName: string; ide: string }> {
    return this.handle(this.http.get<{ imageName: string; ide: string }>('/api/docker/base-image', { params: { ide } }));
  }

  startContainer(params: { image: string; ide: string; workspace: string; containerName: string; empty?: boolean }): Observable<{ id: string; containerName: string }> {
    return this.handle(this.http.post<{ id: string; containerName: string }>('/api/docker/start', {
      imageName: params.image,
      workspaceDir: params.workspace,
      containerName: params.containerName,
      ideName: params.ide,
      empty: params.empty === true,
    }));
  }

  resumeContainer(name: string): Observable<{ ok: boolean }> {
    return this.handle(this.http.post<{ ok: boolean }>(`/api/docker/containers/${encodeURIComponent(name)}/start`, {}));
  }

  setGrant(container: string, minutes: number): Observable<Grant> {
    return this.handle(this.http.put<Grant>(`/api/authz/grants/${container}`, { minutes }));
  }

  deleteGrant(container: string): Observable<void> {
    return this.handle(this.http.delete<void>(`/api/authz/grants/${container}`));
  }

  // ── Docker action policies (fine-grained Docker permissions) ───────────────
  getDockerActionCatalog(): Observable<DockerActionCatalog> {
    return this.handle(this.http.get<DockerActionCatalog>('/api/authz/docker-actions'));
  }

  getDockerActionPolicies(container: string): Observable<DockerActionPolicies> {
    return this.handle(this.http.get<DockerActionPolicies>(`/api/authz/docker-actions/${encodeURIComponent(container)}`));
  }

  setDockerActionPolicy(container: string, action: string, enabled: boolean): Observable<DockerActionPolicyResult> {
    return this.handle(this.http.put<DockerActionPolicyResult>(
      `/api/authz/docker-actions/${encodeURIComponent(container)}/${encodeURIComponent(action)}`,
      { enabled },
    ));
  }

  deleteContainer(name: string): Observable<{ok: boolean}> {
    return this.handle(this.http.delete<{ok: boolean}>(`/api/docker/containers/${name}`));
  }

  reconnectHuddle(name: string): Observable<{ok: boolean}> {
    return this.handle(this.http.post<{ok: boolean}>(`/api/docker/containers/${name}/reconnect-huddle`, {}));
  }

  setAirlock(name: string, airlocked: boolean): Observable<{ airlocked: boolean }> {
    return this.handle(this.http.post<{ airlocked: boolean }>(`/api/docker/containers/${name}/airlock`, { airlocked }));
  }

  getIdeLink(name: string): Observable<{ link: string }> {
    return this.handle(this.http.get<{ link: string }>(`/api/docker/containers/${name}/ide-link`));
  }

  getContainerIds(): Observable<string[]> {
    return this.handle(this.http.get<string[]>('/api/containers'));
  }

  getExtensions(): Observable<Extension[]> {
    return this.handle(this.http.get<Extension[]>('/api/extensions'));
  }

  uploadExtension(file: File): Observable<{ id: string; name: string; restartRequired: boolean }> {
    const form = new FormData();
    form.append('file', file);
    return this.handle(
      this.http.post<{ id: string; name: string; restartRequired: boolean }>('/api/extensions/upload', form),
    );
  }

  deleteExtension(id: string): Observable<{ ok: boolean }> {
    return this.handle(this.http.delete<{ ok: boolean }>(`/api/extensions/${id}`));
  }

  getExtensionSettings(id: string): Observable<Record<string, unknown>> {
    return this.handle(this.http.get<Record<string, unknown>>(`/api/ext/${id}/settings`));
  }

  saveExtensionSettings(id: string, values: Record<string, string>): Observable<void> {
    return this.handle(this.http.post<void>(`/api/ext/${id}/settings`, values));
  }

  getSettings(): Observable<HuddleSettings> {
    return this.handle(this.http.get<HuddleSettings>('/api/settings'));
  }

  saveSettings(values: Partial<HuddleSettings>): Observable<{ ok: boolean }> {
    return this.handle(this.http.post<{ ok: boolean }>('/api/settings', values));
  }

  getAuditLogs(params?: { container?: string; domain?: string; action?: string; path?: string; limit?: number }): Observable<AuditLog[]> {
    const clean: Record<string, string> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') clean[k] = String(v);
      }
    }
    return this.handle(this.http.get<AuditLog[]>('/api/audit', { params: clean }));
  }

  // ── Folder Mappings ─────────────────────────────────────────────────────────
  getFolderMappings(): Observable<FolderMapping[]> {
    return this.handle(this.http.get<FolderMapping[]>('/api/folder-mappings'));
  }

  createFolderMapping(m: Omit<FolderMapping, 'id'>): Observable<{ id: number }> {
    return this.handle(this.http.post<{ id: number }>('/api/folder-mappings', m));
  }

  updateFolderMapping(id: number, m: Partial<Omit<FolderMapping, 'id'>>): Observable<{ ok: boolean }> {
    return this.handle(this.http.put<{ ok: boolean }>(`/api/folder-mappings/${id}`, m));
  }

  deleteFolderMapping(id: number): Observable<{ ok: boolean }> {
    return this.handle(this.http.delete<{ ok: boolean }>(`/api/folder-mappings/${id}`));
  }

  // ── Approved Host Ports ──────────────────────────────────────────────────────
  getApprovedPorts(containerName: string): Observable<ApprovedHostPort[]> {
    return this.handle(this.http.get<ApprovedHostPort[]>(`/api/containers/${encodeURIComponent(containerName)}/ports`));
  }

  addApprovedPort(containerName: string, p: Omit<ApprovedHostPort, 'id' | 'container_id' | 'created_at'>): Observable<{ id: number }> {
    return this.handle(this.http.post<{ id: number }>(`/api/containers/${encodeURIComponent(containerName)}/ports`, p));
  }

  removeApprovedPort(containerName: string, id: number): Observable<{ ok: boolean }> {
    return this.handle(this.http.delete<{ ok: boolean }>(`/api/containers/${encodeURIComponent(containerName)}/ports/${id}`));
  }
}
