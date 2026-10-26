import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { PendingRequestsComponent, buildDomainRequests, buildPathRequests, toPathPrefix } from './pending-requests.component';
import { ApiService } from '../../../core/services/api.service';
import { StateService } from '../../../core/services/state.service';
import { ModalService } from '../../../core/services/modal.service';
import { Rule } from '../../../core/models/rule.model';

const rule = (over: Partial<Rule>): Rule => ({
  id: 1, domain: 'a.test', container_id: 'sbx:box', status: 'requested', request_count: 1,
  last_seen: 1, expires_at: null, path_pattern: null, path_mode: 0, ...over,
} as Rule);

// The pending requests of a devcontainer and of a sandbox: one component, so both
// pages offer the same actions.
describe('PendingRequestsComponent', () => {
  let api: any;
  let state: { loadAll: ReturnType<typeof vi.fn> };
  let modal: ModalService;

  function create(requested: Rule[]) {
    const fixture = TestBed.createComponent(PendingRequestsComponent);
    const c = fixture.componentInstance;
    c.requested = requested;
    let changed = 0;
    c.changed.subscribe(() => changed++);
    return { c, changed: () => changed };
  }

  beforeEach(async () => {
    api = {
      resolveRule: vi.fn(() => of({})),
      deleteRule: vi.fn(() => of(undefined)),
      setPathMode: vi.fn(() => of({})),
    };
    state = { loadAll: vi.fn() };
    await TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: api },
        { provide: StateService, useValue: state },
        ModalService,
      ],
    }).compileComponents();
    TestBed.overrideComponent(PendingRequestsComponent, { set: { template: '' } });
    modal = TestBed.inject(ModalService);
  });
  afterEach(() => vi.restoreAllMocks());

  it('offers every action: allow, global, temporary, hide, deny, path allowlist', () => {
    const { c } = create([]);
    const ids = c.pieConfig.families.flatMap(f => [f.id, ...(f.variants ?? []).map(v => v.id)]);
    expect(ids).toEqual(['approve', 'approve-all', 'temp', 'temp-10', 'later', 'deny', 'deny-all', 'pathmode']);
    expect(c.pieConfigPath.families.map(f => f.id)).toEqual(['path-allow', 'path-later', 'path-deny', 'path-prefix']);
  });

  it('runs each row action and reloads', () => {
    const r = rule({ id: 7 });
    const { c, changed } = create([r]);
    c.onPieAction('approve', r);
    expect(api.resolveRule).toHaveBeenLastCalledWith(7, 'allow', 'rule');
    c.onPieAction('deny', r);
    expect(api.resolveRule).toHaveBeenLastCalledWith(7, 'deny', 'rule');
    c.onPieAction('later', r);
    expect(api.deleteRule).toHaveBeenCalledWith(7);
    c.onPieAction('pathmode', r);
    expect(api.setPathMode).toHaveBeenCalledWith(7, true);
    c.onPieAction('temp', r);
    expect(api.resolveRule.mock.calls.at(-1)[3]).toBeGreaterThan(Date.now() / 1000);
    expect(changed()).toBe(5);
    expect(state.loadAll).toHaveBeenCalledTimes(5);
  });

  it('global allow and deny of one row go through the confirm modal', () => {
    const r = rule({ id: 7 });
    const { c } = create([r]);
    const open = vi.spyOn(modal, 'openConfirm');
    c.onPieAction('approve-all', r);
    c.onPieAction('deny-all', r);
    expect(open.mock.calls).toEqual([[r, 'allow'], [r, 'deny']]);
    expect(api.resolveRule).not.toHaveBeenCalled();
  });

  it('bulk: only the selected rows, global only after confirm', () => {
    const rs = [rule({ id: 1 }), rule({ id: 2 }), rule({ id: 3 })];
    const { c } = create(rs);
    c.togglePending(1);
    c.togglePending(3);
    expect(c.domainSelectedCount()).toBe(2);
    vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    c.onBulkPie('approve-all');
    expect(api.resolveRule).not.toHaveBeenCalled();
    c.onBulkPie('approve-all');
    expect(api.resolveRule.mock.calls).toEqual([[1, 'allow', 'global'], [3, 'allow', 'global']]);
    expect(c.domainSelectedCount()).toBe(0);
    c.toggleDomainAll();
    expect(c.domainAllChecked()).toBe(true);
  });

  it('path rows: exact, prefix, deny and dismiss', () => {
    const { c } = create([]);
    const row = { rule: rule({ id: 9, path_pattern: '/a/b' }), domain: 'a.test', path_pattern: '/a/b', last_path: null };
    c.pathRequests = [row];
    c.onPathPieAction('path-allow', row);
    expect(api.resolveRule).toHaveBeenLastCalledWith(9, 'allow', 'rule', undefined, '/a/b');
    c.onPathPieAction('path-prefix', row);
    expect(api.resolveRule).toHaveBeenLastCalledWith(9, 'allow', 'rule', undefined, '/a/*');
    c.onPathPieAction('path-deny', row);
    expect(api.resolveRule).toHaveBeenLastCalledWith(9, 'deny', 'rule', undefined, '/a/b');
    c.onPathPieAction('path-later', row);
    expect(api.deleteRule).toHaveBeenCalledWith(9);
    expect(toPathPrefix('/x/y/')).toBe('/x/*');
  });

  it('builds domain and path requests the same way for every page', () => {
    const marker = rule({ id: 20, domain: 'p.test', status: 'allow', path_mode: 1, container_id: null });
    const pathReq = rule({ id: 21, domain: 'p.test', path_pattern: '/x', path_mode: 1, container_id: null, last_seen: 5 });
    const newer = rule({ id: 2, last_seen: 9 });
    const older = rule({ id: 1, last_seen: 3 });
    const allowed = rule({ id: 3, status: 'allow' });
    expect(buildDomainRequests([older, allowed, newer]).map(r => r.id)).toEqual([2, 1]);
    expect(buildPathRequests([], [marker, pathReq]).map(p => [p.rule.id, p.domain, p.path_pattern])).toEqual([[21, 'p.test', '/x']]);
  });
});
