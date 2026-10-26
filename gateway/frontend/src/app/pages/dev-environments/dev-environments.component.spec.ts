import { TestBed } from '@angular/core/testing';
import { BehaviorSubject, of, throwError } from 'rxjs';
import { DevEnvironmentsComponent } from './dev-environments.component';
import { ApiService, ProviderStatus, RecreateState } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { ModalService } from '../../core/services/modal.service';

// Switching an environment provider on/off and following the recreate it starts.
describe('DevEnvironments provider toggle', () => {
  let providers: ProviderStatus[];
  let api: any;

  function sbx(over: Partial<ProviderStatus> = {}): ProviderStatus {
    return { id: 'sbx', label: 'Docker Sandbox', enabled: false, available: true, agents: ['claude'], ...over };
  }
  function create() {
    const fixture = TestBed.createComponent(DevEnvironmentsComponent);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(async () => {
    providers = [sbx()];
    api = {
      listEnvironments: vi.fn(() => of({ providers: providers.map(p => ({ ...p })) })),
      listSandboxes: vi.fn(() => of({ sandboxes: [] })),
      setEnvironmentEnabled: vi.fn((_id: string, enabled: boolean) => {
        providers = [sbx({ enabled })];
        return of({ enabled, steps: [] });
      }),
      recreateEnvironment: vi.fn(() => of({ running: true, reason: 'x', startedAt: 'now', results: [] })),
    };
    await TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: StateService, useValue: { containers$: new BehaviorSubject([]), rules$: new BehaviorSubject([]), loadAll: () => {} } },
        ModalService,
      ],
    }).compileComponents();
    TestBed.overrideComponent(DevEnvironmentsComponent, { set: { template: '' } });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('does not list sandboxes of a provider that is switched off', () => {
    create();
    expect(api.listSandboxes).not.toHaveBeenCalled();
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

  it('treats a 409 provider_disabled listing as no sandboxes, not as a failure', () => {
    providers = [sbx({ enabled: true })];
    api.listSandboxes.mockReturnValue(throwError(() => Object.assign(new Error('off'), { status: 409, code: 'provider_disabled' })));
    const c = create();
    expect(c.failed()).toEqual([]);
  });

  it('polls the provider status while a recreate runs and reloads when it is done', () => {
    vi.useFakeTimers();
    const running: RecreateState = { running: true, reason: 'enabled', startedAt: 'now', results: [] };
    providers = [sbx({ enabled: true, recreate: running })];
    create();
    expect(api.listEnvironments).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(DevEnvironmentsComponent.POLL_MS);
    expect(api.listEnvironments).toHaveBeenCalledTimes(2);
    providers = [sbx({ enabled: true, recreate: { ...running, running: false, finishedAt: 'later',
      results: [{ name: 'a', ok: true }, { name: 'b', ok: false, message: 'gone' }] } })];
    vi.advanceTimersByTime(DevEnvironmentsComponent.POLL_MS);
    // the poll that sees it finished triggers a full refresh (one more status call)
    expect(api.listEnvironments).toHaveBeenCalledTimes(4);
    vi.advanceTimersByTime(DevEnvironmentsComponent.POLL_MS * 3);
    expect(api.listEnvironments).toHaveBeenCalledTimes(4);
  });
});
