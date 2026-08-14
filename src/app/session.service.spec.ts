import { TestBed } from '@angular/core/testing';
import { SessionService, SnapSession } from './session.service';

function makeSession(over: Partial<SnapSession> = {}): SnapSession {
  return {
    id: 'google:alice@gmail.com',
    label: 'alice@gmail.com',
    provider: 'google',
    roles: ['user'],
    registrationComplete: false,
    ...over,
  };
}

describe('SessionService', () => {
  const KEY = 'hug.session';
  let service: SessionService;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [SessionService] });
    service = TestBed.inject(SessionService);
  });

  afterEach(() => localStorage.clear());

  it('starts with no session when localStorage is empty', () => {
    expect(service.session()).toBeNull();
    expect(service.loggedIn()).toBeFalse();
    expect(service.isAdmin()).toBeFalse();
    expect(service.fullyRegistered()).toBeFalse();
  });

  it('hydrates an existing session from localStorage on construction', () => {
    localStorage.setItem(KEY, JSON.stringify(makeSession({ label: 'persisted' })));
    const fresh = new SessionService();
    expect(fresh.session()?.label).toBe('persisted');
    expect(fresh.loggedIn()).toBeTrue();
  });

  it('tolerates a malformed stored session (returns null, no throw)', () => {
    localStorage.setItem(KEY, '{not valid json');
    const fresh = new SessionService();
    expect(fresh.session()).toBeNull();
  });

  it('set() persists to localStorage and flips loggedIn', () => {
    service.set(makeSession());
    expect(service.loggedIn()).toBeTrue();
    expect(JSON.parse(localStorage.getItem(KEY)!).label).toBe('alice@gmail.com');
  });

  it('isAdmin is true only when the admin role is present', () => {
    service.set(makeSession({ roles: ['user'] }));
    expect(service.isAdmin()).toBeFalse();
    service.set(makeSession({ roles: ['user', 'admin'] }));
    expect(service.isAdmin()).toBeTrue();
  });

  it('fullyRegistered gates strictly on registrationComplete === true', () => {
    service.set(makeSession({ registrationComplete: false }));
    expect(service.fullyRegistered()).toBeFalse();
    service.patch({ registrationComplete: true });
    expect(service.fullyRegistered()).toBeTrue();
  });

  it('patch() merges fields into the existing session and persists', () => {
    service.set(makeSession());
    service.patch({ roles: ['user', 'admin'] });
    expect(service.session()?.roles).toEqual(['user', 'admin']);
    expect(JSON.parse(localStorage.getItem(KEY)!).roles).toEqual(['user', 'admin']);
    // unrelated fields are preserved
    expect(service.session()?.label).toBe('alice@gmail.com');
  });

  it('patch() is a no-op when there is no session', () => {
    service.patch({ registrationComplete: true });
    expect(service.session()).toBeNull();
  });

  it('clear() removes the session, the persisted metadata, AND logs out the bff_ cookie', () => {
    // Auth now rides in the httpOnly bff_ cookie in every mode, so logout must
    // hit POST /bff/sessionOut to expire the server session — not just localStorage.
    const fetchSpy = spyOn(globalThis as any, 'fetch').and.resolveTo(new Response('{}', { status: 200 }));
    service.set(makeSession());
    service.clear();
    expect(service.session()).toBeNull();
    expect(localStorage.getItem(KEY)).toBeNull();
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(url.endsWith('/bff/sessionOut')).toBeTrue();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('broadcasts a same-document event on write so sibling instances re-read', () => {
    const other = new SessionService();
    expect(other.session()).toBeNull();
    // `service` writing must wake `other` (both share the same localStorage key).
    service.set(makeSession({ label: 'broadcasted' }));
    expect(other.session()?.label).toBe('broadcasted');
  });

  it('re-reads on a cross-tab storage event for its own key', () => {
    localStorage.setItem(KEY, JSON.stringify(makeSession({ label: 'from-other-tab' })));
    window.dispatchEvent(new StorageEvent('storage', { key: KEY }));
    expect(service.session()?.label).toBe('from-other-tab');
  });

  it('ignores storage events for unrelated keys', () => {
    service.set(makeSession({ label: 'keep' }));
    localStorage.setItem('something.else', 'x');
    window.dispatchEvent(new StorageEvent('storage', { key: 'something.else' }));
    expect(service.session()?.label).toBe('keep');
  });
});

// ── D6 cookie mode (per-UI flag, ships dark) ─────────────────────────────────
describe('SessionService (cookie mode)', () => {
  const KEY = 'hug.session';
  let svc: SessionService;

  beforeEach(() => {
    localStorage.clear();
    (globalThis as any).__HUG_SESSION_COOKIE_MODE__ = true;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    svc = TestBed.inject(SessionService);
  });

  afterEach(() => {
    delete (globalThis as any).__HUG_SESSION_COOKIE_MODE__;
    delete (globalThis as any).__HUG_BFF_URL__;
    localStorage.clear();
  });

  it('reports cookieMode and starts EMPTY (does not read localStorage)', () => {
    localStorage.setItem(KEY, JSON.stringify(makeSession({ label: 'stale' })));
    const fresh = new SessionService();
    expect(fresh.cookieMode).toBeTrue();
    // cookie mode IGNORES any persisted session — the cookie is authoritative.
    expect(fresh.session()).toBeNull();
  });

  it('set() does NOT persist the session to localStorage but updates the signal', () => {
    svc.set(makeSession({ label: 'in-memory' }));
    expect(svc.session()?.label).toBe('in-memory');
    expect(localStorage.getItem(KEY)).toBeNull();
  });

  it('clear() calls POST /bff/sessionOut and drops local state', async () => {
    const fetchSpy = spyOn(globalThis as any, 'fetch').and.resolveTo(
      new Response('{}', { status: 200 }));
    svc.set(makeSession());
    svc.clear();
    expect(svc.session()).toBeNull();
    expect(fetchSpy).toHaveBeenCalled();
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(url.endsWith('/bff/sessionOut')).toBeTrue();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('hydrate() loads {roles,registrationComplete} from GET /bff/session with credentials', async () => {
    const fetchSpy = spyOn(globalThis as any, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ roles: ['user', 'admin'], registrationComplete: true, mfaSatisfied: false }),
        { status: 200 }));
    const s = await svc.hydrate();
    expect(s?.roles).toEqual(['user', 'admin']);
    expect(svc.isAdmin()).toBeTrue();
    expect(svc.fullyRegistered()).toBeTrue();
    // no token is exposed in cookie mode (auth rides the httpOnly cookie).
    expect((s as any)?.bffToken).toBeUndefined();
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(url.endsWith('/bff/session')).toBeTrue();
    expect(init.credentials).toBe('include');
    // Genuine cookie-mode's OWN "never persist" contract must be unaffected by the
    // OIDC-mode persistence fix elsewhere in hydrate() — set()'s cookieModeEnabled()
    // gate is what's relied on here, asserted directly at the hydrate() call site.
    expect(localStorage.getItem('hug.session')).toBeNull();
  });

  it('hydrate() CORRECTS the roles in localStorage mode, keeping the identity', async () => {
    // Operator report 2026-08-14: hydrate() returned early in localStorage mode,
    // so login()'s hardcoded roles:['user'] guess was never corrected — /mod's
    // guard then denied its own moderator and crashed the remote's router
    // (NG04002 '/login'), i.e. "no clear way to administer matrix/mastodon".
    svc.set({ id: '', label: 'e2e-mod', provider: 'password', roles: ['user'],
              registrationComplete: true } as any);
    spyOn(globalThis as any, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ roles: ['mod'], registrationComplete: true }),
        { status: 200 }));
    const s = await svc.hydrate();
    expect(s?.roles).toEqual(['mod']);
    // the caller-established identity survives (the shell renders this label)
    expect(s?.label).toBe('e2e-mod');
    expect(s?.provider).toBe('password');
    // and the correction actually REACHES storage (the host shell re-reads it)
    expect(JSON.parse(localStorage.getItem('hug.session')!).roles).toEqual(['mod']);
  });

  it('hydrate() drops to null on a non-OK /bff/session (not logged in)', async () => {
    svc.set(makeSession());
    spyOn(globalThis as any, 'fetch').and.resolveTo(new Response('', { status: 401 }));
    const s = await svc.hydrate();
    expect(s).toBeNull();
    expect(svc.session()).toBeNull();
  });

  it('csrfHeader() echoes the JS-readable XSRF-TOKEN cookie as X-CSRF-TOKEN', () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('a=1; XSRF-TOKEN=csrf-abc; b=2');
    expect(svc.csrfHeader()).toEqual({ 'X-CSRF-TOKEN': 'csrf-abc' });
  });

  it('csrfHeader() is empty when no XSRF-TOKEN cookie is present', () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('a=1; b=2');
    expect(svc.csrfHeader()).toEqual({});
  });
});

// localStorage mode must NOT emit a CSRF header (byte-identical legacy path).
describe('SessionService (localStorage mode csrfHeader)', () => {
  it('csrfHeader() is empty and cookieMode is false by default', () => {
    delete (globalThis as any).__HUG_SESSION_COOKIE_MODE__;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    expect(svc.cookieMode).toBeFalse();
    expect(svc.csrfHeader()).toEqual({});
  });
});

// ── OIDC session mode (PR-4, ships dark behind __HUG_OIDC_ENABLED__) ────────
describe('SessionService (OIDC session mode)', () => {
  afterEach(() => {
    delete (globalThis as any).__HUG_OIDC_ENABLED__;
    delete (globalThis as any).__HUG_BFF_URL__;
    delete (globalThis as any).__HUG_SESSION_COOKIE_MODE__;
    localStorage.clear();
  });

  it('oidcSessionMode is FALSE by default (dark) and hydrate() is a no-op', async () => {
    delete (globalThis as any).__HUG_OIDC_ENABLED__;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    expect(svc.oidcSessionMode).toBeFalse();
    const fetchSpy = spyOn(globalThis as any, 'fetch');
    // localStorage mode + OIDC off → hydrate must NOT hit the network.
    await svc.hydrate();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('with OIDC on (cookie-mode flag off), hydrate() fetches /bff/session, tags provider=oidc, NO token persisted', async () => {
    (globalThis as any).__HUG_OIDC_ENABLED__ = true;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    expect(svc.oidcSessionMode).toBeTrue();
    const fetchSpy = spyOn(globalThis as any, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ roles: ['user', 'admin'], registrationComplete: true }), { status: 200 }),
    );
    const s = await svc.hydrate();
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(url.endsWith('/bff/session')).toBeTrue();
    expect(init.credentials).toBe('include');
    expect(s?.provider).toBe('oidc');
    // Browser holds ONLY the opaque bff_ cookie — never a JWT/bffToken.
    expect((s as any)?.bffToken).toBeUndefined();
    // Metadata (roles/registrationComplete — NEVER a token) DOES persist here,
    // same as legacy localStorage mode: the host shell (a SEPARATE Angular app/
    // bundle from this remote, with its OWN SessionService instance) has no
    // BroadcastChannel listener of its own and reads ONLY localStorage on its
    // own bootstrap — so a real Casdoor role grant synced server-side on every
    // native login (see AccountStore.ensureAccount) would never reach the host's
    // nav bar without this write. Only TRUE cookie-mode (a different flag,
    // covered separately below) skips it, in favor of its own BroadcastChannel
    // cross-instance sync.
    expect(localStorage.getItem('hug.session')).not.toBeNull();
    expect(JSON.parse(localStorage.getItem('hug.session')!).roles).toEqual(['user', 'admin']);
  });

  it('hydrate() clears any persisted session on a non-OK /bff/session (not logged in)', async () => {
    (globalThis as any).__HUG_OIDC_ENABLED__ = true;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    // Seed a stale persisted session first, so we can prove hydrate() clears it.
    svc.set({ id: '', label: 'x', provider: 'oidc', roles: ['user'], registrationComplete: false });
    expect(localStorage.getItem('hug.session')).not.toBeNull();

    spyOn(globalThis as any, 'fetch').and.resolveTo(new Response(null, { status: 401 }));
    const s = await svc.hydrate();
    expect(s).toBeNull();
    expect(localStorage.getItem('hug.session')).toBeNull();
    expect(svc.loggedIn()).toBeFalse();
  });
});

// ── Non-secret post-hydrate probe (globalThis.__HUG_SESSION__) ──────────────
// In OIDC/cookie custody nothing is persisted to web storage, so the in-memory
// signal is the only source of the hydrated roles. The service mirrors the
// non-secret metadata onto this global so a black-box e2e can read the persona's
// roles back VERBATIM (the read path e2e/tests/helpers/roles.ts' readSession()
// uses, via the auth-steps.ts scenarios in e2e/features/auth/).
describe('SessionService (__HUG_SESSION__ probe)', () => {
  const PROBE = '__HUG_SESSION__';

  afterEach(() => {
    delete (globalThis as any)[PROBE];
    delete (globalThis as any).__HUG_OIDC_ENABLED__;
    delete (globalThis as any).__HUG_BFF_URL__;
    delete (globalThis as any).__HUG_SESSION_COOKIE_MODE__;
    localStorage.clear();
  });

  it('publishes the non-secret metadata (roles VERBATIM, NO token) after an OIDC hydrate', async () => {
    (globalThis as any).__HUG_OIDC_ENABLED__ = true;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    spyOn(globalThis as any, 'fetch').and.resolveTo(
      new Response(JSON.stringify({ roles: ['user', 'admin', 'superadmin'], registrationComplete: true }), { status: 200 }),
    );
    await svc.hydrate();
    const probe = (globalThis as any)[PROBE];
    // Roles are mirrored VERBATIM — no drop, no up-case, order preserved.
    expect(probe.roles).toEqual(['user', 'admin', 'superadmin']);
    expect(probe.provider).toBe('oidc');
    // Strict non-secret subset: never a token-ish key.
    for (const key of Object.keys(probe)) {
      expect(/token/i.test(key)).toBeFalse();
    }
  });

  it('clears the probe to null on a non-OK /bff/session (logged out)', async () => {
    (globalThis as any).__HUG_OIDC_ENABLED__ = true;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    spyOn(globalThis as any, 'fetch').and.resolveTo(new Response('', { status: 401 }));
    await svc.hydrate();
    expect((globalThis as any)[PROBE]).toBeNull();
  });

  it('mirrors a legacy localStorage set() onto the probe too', () => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService] });
    const svc = TestBed.inject(SessionService);
    svc.set(makeSession({ roles: ['user', 'mod'] }));
    expect((globalThis as any)[PROBE].roles).toEqual(['user', 'mod']);
  });
});
