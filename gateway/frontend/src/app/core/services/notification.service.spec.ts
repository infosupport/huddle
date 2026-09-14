import { TestBed } from '@angular/core/testing';
import { BehaviorSubject } from 'rxjs';
import { NotificationService } from './notification.service';
import { StateService } from './state.service';
import { Rule } from '../models/rule.model';

describe('NotificationService', () => {
  class NotificationMock {
    static permission: NotificationPermission = 'granted';
    static requestPermission = vi.fn(async () => NotificationMock.permission);
  }

  function configureService(): NotificationService {
    TestBed.configureTestingModule({
      providers: [
        NotificationService,
        { provide: StateService, useValue: { rules$: new BehaviorSubject<Rule[]>([]) } },
      ],
    });

    return TestBed.inject(NotificationService);
  }

  beforeEach(() => {
    localStorage.clear();
    vi.stubGlobal('Notification', NotificationMock);
  });

  afterEach(() => {
    localStorage.clear();
    vi.unstubAllGlobals();
  });

  it('preserves a disabled preference after the service is recreated', async () => {
    const service = configureService();
    expect(service.enabled$.value).toBe(true);

    await service.toggle();
    expect(service.enabled$.value).toBe(false);

    TestBed.resetTestingModule();

    const recreatedService = configureService();
    expect(recreatedService.enabled$.value).toBe(false);
  });
});
