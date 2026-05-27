import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, throwError } from 'rxjs';
import { catchError } from 'rxjs/operators';
import { Container, ContainerDetail, DockerImage } from '../models/container.model';
import { Rule, RuleStatus } from '../models/rule.model';
import { Grant, GrantMap } from '../models/grant.model';
import { AuditLog } from '../models/audit-log.model';

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

  updateRule(id: number, status: RuleStatus, expiresAt?: number): Observable<Rule> {
    const body: any = { status };
    if (expiresAt !== undefined) body.expires_at = expiresAt;
    return this.handle(this.http.put<Rule>(`/api/rules/${id}`, body));
  }

  deleteRule(id: number): Observable<void> {
    return this.handle(this.http.delete<void>(`/api/rules/${id}`));
  }

  createRule(domain: string, container_id: string | null, status: RuleStatus): Observable<Rule> {
    return this.handle(this.http.post<Rule>('/api/rules', { domain, container_id, status }));
  }

  getContainerDetail(name: string): Observable<ContainerDetail> {
    return this.handle(this.http.get<ContainerDetail>(`/api/docker/containers/${name}`));
  }

  getContainerCredentials(name: string): Observable<{ password: string; createdAt: number }> {
    return this.handle(this.http.get<{ password: string; createdAt: number }>(`/api/docker/containers/${name}/credentials`));
  }

  snapshotContainer(name: string, imageName: string): Observable<{ imageId: string }> {
    return this.handle(this.http.post<{ imageId: string }>(`/api/docker/containers/${name}/snapshot`, { imageName }));
  }

  getImages(): Observable<DockerImage[]> {
    return this.handle(this.http.get<DockerImage[]>('/api/docker/images'));
  }

  getBaseImage(): Observable<{ imageName: string }> {
    return this.handle(this.http.get<{ imageName: string }>('/api/docker/base-image'));
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

  setGrant(container: string, minutes: number): Observable<Grant> {
    return this.handle(this.http.put<Grant>(`/api/authz/grants/${container}`, { minutes }));
  }

  deleteGrant(container: string): Observable<void> {
    return this.handle(this.http.delete<void>(`/api/authz/grants/${container}`));
  }

  deleteContainer(name: string): Observable<{ok: boolean}> {
    return this.handle(this.http.delete<{ok: boolean}>(`/api/docker/containers/${name}`));
  }

  getContainerIds(): Observable<string[]> {
    return this.handle(this.http.get<string[]>('/api/containers'));
  }

  reportBug(bug: { title: string; url: string; body?: string }): Observable<{ ok: boolean; filename: string }> {
    return this.handle(this.http.post<{ ok: boolean; filename: string }>('/api/bugs', bug));
  }

  getAuditLogs(params?: { container?: string; domain?: string; action?: string; limit?: number }): Observable<AuditLog[]> {
    const clean: Record<string, string> = {};
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v !== undefined && v !== null && v !== '') clean[k] = String(v);
      }
    }
    return this.handle(this.http.get<AuditLog[]>('/api/audit', { params: clean }));
  }
}
