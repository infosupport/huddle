import { TestBed } from '@angular/core/testing';
import { provideZoneChangeDetection } from '@angular/core';
import { ActivatedRoute, convertToParamMap, ParamMap, Router } from '@angular/router';
import { BehaviorSubject, of } from 'rxjs';
import { ExtensionViewComponent } from './extension-view.component';
import { ApiService } from '../../../core/services/api.service';

describe('ExtensionViewComponent', () => {
  let params: BehaviorSubject<ParamMap>;

  const mounted = (host: HTMLElement) => [...host.querySelectorAll('.ext-host > *')]
    .map((el) => `${el.tagName.toLowerCase()}${el.getAttribute('initial-repo') ? `:${el.getAttribute('initial-repo')}` : ''}`);

  beforeAll(() => {
    for (const tag of ['ext-first', 'ext-second']) if (!customElements.get(tag)) customElements.define(tag, class extends HTMLElement {});
  });

  beforeEach(async () => {
    params = new BehaviorSubject(convertToParamMap({ id: 'first' }));
    await TestBed.configureTestingModule({
      providers: [
        provideZoneChangeDetection({ eventCoalescing: true }),
        { provide: ApiService, useValue: { getExtensions: () => of([{ id: 'first', name: 'First' }, { id: 'second', name: 'Second' }]) } },
        { provide: ActivatedRoute, useValue: { paramMap: params, snapshot: { paramMap: params.value } } },
        { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
      ],
    }).compileComponents();
  });

  it.each([
    ['another extension', { id: 'second' }, ['ext-second']],
    ['a page within the same extension', { id: 'first', repo: 'r1' }, ['ext-first:r1']],
  ])('shows %s when the route changes while the view stays open', async (_label, next, expected) => {
    // Arrange
    const fixture = TestBed.createComponent(ExtensionViewComponent);
    fixture.detectChanges();
    await fixture.whenStable();

    // Act
    params.next(convertToParamMap(next));
    await fixture.whenStable();

    // Assert
    expect(mounted(fixture.nativeElement)).toEqual(expected);
  });
});
