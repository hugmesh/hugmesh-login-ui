import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { SessionService, SnapSession } from './session.service';

/**
 * httpOnly-cookie custody is the ONLY session model (login-ui #3): the
 * localStorage session MODE and its `__HUG_SESSION_COOKIE_MODE__` switch are
 * gone, so this suite runs against the service exactly as it ships.
 *
 * Custody and TRANSPORT are separate, and both are pinned here. The `hug.session`
 * localStorage key is still PUBLISHED — a non-secret projection for the eleven
 * sibling remotes that still read their whole session from it and never call
 * `/bff/session` — but it is never AUTHORITATIVE: the signal starts null, only a
 * 2xx `/bff/session` can fill it, roles/registrationComplete always come from
 * that read, and a sign-out (or an answered 401) removes the key. The suite
 * asserts both halves: a forged mirror grants nothing, and a real sign-in
 * reaches the mirror with the server's roles.
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

  it('NEVER seeds itself from the hug.session mirror: a forged one grants no session and no role', () => {
    // The whole point of #3: web storage is not custody. A mirror claiming
    // admin must not make this service logged in, let alone an admin — only a
    // 2xx /bff/session can, and it is the sole source of roles.
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeSession({ label: 'forged', roles: ['admin', 'superadmin'] })));
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [SessionService, ...HTTP] });
    const fresh = TestBed.inject(SessionService);
    expect(fresh.session()).toBeNull();
    expect(fresh.loggedIn()).toBeFalse();
    expect(fresh.isAdmin()).toBeFalse();
    expect(sessionReads().length).toBe(0); // and construction reads no cookie either
  });

  it('a forged mirror is REMOVED once the server answers "not authenticated"', async () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeSession({ label: 'forged', roles: ['admin'] })));
    const pending = svc.hydrate();
    sessionReads()[0].flush(null, { status: 401, statusText: 'Unauthorized' });
    expect(await pending).toBeNull();
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('set() updates the signal AND publishes the non-secret mirror the fleet reads', () => {
    // hugmesh-host-shell + admin/mod/forum/user/user-mesh/wiki/tube/owncast/
    // mastodon/api-docs/superadmin-service-catalog each load their entire
    // session from this key and never call /bff/session; their route guards
    // bounce on the signal it produces. Not writing it locked every role-home
    // out after a successful sign-in.
    svc.set(makeSession({ roles: ['user', 'mod'] }));
    expect(svc.loggedIn()).toBeTrue();
    expect(svc.session()?.label).toBe('alice@gmail.com');
    const mirror = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    expect(mirror).toEqual({
      id: 'google:alice@gmail.com',
      label: 'alice@gmail.com',
      provider: 'google',
      roles: ['user', 'mod'],
      registrationComplete: false,
    });
    // Strict non-secret projection: auth rides the httpOnly cookie, so the
    // mirror carries no token-ish key (it never did).
    for (const key of Object.keys(mirror)) expect(/token|secret|cookie/i.test(key)).toBeFalse();
  });

  it('the mirror write is IDEMPOTENT — re-publishing the same session touches no storage', () => {
    // A `storage` event only reaches sibling tabs on a real byte change. Writing
    // unconditionally would wake the other tab, which would hydrate, write back,
    // and wake this one again — the ping-pong this guard exists to prevent.
    svc.set(makeSession());
    const setItem = spyOn(Storage.prototype, 'setItem').and.callThrough();
    const removeItem = spyOn(Storage.prototype, 'removeItem').and.callThrough();
    svc.set(makeSession());
    expect(setItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    // ...and a real change still lands.
    svc.set(makeSession({ roles: ['user', 'admin'] }));
    expect(setItem).toHaveBeenCalledTimes(1);
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null').roles).toEqual(['user', 'admin']);
  });

  it('publishing survives web storage that throws (private mode / quota)', () => {
    spyOn(Storage.prototype, 'setItem').and.throwError('QuotaExceededError');
    spyOn(Storage.prototype, 'getItem').and.throwError('SecurityError');
    expect(() => svc.set(makeSession())).not.toThrow();
    // The cookie still holds the session; only the convenience mirror is lost.
    expect(svc.loggedIn()).toBeTrue();
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

  it('patch() merges fields into the existing session, and the mirror follows', () => {
    svc.set(makeSession());
    svc.patch({ roles: ['user', 'admin'] });
    expect(svc.session()?.roles).toEqual(['user', 'admin']);
    expect(svc.session()?.label).toBe('alice@gmail.com'); // unrelated fields preserved
    const mirror = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    expect(mirror.roles).toEqual(['user', 'admin']);
    expect(mirror.label).toBe('alice@gmail.com');
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

  it('hydrate() loads {roles,registrationComplete} from GET /bff/session with credentials, and publishes them to the fleet mirror', async () => {
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
    // The SERVER's roles — not login()'s roles:['user'] guess — are what the
    // not-yet-migrated remotes' guards read out of the mirror.
    const mirror = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    expect(mirror.roles).toEqual(['user', 'admin']);
    expect(mirror.registrationComplete).toBeTrue();
    for (const key of Object.keys(mirror)) expect(/token|secret|cookie/i.test(key)).toBeFalse();
  });

  it('hydrate() takes its IDENTITY from the mirror, so every tab and remote resolves the same one', async () => {
    // /bff/session reports no id/label/provider. A second tab that hydrated on
    // its own would otherwise settle on a BLANK label, write that back, and the
    // first tab would write its own label back — forever. Reading the shared
    // mirror is what makes them converge (and what restores the signed-in name
    // across the hard navigation out of this remote).
    localStorage.setItem(LEGACY_KEY, JSON.stringify(makeSession({ id: 'x', label: 'from-other-tab', provider: 'password', roles: ['user'] })));
    const pending = svc.hydrate();
    sessionReads()[0].flush({ roles: ['mod'], registrationComplete: true });
    const s = await pending;
    expect(s?.label).toBe('from-other-tab');
    expect(s?.provider).toBe('password');
    expect(s?.id).toBe('x');
    // ...but NOT its roles or registration: those are the server's alone.
    expect(s?.roles).toEqual(['mod']);
    expect(s?.registrationComplete).toBeTrue();
  });

  it('hydrate() ignores a CORRUPT mirror rather than throwing', async () => {
    localStorage.setItem(LEGACY_KEY, '{not json');
    const pending = svc.hydrate();
    sessionReads()[0].flush({ roles: ['user'], registrationComplete: false });
    const s = await pending;
    expect(s?.roles).toEqual(['user']);
    expect(s?.label).toBe('');
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null').roles).toEqual(['user']);
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
    // The server ANSWERED "no session", so the fleet mirror goes too — that
    // removal is how a not-yet-migrated remote learns to drop its own session.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('hydrate() does NOT sign the fleet out when the request never reached the server', async () => {
    // status 0 = DNS failure / offline / connection refused. The session was
    // never disproved, and acting on it is destructive twice: it would remove
    // the mirror (signing the user out of every remote) and — because the
    // bootstrap read is memoised — strand them anonymous until a re-login.
    svc.set(makeSession({ roles: ['user', 'admin'] }));
    const bootstrap = svc.ensureHydrated();
    sessionReads()[0].error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' });
    expect(await bootstrap).not.toBeNull();
    expect(svc.loggedIn()).toBeTrue();
    expect(svc.isAdmin()).toBeTrue();
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null').roles).toEqual(['user', 'admin']);
    // ...and the memo is released, so the next entry into the remote retries.
    const retry = svc.ensureHydrated();
    expect(retry).not.toBe(bootstrap);
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    reads[0].flush({ roles: ['user', 'admin'], registrationComplete: true });
    expect((await retry)?.registrationComplete).toBeTrue();
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

  it("re-hydrates on a sibling tab's `storage` event for the hug.session mirror (a host-shell sign-out there)", async () => {
    // The host shell's clear() removes the mirror and posts on no channel, so
    // the `storage` event it raises in OTHER tabs is the only signal that
    // reaches this tab. Transport only: the removed/new value is never ADOPTED
    // — the cookie decides.
    svc.set(makeSession({ label: 'kept' }));
    window.dispatchEvent(new StorageEvent('storage', { key: LEGACY_KEY, oldValue: '{"stale":true}', newValue: null }));
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    expect(reads[0].request.withCredentials).toBeTrue();
    reads[0].flush(null, { status: 401, statusText: 'Unauthorized' });
    await until(() => svc.session() === null, 'the sign-out reaching this tab');
    // An unrelated key (the locale preference) is not a session signal.
    window.dispatchEvent(new StorageEvent('storage', { key: 'snap.login.lang', newValue: 'de' }));
    expect(sessionReads().length).toBe(0);
  });

  it('IGNORES a `storage` event whose value is exactly the session this tab already holds', async () => {
    // This service is a WRITER of the mirror now, so an event can be a sibling
    // login-ui tab merely re-confirming what is already true. Re-reading would
    // answer the same, write it back, and wake the other tab again: two open
    // tabs would hydrate each other forever. Nothing to learn => no read.
    svc.set(makeSession({ label: 'same', roles: ['user', 'mod'] }));
    const echo = localStorage.getItem(LEGACY_KEY);
    expect(echo).not.toBeNull();
    window.dispatchEvent(new StorageEvent('storage', { key: LEGACY_KEY, newValue: echo }));
    await sleep(20);
    expect(sessionReads().length).toBe(0);
    expect(svc.session()?.label).toBe('same');
    // A DIFFERENT value is still news (a not-yet-migrated shell wrote its own).
    window.dispatchEvent(new StorageEvent('storage', {
      key: LEGACY_KEY,
      newValue: JSON.stringify(makeSession({ label: 'shell-user', roles: ['user'] })),
    }));
    const reads = sessionReads();
    expect(reads.length).toBe(1);
    reads[0].flush({ roles: ['user', 'mod'], registrationComplete: false });
    await until(() => localStorage.getItem(LEGACY_KEY) !== echo, 'the re-read republishing the mirror');
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
    // The mirror goes even when the server call failed: the local sign-out must
    // reach the not-yet-migrated remotes regardless.
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });

  it('the fleet mirror tracks the whole sign-in → hydrate → sign-out lifecycle', async () => {
    // The end-to-end shape the fleet depends on: present with the login-time
    // guess, CORRECTED to the server roles, then GONE.
    svc.set(makeSession({ label: 'e2e-admin', provider: 'password', roles: ['user'] }));
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null').roles).toEqual(['user']);
    const h = svc.hydrate();
    sessionReads()[0].flush({ roles: ['admin', 'user'], registrationComplete: true });
    await h;
    const mirror = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    expect(mirror.roles).toEqual(['admin', 'user']);
    expect(mirror.label).toBe('e2e-admin');
    expect(mirror.registrationComplete).toBeTrue();
    const c = svc.clear();
    sessionOuts()[0].flush({});
    await c;
    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
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
      // Inbound: no transport reaches the dead instance any more.
      window.dispatchEvent(new Event(CHANNEL));
      window.dispatchEvent(new StorageEvent('storage', { key: LEGACY_KEY, newValue: null }));
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
    localStorage.clear();
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

  it('with the flag ON a bootstrap hydrate (no prior identity) tags provider=oidc; still no token anywhere', async () => {
    build(true);
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session')).flush({ roles: ['user', 'admin'], registrationComplete: true });
    const s = await pending;
    expect(s?.provider).toBe('oidc');
    expect((s as any)?.bffToken).toBeUndefined();
    const mirror = JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null');
    expect(mirror.provider).toBe('oidc');
    for (const key of Object.keys(mirror)) expect(/token|secret|cookie/i.test(key)).toBeFalse();
  });

  it('with the flag OFF the same hydrate falls back to the vestigial google tag; custody is identical', async () => {
    build(false);
    const pending = svc.hydrate();
    httpMock.expectOne((r) => r.url.endsWith('/bff/session')).flush({ roles: ['user'], registrationComplete: false });
    const s = await pending;
    expect(s?.provider).toBe('google');
    expect(JSON.parse(localStorage.getItem(LEGACY_KEY) ?? 'null').provider).toBe('google');
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
// The in-memory signal is this service's own source of the hydrated roles (the
// fleet mirror is an outbound transport for OTHER apps, never read back into
// the signal). The service mirrors the non-secret metadata onto this global so a
// black-box e2e can read the persona's roles back VERBATIM from the service
// under test (e2e/tests/helpers/roles.ts readSessionProbe(), via auth-steps.ts).
describe('SessionService (__HUG_SESSION__ probe)', () => {
  let svc: SessionService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
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
