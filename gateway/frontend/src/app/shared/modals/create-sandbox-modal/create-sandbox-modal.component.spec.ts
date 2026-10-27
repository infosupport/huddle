import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CreateSandboxModalComponent } from './create-sandbox-modal.component';
import { ApiService, ProviderStatus } from '../../../core/services/api.service';
import { ModalService } from '../../../core/services/modal.service';

// The sandbox modal is opened for one provider (its "+" on Dev Environments): no type choice.
describe('CreateSandboxModal', () => {
  let providers: ProviderStatus[];
  let api: any;
  let modal: ModalService;

  function sbx(over: Partial<ProviderStatus> = {}): ProviderStatus {
    return { id: 'sbx', label: 'Docker Sandbox', enabled: true, available: true, agents: ['claude', 'codex'], ...over };
  }
  function open(id = 'sbx') {
    const fixture = TestBed.createComponent(CreateSandboxModalComponent);
    modal.openSandbox(id);
    fixture.detectChanges();
    return fixture.componentInstance;
  }

  beforeEach(async () => {
    try { localStorage.clear(); } catch { /* no storage */ }
    providers = [sbx(), sbx({ id: 'fc', label: 'Firecracker', agents: ['claude'] })];
    api = {
      listEnvironments: vi.fn(() => of({ providers })),
      createSandbox: vi.fn(() => of({ ok: true, steps: [] })),
    };
    await TestBed.configureTestingModule({ providers: [{ provide: ApiService, useValue: api }, ModalService] }).compileComponents();
    TestBed.overrideComponent(CreateSandboxModalComponent, { set: { template: '' } });
    modal = TestBed.inject(ModalService);
  });

  it('is for the provider it was opened with', () => {
    const c = open('fc');
    expect(c.open).toBe(true);
    expect(c.provider?.label).toBe('Firecracker');
    expect(c.sbxAgent).toBe('claude');
  });

  it('creates the sandbox with that provider and closes', () => {
    const c = open('sbx');
    c.mounts[0].hostPath = 'C:/projects/app';
    c.confirm();
    expect(api.createSandbox).toHaveBeenCalledWith('sbx', { name: undefined, agent: 'claude', workspaces: [{ path: 'C:/projects/app', readOnly: false }] });
    expect(modal.sandboxProvider()).toBeNull();
  });

  it('refuses when the provider is switched off', () => {
    providers = [sbx({ enabled: false })];
    const c = open('sbx');
    c.mounts[0].hostPath = 'C:/projects/app';
    c.confirm();
    expect(api.createSandbox).not.toHaveBeenCalled();
    expect(c.error).toMatch(/switched off/);
  });

  it('never makes the first folder read-only', () => {
    const c = open('sbx');
    c.onFoldersPicked(['C:/a', 'C:/b']);
    c.mounts[1].readOnly = true;
    c.removeMount(0);
    expect(c.mounts[0].readOnly).toBe(false);
  });
});
