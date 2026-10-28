import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { EnvironmentProvidersComponent } from './environment-providers.component';
import { ApiService, ProviderStatus, RecreateState } from '../../core/services/api.service';
import { ModalService } from '../../core/services/modal.service';

// Settings: switching an environment provider on/off and following the recreate it starts.
describe('EnvironmentProviders', () => {
  let providers: ProviderStatus[];
  let api: any;

  function sbx(over: Partial<ProviderStatus> = {}): ProviderStatus {
    return { id: 'sbx', label: 'Docker Sandbox', enabled: false, available: true, agents: ['claude'], ...over };
  }
  function create() {
    const fixture = TestBed.createComponent(EnvironmentProvidersComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(async () => {
    providers = [sbx()];
    api = {
      listEnvironments: vi.fn(() => of({ providers: providers.map(p => ({ ...p })) })),
      setEnvironmentEnabled: vi.fn((_id: string, enabled: boolean) => {
        providers = [sbx({ enabled })];
        return of({ enabled, steps: [] });
      }),
      recreateEnvironment: vi.fn(() => of({ running: true, reason: 'x', startedAt: 'now', results: [] })),
    };
    await TestBed.configureTestingModule({
      providers: [{ provide: ApiService, useValue: api }, ModalService],
    }).compileComponents();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('lists every provider the gateway reports', () => {
    providers = [sbx(), sbx({ id: 'fc', label: 'Firecracker' })];
    const c = create();
    expect(c.providers().map(p => p.id)).toEqual(['sbx', 'fc']);
  });

  it('asks for confirmation before switching on and does nothing when cancelled', () => {
    const c = create();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    c.toggleProvider(c.providers()[0]);
    expect(confirmSpy).toHaveBeenCalledOnce();
    expect(confirmSpy.mock.calls[0][0]).toMatch(/recreated/);
    expect(api.setEnvironmentEnabled).not.toHaveBeenCalled();
  });

  it('switches on after confirmation', () => {
    const c = create();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    c.toggleProvider(c.providers()[0]);
    expect(api.setEnvironmentEnabled).toHaveBeenCalledWith('sbx', true);
    expect(c.providerBusyLabel('sbx')).toBeUndefined();
  });

  it('cannot be switched on while the provider reports an unavailableReason', () => {
    providers = [sbx({ unavailableReason: 'egress port not published' })];
    const c = create();
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    c.toggleProvider(c.providers()[0]);
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(api.setEnvironmentEnabled).not.toHaveBeenCalled();
  });

  it('shows the steps when switching fails on a step', () => {
    const c = create();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const steps = [{ label: 'restart daemon', command: 'sbx daemon restart', code: 1, stdout: '', stderr: 'boom' }];
    api.setEnvironmentEnabled.mockReturnValue(of({ enabled: false, steps }));
    c.toggleProvider(c.providers()[0]);
    expect(c.providerSteps()['sbx']).toEqual(steps);
    expect(c.providerError()['sbx']).toBe('boom');
  });

  it('switching reloads the provider status', () => {
    const c = create();
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    c.toggleProvider(c.providers()[0]);
    expect(c.providers()[0].enabled).toBe(true);
  });

  it('polls while a recreate runs and stops once it is done', () => {
    vi.useFakeTimers();
    const running: RecreateState = { running: true, reason: 'enabled', startedAt: 'now', results: [] };
    providers = [sbx({ enabled: true, recreate: running })];
    create();
    expect(api.listEnvironments).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(EnvironmentProvidersComponent.POLL_MS);
    expect(api.listEnvironments).toHaveBeenCalledTimes(2);
    providers = [sbx({ enabled: true, recreate: { ...running, running: false, finishedAt: 'later', results: [] } })];
    vi.advanceTimersByTime(EnvironmentProvidersComponent.POLL_MS);
    expect(api.listEnvironments).toHaveBeenCalledTimes(3);
    vi.advanceTimersByTime(EnvironmentProvidersComponent.POLL_MS * 3);
    expect(api.listEnvironments).toHaveBeenCalledTimes(3);
  });
});
