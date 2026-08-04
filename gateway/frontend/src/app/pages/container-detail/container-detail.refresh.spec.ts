import { TestBed } from '@angular/core/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { of, Subject } from 'rxjs';
import { ContainerDetailComponent } from './container-detail.component';
import { ConfirmModalComponent } from '../../shared/modals/confirm-modal/confirm-modal.component';
import { ApiService } from '../../core/services/api.service';
import { StateService } from '../../core/services/state.service';
import { ModalService } from '../../core/services/modal.service';
import { Rule } from '../../core/models/rule.model';

// Bug: on container-detail a globally handled ('For everyone') requested rule
// stayed in the view until a manual refresh, while the inline 'Allow' did make it
// disappear immediately. Cause: the page shows its own detail$ (getContainerDetail);
// the inline actions called load(), but the shared confirmation modal only
// refreshed state.rules$ — not load().
describe('ContainerDetail refresh after global confirm', () => {
  function rule(over: Partial<Rule>): Rule {
    return {
      id: 1, domain: 'example.com', container_id: 'devcontainer-xyz', status: 'requested',
      created_at: 0, updated_at: 0, last_seen: 0, request_count: 1, path_pattern: null, ...over,
    };
  }

  let detailCalls: number;
  let rulesNow: Rule[];
  let api: any;

  beforeEach(async () => {
    detailCalls = 0;
    rulesNow = [rule({ id: 1, status: 'requested' })];
    api = {
      getContainerDetail: () => { detailCalls++; return of({ inspect: {}, rules: rulesNow.slice(), globalRules: [] }); },
      getApprovedPorts: () => of([]),
      getSudoGrant: () => of({ active: false, until: null }),
      getContainers: () => of([]),
      getRules: () => of(rulesNow.slice()),
      getGrants: () => of({}),
      resolveRule: (id: number, _status: any, scope: string = 'rule') => {
        // mimic backend: global allow removes the requested row + adds a global allow
        rulesNow = rulesNow.filter(r => r.id !== id);
        rulesNow.push(rule({ id: 99, container_id: null, status: 'allow' }));
        return of(rulesNow[rulesNow.length - 1]);
      },
    };

    await TestBed.configureTestingModule({
      providers: [
        provideZoneChangeDetection({ eventCoalescing: true }),
        { provide: ApiService, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { paramMap: { get: () => 'devcontainer-xyz' } } } },
        StateService,
        ModalService,
      ],
    }).compileComponents();
    // Replace the heavy template (child components) with an empty one — we test
    // behavior, not DOM.
    TestBed.overrideComponent(ContainerDetailComponent, { set: { template: '' } });
  });

  it('reloads local detail when a global confirm resolves', () => {
    const modal = TestBed.inject(ModalService);
    const fixture = TestBed.createComponent(ContainerDetailComponent);
    fixture.detectChanges(); // ngOnInit -> load() (call #1)
    expect(detailCalls).toBe(1);

    // Simulate 'For everyone' -> shared modal -> confirm()
    const modalFixture = TestBed.createComponent(ConfirmModalComponent);
    modal.openConfirm(rule({ id: 1, status: 'requested' }), 'allow');
    modalFixture.detectChanges();
    modalFixture.componentInstance.confirm();

    // Without the fix detailCalls stayed at 1 and the view showed the old rule.
    expect(detailCalls).toBe(2);
    expect(rulesNow.some(r => r.status === 'requested')).toBe(false);
  });
});
