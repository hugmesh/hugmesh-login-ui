import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ActivatedRouteSnapshot, RouterStateSnapshot } from '@angular/router';
import { sessionHydrateGuard } from './session-hydrate.guard';
import { SessionService } from './session.service';

/** Poll a predicate across macrotasks (the hydrate resolves through HttpClient +
 *  a few microtask turns after the mocked response is flushed). */
async function until(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
}

describe('sessionHydrateGuard (bootstrap hydrate on every entry, never a gate)', () => {
  let httpMock: HttpTestingController;
  const run = () =>
    TestBed.runInInjectionContext(() =>
      sessionHydrateGuard({} as ActivatedRouteSnapshot, {} as RouterStateSnapshot),
    );
  const sessionReads = () => httpMock.match((r) => r.url.endsWith('/bff/session'));

  beforeEach(() => {
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.configureTestingModule({
      providers: [SessionService, provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    delete (globalThis as any).__HUG_BFF_URL__;
    delete (globalThis as any).__HUG_SESSION__;
  });

  it('returns true synchronously — it never blocks or denies a route', () => {
    // A Promise/Observable here would hold the front door hostage to a slow or
    // dark BFF; `true` (not a UrlTree) keeps forgot-password et al. reachable.
    expect(run()).toBeTrue();
  });

  it('kicks off exactly ONE cookie-authenticated /bff/session read, shared by repeated activations', async () => {
    const session = TestBed.inject(SessionService);
    run();
    run();
    run();
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    expect(reads[0].request.method).toBe('GET');
    expect(reads[0].request.withCredentials).toBeTrue();
    reads[0].flush({ roles: ['user'], registrationComplete: true });
    // Let the shared read settle inside this spec (a dangling continuation
    // would otherwise resolve during whichever spec runs next).
    await session.ensureHydrated();
  });

  it('lets the views catch up when the read resolves: a live cookie becomes a session, a 401 stays anonymous', async () => {
    const session = TestBed.inject(SessionService);
    expect(run()).toBeTrue();
    expect(session.session()).toBeNull(); // not yet — the guard already returned
    sessionReads()[0].flush({ roles: ['user', 'mod'], registrationComplete: true });
    await until(() => session.session() !== null);
    expect(session.session()?.roles).toEqual(['user', 'mod']);
    expect(session.fullyRegistered()).toBeTrue();
    // The bootstrap read is memoised: a later activation does not re-read.
    run();
    expect(sessionReads().length).toBe(0);
  });

  it('resolves an anonymous visitor to no session (the state the views start in)', async () => {
    const session = TestBed.inject(SessionService);
    const pending = session.ensureHydrated();
    run(); // shares the same in-flight read
    sessionReads()[0].flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(await pending).toBeNull();
    expect(session.loggedIn()).toBeFalse();
  });
});
