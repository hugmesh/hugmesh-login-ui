import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionService, SnapSession } from './session.service';

/**
 * httpOnly-cookie custody is the ONLY session model (login-ui #3): the former
 * localStorage `hug.session` mirror and its `__HUG_SESSION_COOKIE_MODE__` switch
 * are gone, so this suite runs against the service exactly as it ships.
 *
 * `/bff/session` + `/bff/sessionOut` go through the generated, typed
 * AuthControllerService (Angular {@code HttpClient}), so the suite drives them
 * through {@link HttpTestingController}. The server is modelled STATEFULLY where
 * the order matters (sign-out): `/bff/session` 200s while the cookie is alive
 * and 401s once `/bff/sessionOut` has landed — a test that only asserts "the
 * request was made" would pass a fire-and-forget logout that still loses the
 * race, and that race is the "sign-out did not sign out" defect.
 *
 * Cross-instance sync has two transports and each is exercised directly:
 *  - same document: `window` events on 'hug-session-change' (a sibling copy of
 *    this service carries the session in `detail`; the host shell dispatches a
 *    plain, detail-less Event);
 *  - other tabs: a BroadcastChannel of the same name (a peer channel opened by
 *    the test stands in for a sibling tab).
 */
const HTTP = [provideHttpClient(), provideHttpClientTesting()];
const CHANNEL = 'hug-session-change';
const LEGACY_KEY = 'hug.session';
const PROBE = '__HUG_SESSION__';

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

/** Poll a predicate across macrotasks — BroadcastChannel delivery and the
 *  HttpClient pipeline both resolve a few turns after the triggering call. */
async function until(pred: () => boolean, what = 'condition'): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`${what} not met in time`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SessionService (httpOnly-cookie custody — the only session model)', () => {
  let svc: SessionService;
  let httpMock: HttpTestingController;
  // `/bff/sessionOut` contains '/bff/session', so match on the exact tail.
  const sessionReads = (): TestRequest[] => httpMock.match((r) => r.url.endsWith('/bff/session'));
  const sessionOuts = (): TestRequest[] => httpMock.match((r) => r.url.endsWith('/bff/sessionOut'));

  beforeEach(() => {
    localStorage.clear();
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.configureTestingModule({ providers: [SessionService, ...HTTP] });
    svc = TestBed.inject(SessionService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    delete (globalThis as any).__HUG_BFF_URL__;
    delete (globalThis as any).__HUG_OIDC_ENABLED__;
    delete (globalThis as any)[PROBE];
    localStorage.clear();
  });

  // ── in-memory state ─────────────────────────────────────────────────────

  it('starts EMPTY (the cookie is read via hydrate(), never from web storage)', () => {
    expect(svc.session()).toBeNull();
    expect(svc.loggedIn()).toBeFalse();
    expect(svc.isAdmin()).toBeFalse();
    expect(svc.fullyRegistered()).toBeFalse();
    expect(sessionReads().length).toBe(0); // construction alone issues no read
  });

  it('ignores a legacy localStorage hug.session: never read on construction, and never removed', () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeSession({ label: 'stale-mirror' })));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService, ...HTTP] });
    const fresh = TestBed.inject(SessionService);
    expect(fresh.session()).toBeNull();
    // NOT purged either: the host shell still owns and re-reads that key, and a
    // removal here would raise a `storage` event in every sibling tab's host —
    // signing them out visually while their cookie is live.
    expect(localStorage.getItem(LEGACY_KEY)).not.toBeNull();
  });

  it('set() updates the signal and writes NOTHING to web storage', () => {
    const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();
    svc.set(makeSession());
    expect(svc.loggedIn()).toBeTrue();
    expect(svc.session()?.label).toBe('alice@gmail.com');
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('isAdmin is true only when the admin role is present', () => {
    svc.set(makeSession({ roles: ['user'] }));
    expect(svc.isAdmin()).toBeFalse();
    svc.set(makeSession({ roles: ['user', 'admin'] }));
    expect(svc.isAdmin()).toBeTrue();
  });

  it('fullyRegistered gates strictly on registrationComplete === true', () => {
    svc.set(makeSession({ registrationComplete: false }));
    expect(svc.fullyRegistered()).toBeFalse();
    svc.patch({ registrationComplete: true });
    expect(svc.fullyRegistered()).toBeTrue();
  });

  it('patch() merges fields into the existing session (in memory)', () => {
    svc.set(makeSession());
    svc.patch({ roles: ['user', 'admin'] });
    expect(svc.session()?.roles).toEqual(['user', 'admin']);
    expect(svc.session()?.label).toBe('alice@gmail.com'); // unrelated fields preserved
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('patch() is a no-op when there is no session', () => {
    svc.patch({ registrationComplete: true });
    expect(svc.session()).toBeNull();
  });

  // ── same-document sync (host shell + sibling in-page instances) ─────────

  it('set() hands the session to in-page siblings as the event detail and posts ONCE cross-tab', () => {
    const post = spyOn(BroadcastChannel.prototype, 'postMessage');
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(CHANNEL, listener);
    try {
      svc.set(makeSession({ label: 'written' }));
    } finally {
      window.removeEventListener(CHANNEL, listener);
    }
    expect(seen.length).toBe(1);
    expect((seen[0] as SnapSession).label).toBe('written');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("adopts a sibling instance's same-document write from the detail — no network read", () => {
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: makeSession({ label: 'from-sibling', roles: ['user', 'mod'] }) }));
    expect(svc.session()?.label).toBe('from-sibling');
    expect(svc.session()?.roles).toEqual(['user', 'mod']);
    httpMock.expectNone((r) => r.url.endsWith('/bff/session'));
  });

  it("adopts a sibling instance's same-document sign-out (detail null)", () => {
    svc.set(makeSession());
    window.dispatchEvent(new CustomEvent(CHANNEL, { detail: null }));
    expect(svc.session()).toBeNull();
    expect((globalThis as any)[PROBE]).toBeNull();
  });

  it("re-hydrates on the host shell's plain (detail-less) broadcast instead of mistaking it for a sign-out", async () => {
    // The host and the other remotes dispatch `new Event('hug-session-change')`
    // after their own writes (e.g. the host syncing account status). Reading
    // `event.detail` (undefined) as "no session" would sign this remote out
    // visually every time that happens.
    svc.set(makeSession({ label: 'kept', roles: ['user'] }));
    window.dispatchEvent(new Event(CHANNEL));
    expect(svc.session()?.label).toBe('kept'); // not dropped
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    expect(reads[0].request.withCredentials).toBeTrue();
    reads[0].flush({ roles: ['user', 'admin'], registrationComplete: true });
    await until(() => svc.isAdmin(), 'authoritative re-hydrate');
    expect(svc.session()?.label).toBe('kept'); // identity survives the re-read
  });

  // ── hydrate(): the read of server truth ──────────────────────────────────

  it('hydrate() loads {roles,registrationComplete} from GET /bff/session with credentials, persisting nothing', async () => {
    const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();
    const pending = svc.hydrate();
    const [req] = sessionReads();
    expect(req.request.method).toBe('GET');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ roles: ['user', 'admin'], registrationComplete: true, mfaSatisfied: false });
    const s = await pending;
    expect(s?.roles).toEqual(['user', 'admin']);
    expect(svc.isAdmin()).toBeTrue();
    expect(svc.fullyRegistered()).toBeTrue();
    // no token is ever exposed (auth rides the httpOnly cookie)
    expect((s as any)?.bffToken).toBeUndefined();
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('hydrate() CORRECTS the roles while keeping the caller-established identity', async () => {
    // Operator report 2026-08-14: login()'s hardcoded roles:['user'] guess was
    // never corrected, so /mod's guard denied its own moderator. The server's
    // roles win; the label/provider login() established survive (the shell
    // renders the label — blanking it would log the user out of their own name).
    svc.set({ id: '', label: 'e2e-mod', provider: 'password', roles: ['user'], registrationComplete: true });
    const pending = svc.hydrate();
    sessionReads()[0].flush({ roles: ['mod'], registrationComplete: true });
    const s = await pending;
    expect(s?.roles).toEqual(['mod']);
    expect(svc.session()?.roles).toEqual(['mod']);
    expect(s?.label).toBe('e2e-mod');
    expect(s?.provider).toBe('password');
  });

  it('hydrate() drops to null (and clears the probe) on a non-OK /bff/session — not logged in', async () => {
    svc.set(makeSession());
    const pending = svc.hydrate();
    sessionReads()[0].flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(await pending).toBeNull();
    expect(svc.session()).toBeNull();
    expect((globalThis as any)[PROBE]).toBeNull();
    // A failed re-read is NOT an active sign-out: nothing to expire server-side.
    expect(sessionOuts().length).toBe(0);
  });

  it('hydrate() NEVER posts cross-tab — success or failure (a read must not fan out into more reads)', async () => {
    // The receiving tab's channel handler IS a hydrate. If a hydrate posted,
    // two open tabs would re-hydrate each other forever (a /bff/session storm).
    const post = spyOn(BroadcastChannel.prototype, 'postMessage');
    let pending = svc.hydrate();
    sessionReads()[0].flush({ roles: ['user'], registrationComplete: true });
    await pending;
    expect(post).not.toHaveBeenCalled();
    pending = svc.hydrate();
    sessionReads()[0].flush(null, { status: 401, statusText: 'Unauthorized' });
    await pending;
    expect(post).not.toHaveBeenCalled();
  });

  it('hydrate() still tells in-page siblings what it learned (detail carries the result)', async () => {
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(CHANNEL, listener);
    try {
      const pending = svc.hydrate();
      sessionReads()[0].flush({ roles: ['user', 'mod'], registrationComplete: false });
      await pending;
    } finally {
      window.removeEventListener(CHANNEL, listener);
    }
    expect(seen.length).toBe(1);
    expect((seen[0] as SnapSession).roles).toEqual(['user', 'mod']);
  });

  // ── cross-tab sync (BroadcastChannel) ───────────────────────────────────

  it("a sibling tab's post on the channel triggers exactly ONE re-hydrate here, then settles", async () => {
    const peer = new BroadcastChannel(CHANNEL); // stands in for another tab
    try {
      peer.postMessage('changed');
      let req: TestRequest | undefined;
      await until(() => { [req] = sessionReads(); return !!req; }, 'the re-hydrate read');
      expect(req!.request.withCredentials).toBeTrue();
      req!.flush({ roles: ['mod'], registrationComplete: true });
      await until(() => svc.session()?.roles?.[0] === 'mod', 'the re-hydrated session');
      // Settle: the hydrate did not post back, so no further read appears.
      await sleep(40);
      expect(sessionReads().length).toBe(0);
    } finally {
      peer.close();
    }
  });

  // ── clear(): sign-out order ─────────────────────────────────────────────

  it('clear() awaits POST /bff/sessionOut BEFORE dropping local state or notifying anyone', async () => {
    // Stateful server: /bff/session is 200 while the cookie is alive and 401
    // after sessionOut. Every notification makes a sibling (tab or in-page host
    // instance) re-read /bff/session — fired early, that read gets a 200 and
    // restores the session, so the ORDER is the contract, not the request.
    let alive = true;
    const post = spyOn(BroadcastChannel.prototype, 'postMessage');
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(CHANNEL, listener);
    try {
      svc.set(makeSession());
      seen.length = 0;
      post.calls.reset();

      const pending = svc.clear();
      // Nothing has been told yet, and no re-read has been provoked.
      expect(post).not.toHaveBeenCalled();
      expect(seen.length).toBe(0);
      expect(sessionReads().length).toBe(0);

      const [out] = sessionOuts();
      expect(out.request.method).toBe('POST');
      expect(out.request.withCredentials).toBeTrue();
      alive = false;
      out.flush({});
      await pending;

      expect(svc.session()).toBeNull();
      expect((globalThis as any)[PROBE]).toBeNull();
      expect(post).toHaveBeenCalledTimes(1);
      expect(seen).toEqual([null]);

      // A sibling that now re-reads sees the server's truth: the cookie is dead.
      const readBack = svc.hydrate();
      sessionReads()[0].flush(alive ? { roles: ['user'] } : null, alive ? undefined : { status: 401, statusText: 'Unauthorized' });
      expect(await readBack).toBeNull();
      expect(svc.loggedIn()).toBeFalse();
    } finally {
      window.removeEventListener(CHANNEL, listener);
    }
  });

  it('clear() still signs out locally when /bff/sessionOut fails (best-effort on the result, never on the order)', async () => {
    const post = spyOn(BroadcastChannel.prototype, 'postMessage');
    svc.set(makeSession());
    post.calls.reset();
    const pending = svc.clear();
    sessionOuts()[0].flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' });
    await pending;
    expect(svc.session()).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('nothing in sign-in → hydrate → sign-out touches web storage', async () => {
    const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();
    const removeItem = spyOn(Storage.prototype, 'removeItem').and.callThrough();
    const getItem = spyOn(Storage.prototype, 'getItem').and.callThrough();
    svc.set(makeSession());
    const h = svc.hydrate();
    sessionReads()[0].flush({ roles: ['user'], registrationComplete: true });
    await h;
    const c = svc.clear();
    sessionOuts()[0].flush({});
    await c;
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    expect(getItem).not.toHaveBeenCalled();
  });

  // ── CSRF double-submit ──────────────────────────────────────────────────

  it('csrfHeader() echoes the JS-readable XSRF-TOKEN cookie as X-CSRF-TOKEN', () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('a=1; XSRF-TOKEN=csrf-abc; b=2');
    expect(svc.csrfHeader()).toEqual({ 'X-CSRF-TOKEN': 'csrf-abc' });
  });

  it('csrfHeader() is empty when no XSRF-TOKEN cookie is present', () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('a=1; b=2');
    expect(svc.csrfHeader()).toEqual({});
  });

  // ── teardown ────────────────────────────────────────────────────────────

  it('ngOnDestroy() detaches from both transports and makes an in-flight read inert', async () => {
    // A torn-down instance (an unmounted remote; every reset TestBed) must not
    // keep hydrating on an injector that no longer exists — nor announce what a
    // still-in-flight read returned: that CustomEvent would be adopted by the
    // LIVE instances and overwrite a fresh sign-in's identity with stale data.
    const inFlight = svc.hydrate();
    const [pendingRead] = sessionReads();
    const seen: unknown[] = [];
    const listener = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener(CHANNEL, listener);
    try {
      svc.ngOnDestroy();
      // Inbound: neither transport reaches the dead instance any more.
      window.dispatchEvent(new Event(CHANNEL));
      expect(sessionReads().length).toBe(0);
      seen.length = 0; // (that plain Event of ours was recorded too)
      // Outbound: the read that was already in flight resolves to nothing and
      // announces nothing.
      pendingRead.flush({ roles: ['user', 'admin'], registrationComplete: true });
      expect(await inFlight).toBeNull();
      expect(seen.length).toBe(0);
      expect(svc.session()).toBeNull();
    } finally {
      window.removeEventListener(CHANNEL, listener);
    }
  });

  // ── bootstrap hydrate ───────────────────────────────────────────────────

  it('ensureHydrated() performs the bootstrap read ONCE per instance (memoised promise)', async () => {
    const a = svc.ensureHydrated();
    const b = svc.ensureHydrated();
    expect(b).toBe(a);
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    reads[0].flush({ roles: ['user'], registrationComplete: true });
    expect((await a)?.roles).toEqual(['user']);
    expect(svc.ensureHydrated()).toBe(a); // still the same, no new read
    expect(sessionReads().length).toBe(0);
  });
});

// ── __HUG_OIDC_ENABLED__: cosmetic provider tag only, custody unchanged ──────
describe('SessionService (OIDC flag is a provider tag, not a custody switch)', () => {
  let svc: SessionService;
  let httpMock: HttpTestingController;

  function build(oidc: boolean): void {
    if (oidc) (globalThis as any).__HUG_OIDC_ENABLED__ = true;
    else delete (globalThis as any).__HUG_OIDC_ENABLED__;
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService, ...HTTP] });
    svc = TestBed.inject(SessionService);
    httpMock = TestBed.inject(HttpTestingController);
  }

  afterEach(() => {
    delete (globalThis as any).__HUG_OIDC_ENABLED__;
    delete (globalThis as any).__HUG_BFF_URL__;
    delete (globalThis as any)[PROBE];
    localStorage.clear();
  });

  it('with the flag ON a bootstrap hydrate (no prior identity) tags provider=oidc; nothing persisted', async () => {
    build(true);
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session')).flush({ roles: ['user', 'admin'], registrationComplete: true });
    const s = await pending;
    expect(s?.provider).toBe('oidc');
    expect((s as any)?.bffToken).toBeUndefined();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('with the flag OFF the same hydrate falls back to the vestigial google tag; custody is identical', async () => {
    build(false);
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session')).flush({ roles: ['user'], registrationComplete: false });
    const s = await pending;
    expect(s?.provider).toBe('google');
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('never overrides a caller-established provider (a native sign-in stays password)', async () => {
    build(true);
    svc.set({ id: '', label: 'alice', provider: 'password', roles: ['user'], registrationComplete: true });
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session')).flush({ roles: ['user'], registrationComplete: true });
    expect((await pending)?.provider).toBe('password');
  });
});

// ── Non-secret post-hydrate probe (globalThis.__HUG_SESSION__) ──────────────
// Nothing is persisted to web storage, so the in-memory signal is the only
// source of the hydrated roles. The service mirrors the non-secret metadata onto
// this global so a black-box e2e can read the persona's roles back VERBATIM
// (e2e/tests/helpers/roles.ts readSessionProbe(), via auth-steps.ts).
describe('SessionService (__HUG_SESSION__ probe)', () => {
  let svc: SessionService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    (globalThis as any).__HUG_BFF_URL__ = 'https://bff.test';
    TestBed.configureTestingModule({ providers: [SessionService, ...HTTP] });
    svc = TestBed.inject(SessionService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    delete (globalThis as any)[PROBE];
    delete (globalThis as any).__HUG_BFF_URL__;
    localStorage.clear();
  });

  it('publishes the non-secret metadata (roles VERBATIM, NO token) after a hydrate', async () => {
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session'))
      .flush({ roles: ['user', 'admin', 'superadmin'], registrationComplete: true });
    await pending;
    const probe = (globalThis as any)[PROBE];
    // Roles are mirrored VERBATIM — no drop, no up-case, order preserved.
    expect(probe.roles).toEqual(['user', 'admin', 'superadmin']);
    expect(probe.registrationComplete).toBeTrue();
    // Strict non-secret subset: never a token-ish key.
    for (const key of Object.keys(probe)) {
      expect(/token/i.test(key)).toBeFalse();
    }
  });

  it('clears the probe to null on a non-OK /bff/session (logged out)', async () => {
    svc.set(makeSession());
    expect((globalThis as any)[PROBE]).not.toBeNull();
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session'))
      .flush(null, { status: 401, statusText: 'Unauthorized' });
    await pending;
    expect((globalThis as any)[PROBE]).toBeNull();
  });

  it('mirrors a set() onto the probe too (the sign-in write, before hydrate corrects it)', () => {
    svc.set(makeSession({ roles: ['user', 'mod'] }));
    expect((globalThis as any)[PROBE].roles).toEqual(['user', 'mod']);
    expect((globalThis as any)[PROBE].provider).toBe('google');
  });
});
