import { TestBed } from '@angular/core/testing';
import { ActivatedRouteSnapshot, Router, RouterStateSnapshot, UrlTree } from '@angular/router';
import { registeredGuard } from './registration.guard';
import { SessionService } from './session.service';

/**
 * The registeredGuard is the gate the host reuses to keep the Matrix/Mastodon
 * micro-frontends locked until login/registration completes — so it must allow
 * fully-registered users through and redirect everyone else to /login.
 */
describe('registeredGuard', () => {
  let session: jasmine.SpyObj<Pick<SessionService, 'fullyRegistered'>>;
  const loginTree = new UrlTree();
  const route = {} as ActivatedRouteSnapshot;
  const state = {} as RouterStateSnapshot;

  function run() {
    return TestBed.runInInjectionContext(() => registeredGuard(route, state));
  }

  beforeEach(() => {
    session = jasmine.createSpyObj('SessionService', ['fullyRegistered']);
    const router = jasmine.createSpyObj('Router', ['parseUrl']);
    router.parseUrl.and.returnValue(loginTree);
    TestBed.configureTestingModule({
      providers: [
        { provide: SessionService, useValue: session },
        { provide: Router, useValue: router },
      ],
    });
  });

  it('allows activation when the user is fully registered', () => {
    session.fullyRegistered.and.returnValue(true);
    expect(run()).toBeTrue();
  });

  it('redirects to /login when the user is not fully registered', () => {
    session.fullyRegistered.and.returnValue(false);
    const router = TestBed.inject(Router);
    expect(run()).toBe(loginTree);
    expect(router.parseUrl).toHaveBeenCalledWith('/login');
  });
});
