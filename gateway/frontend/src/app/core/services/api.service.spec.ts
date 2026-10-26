import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ApiError, ApiService, isProviderDisabled } from './api.service';

describe('ApiService environment providers', () => {
  let api: ApiService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(ApiService);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('switches a provider on/off with PUT /api/environments/:provider', () => {
    let result: unknown;
    api.setEnvironmentEnabled('sbx', true).subscribe(r => (result = r));
    const req = http.expectOne('/api/environments/sbx');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ enabled: true });
    req.flush({ enabled: true, steps: [] });
    expect(result).toEqual({ enabled: true, steps: [] });
  });

  it('starts a recreate with POST /api/environments/:provider/recreate', () => {
    let result: unknown;
    api.recreateEnvironment('sbx').subscribe(r => (result = r));
    const req = http.expectOne('/api/environments/sbx/recreate');
    expect(req.request.method).toBe('POST');
    const state = { running: true, reason: 'requested in the portal', startedAt: 'now', results: [] };
    req.flush(state);
    expect(result).toEqual(state);
  });

  it('keeps the provider_disabled code of a 409', () => {
    let err: ApiError | undefined;
    api.listSandboxes('sbx').subscribe({ error: e => (err = e) });
    http.expectOne('/api/environments/sbx/sandboxes').flush(
      { error: 'provider_disabled', message: 'sbx is switched off' }, { status: 409, statusText: 'Conflict' });
    expect(err?.status).toBe(409);
    expect(err?.message).toBe('sbx is switched off');
    expect(isProviderDisabled(err)).toBe(true);
  });
});
