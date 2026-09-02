import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, TestRequest, provideHttpClientTesting } from '@angular/common/http/testing';
import { BffService } from './bff.service';
import { SessionService } from './session.service';
import { LocalAgentService, LocalHandoff } from './local-agent.service';

/** Minimal fetch Response stub — still needed for the two COOKIE-MINT sign-in
 *  calls ({@code /bff/login}, {@code /bff/login/local}), the only ones the
 *  ng-openapi-gen migration left on plain `fetch` (see BffService.login for why).
 *  Every CREDENTIALED call now runs through {@link HttpTestingController}. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

const HTTP = [provideHttpClient(), provideHttpClientTesting()];

describe('BffService', () => {
  let service: BffService;
  let session: SessionService;
  let localAgent: LocalAgentService;
  let httpMock: HttpTestingController;
  let fetchSpy: jasmine.Spy;

  const HANDOFF: LocalHandoff = {
    roleId: 'brandowner',
    username: 'brandowner@acme.local',
    secret: 'local-secret',
    expiresAt: '2026-07-08T12:00:30Z',
  };

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [BffService, SessionService, ...HTTP],
    });
    service = TestBed.inject(BffService);
    session = TestBed.inject(SessionService);
    localAgent = TestBed.inject(LocalAgentService);
    httpMock = TestBed.inject(HttpTestingController);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => localStorage.clear());

  function lastInit(): RequestInit {
    return (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
  }
  function callTo(substr: string) {
    return fetchSpy.calls.all().find((c) => String(c.args[0]).includes(substr));
  }

  /** Wait for the next generated-client request matching `path`. The sign-in
   *  fetch resolves through a few microtask turns before the follow-on
   *  hydrate/provision calls are issued, so poll rather than assert immediately. */
  async function nextRequest(path: string): Promise<TestRequest> {
    for (let i = 0; i < 50; i++) {
      const [req] = httpMock.match((r) => r.url.includes(path));
      if (req) return req;
      await Promise.resolve();
    }
    throw new Error(`no request to ${path}`);
  }

  /** Answer the GET /bff/session that login()/loginLocal() hydrate from. */
  async function flushHydrate(registrationComplete: boolean): Promise<void> {
    (await nextRequest('/bff/session')).flush({ roles: ['user'], registrationComplete });
  }

  /** Answer both best-effort provisioning POSTs (they run in sequence). */
  async function flushProvisioning(): Promise<void> {
    (await nextRequest('/bff/provision/matrix')).flush({ access_token: 'mx-tok', user_id: '@a:hs' });
    (await nextRequest('/bff/provision/mastodon')).flush({ access_token: 'md-tok' });
  }

  it('login POSTs {username,password} to /bff/login and stores a session (no token in the body)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const p = service.login('alice', 's3cret');
    await flushHydrate(false);
    const r = await p;
    expect(r.ok).toBeTrue();
    expect(r.registrationComplete).toBeFalse();
    const call = callTo('/bff/login')!;
    expect(call.args[1]!.method).toBe('POST');
    expect(call.args[1]!.credentials).toBe('include');
    // Cookie-mint endpoint → NO CSRF header.
    expect((call.args[1]!.headers as Record<string, string>)['X-CSRF-TOKEN']).toBeUndefined();
    expect(JSON.parse(String(call.args[1]!.body))).toEqual({ username: 'alice', password: 's3cret' });
    const s = session.session();
    expect(s?.label).toBe('alice');
    expect(s?.provider).toBe('password');
    // The session token lives ONLY in the httpOnly bff_ cookie, never in the body/session.
    expect((s as any)?.bffToken).toBeUndefined();
    expect((s as any)?.token).toBeUndefined();
  });

  it('does NOT provision service tokens on login when registration is incomplete', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const p = service.login('alice', 's3cret');
    await flushHydrate(false);
    const r = await p;
    expect(r.ok).toBeTrue();
    httpMock.expectNone((req) => req.url.includes('/bff/provision/matrix'));
  });

  it('TRIGGERS server-side provisioning on login when already fully registered, but stores NO token in the session', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
    const p = service.login('alice', 's3cret');
    // The server confirms the account IS fully registered, which is what unlocks
    // provisioning (hydrate() is authoritative over login()'s roles guess).
    await flushHydrate(true);
    // The two POSTs run in sequence, so matrix must settle before mastodon exists.
    const mx = await nextRequest('/bff/provision/matrix');
    expect(mx.request.method).toBe('POST');
    expect(mx.request.withCredentials).toBeTrue();
    expect(mx.request.headers.has('Authorization')).toBeFalse();
    // The provision endpoints still return an access_token; the browser MUST ignore it.
    mx.flush({ access_token: 'mx-tok', user_id: '@a:hs' });
    const md = await nextRequest('/bff/provision/mastodon');
    expect(md.request.method).toBe('POST');
    expect(md.request.withCredentials).toBeTrue();
    md.flush({ access_token: 'md-tok' });
    await p;
    // The homeserver tokens are NEVER held in the browser/session.
    expect((session.session() as any)?.matrix).toBeUndefined();
    expect((session.session() as any)?.mastodon).toBeUndefined();
  });

  it('returns mfaRequired (with the offered factor types) and mints NO session', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ mfaRequired: true, mfaType: ['totp'] }));
    const r = await service.login('alice', 's3cret');
    expect(r.ok).toBeFalse();
    expect(r.mfaRequired).toBeTrue();
    expect(r.mfaType).toEqual(['totp']);
    // No cookie, no session minted on an MFA challenge.
    expect(session.session()).toBeNull();
  });

  it('includes mfaPasscode + mfaType on a passcode re-POST', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
    const p = service.login('alice', 's3cret', { passcode: '123456', mfaType: 'totp' });
    await flushHydrate(true);
    await flushProvisioning();
    await p;
    const call = callTo('/bff/login')!;
    expect(JSON.parse(String(call.args[1]!.body))).toEqual({
      username: 'alice', password: 's3cret', mfaPasscode: '123456', mfaType: 'totp',
    });
  });

  it('maps a 401 to an invalid_credentials error and stores no session', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'invalid_credentials', message: 'bad password' }, { ok: false, status: 401 }));
    const r = await service.login('alice', 'nope');
    expect(r.ok).toBeFalse();
    expect(r.error).toBe('invalid_credentials');
    expect(r.mfaRequired).toBeFalsy();
    expect(session.session()).toBeNull();
  });

  it('maps a 503 to a dark (SSO-unavailable) result and stores no session', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 503 }));
    const r = await service.login('alice', 's3cret');
    expect(r.ok).toBeFalse();
    expect(r.dark).toBeTrue();
    expect(session.session()).toBeNull();
  });

  it('classifies a blocked account (account_banned + reason) as {blocked, reason} and stores no session', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'account_banned', reason: 'Repeated spam reports' }, { ok: false, status: 423 }));
    const r = await service.login('bob', 's3cret');
    expect(r.ok).toBeFalse();
    expect(r.blocked).toBeTrue();
    expect(r.error).toBe('account_banned');
    expect(r.reason).toBe('Repeated spam reports');
    // No session is minted for a blocked account.
    expect(session.session()).toBeNull();
  });

  it('classifies account_suspended the same way (a suspended account also routes to appeal)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'account_suspended', reason: 'Under review' }, { ok: false, status: 401 }));
    const r = await service.login('bob', 's3cret');
    expect(r.blocked).toBeTrue();
    expect(r.error).toBe('account_suspended');
    expect(r.reason).toBe('Under review');
  });

  it('does NOT flag a plain invalid_credentials as blocked (that failure stays on the login form)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'invalid_credentials' }, { ok: false, status: 401 }));
    const r = await service.login('bob', 'nope');
    expect(r.blocked).toBeFalsy();
    expect(r.error).toBe('invalid_credentials');
  });

  // ── loginLocal (POST /bff/login/local via the loopback agent handoff) ────────

  it('loginLocal fetches a single-use handoff then POSTs {roleId,username,secret} to /bff/login/local with credentials', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
    const p = service.loginLocal('brandowner');
    await flushHydrate(true);
    await flushProvisioning();
    const r = await p;
    expect(r.ok).toBeTrue();
    expect(localAgent.handoff).toHaveBeenCalledWith('brandowner');
    const call = callTo('/bff/login/local')!;
    expect(call.args[1]!.method).toBe('POST');
    expect(call.args[1]!.credentials).toBe('include');
    expect(JSON.parse(String(call.args[1]!.body))).toEqual({
      roleId: 'brandowner',
      username: 'brandowner@acme.local',
      secret: 'local-secret',
    });
    // The session reflects the username; the secret is NEVER stored.
    const s = session.session();
    expect(s?.label).toBe('brandowner@acme.local');
    expect(s?.provider).toBe('password');
    expect(JSON.stringify(s)).not.toContain('local-secret');
  });

  it('loginLocal returns {ok:false,error:"handoff"} and never calls the BFF when the agent has no credential', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(null);
    const r = await service.loginLocal('brandowner');
    expect(r).toEqual({ ok: false, error: 'handoff' });
    expect(callTo('/bff/login/local')).toBeUndefined();
    expect(session.session()).toBeNull();
  });

  it('loginLocal maps a 401 to a failed sign-in and stores no session (identical to a bad password)', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ error: 'invalid_credentials' }, { ok: false, status: 401 }));
    const r = await service.loginLocal('brandowner');
    expect(r.ok).toBeFalse();
    expect(r.error).toBe('invalid_credentials');
    expect(session.session()).toBeNull();
  });

  it('loginLocal classifies a blocked account as {blocked, reason} (routes to appeal, not a bad-secret failure)', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ error: 'account_banned', reason: 'Repeated spam reports' }, { ok: false, status: 423 }));
    const r = await service.loginLocal('brandowner');
    expect(r.blocked).toBeTrue();
    expect(r.error).toBe('account_banned');
    expect(r.reason).toBe('Repeated spam reports');
    expect(session.session()).toBeNull();
  });

  it('loginLocal maps a 503 to a dark result', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 503 }));
    const r = await service.loginLocal('brandowner');
    expect(r.dark).toBeTrue();
    expect(session.session()).toBeNull();
  });

  it('loginLocal passes an mfaRequired challenge back and mints no session', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ mfaRequired: true, mfaType: ['totp'] }));
    const r = await service.loginLocal('brandowner');
    expect(r.mfaRequired).toBeTrue();
    expect(r.mfaType).toEqual(['totp']);
    expect(session.session()).toBeNull();
  });

  it('loginLocal TRIGGERS server-side provisioning when already fully registered, storing NO token', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
    const p = service.loginLocal('brandowner');
    await flushHydrate(true);
    await flushProvisioning();
    await p;
    expect((session.session() as any)?.matrix).toBeUndefined();
  });

  it('loginLocal does NOT provision service tokens when registration is incomplete', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const p = service.loginLocal('brandowner');
    await flushHydrate(false);
    const r = await p;
    expect(r.ok).toBeTrue();
    httpMock.expectNone((req) => req.url.includes('/bff/provision/matrix'));
  });

  it('completeRegistration TRIGGERS server-side provisioning BEFORE flipping registrationComplete, storing NO token', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    let flippedWhileProvisioning = false;
    const p = service.completeRegistration();
    (await nextRequest('/bff/register/complete')).flush({});
    // The registration gate must NOT be open until provisioning has run.
    const mx = await nextRequest('/bff/provision/matrix');
    flippedWhileProvisioning = flippedWhileProvisioning || session.session()!.registrationComplete;
    mx.flush({ access_token: 'mx', user_id: '@a:hs' });
    const md = await nextRequest('/bff/provision/mastodon');
    flippedWhileProvisioning = flippedWhileProvisioning || session.session()!.registrationComplete;
    md.flush({ access_token: 'md' });
    await p;
    expect(flippedWhileProvisioning).toBeFalse();
    expect(session.session()?.registrationComplete).toBeTrue();
    // NO homeserver token reaches the session.
    expect((session.session() as any)?.matrix).toBeUndefined();
    expect((session.session() as any)?.mastodon).toBeUndefined();
  });

  it('completeRegistration sends credentials (bff_ cookie) and NO bearer to the complete endpoint', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    const p = service.completeRegistration();
    const complete = await nextRequest('/bff/register/complete');
    expect(complete.request.method).toBe('POST');
    expect(complete.request.withCredentials).toBeTrue();
    expect(complete.request.headers.has('Authorization')).toBeFalse();
    complete.flush({});
    await flushProvisioning();
    await p;
  });

  it('completeRegistration forwards displayName + screenReaderName in the complete body', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    const p = service.completeRegistration({ displayName: '山田太郎', screenReaderName: 'Yamada Taro' });
    const complete = await nextRequest('/bff/register/complete');
    expect(complete.request.body).toEqual({
      displayName: '山田太郎',
      screenReaderName: 'Yamada Taro',
    });
    complete.flush({});
    await flushProvisioning();
    await p;
  });

  it('completeRegistration still provisions and flips the gate when the complete call is refused', async () => {
    // `fetch` resolved for a non-OK response and the result was ignored; the
    // generated client errors instead, so the swallow must keep the flow intact.
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    const p = service.completeRegistration();
    (await nextRequest('/bff/register/complete'))
      .flush({ error: 'nope' }, { status: 500, statusText: 'Server Error' });
    await flushProvisioning();
    await p;
    expect(session.session()?.registrationComplete).toBeTrue();
  });

  // ── submitAppeal (POST /bff/me/appeal) ──────────────────────────────────────

  it('submitAppeal POSTs the reason + contactEmail with credentials, and returns the recorded appeal', async () => {
    const p = service.submitAppeal('let me back in', 'alt@example.com');
    const req = await nextRequest('/bff/me/appeal');
    expect(req.request.method).toBe('POST');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.body).toEqual({ reason: 'let me back in', contactEmail: 'alt@example.com' });
    req.flush({ id: 'ap1', status: 'PENDING' }, { status: 201, statusText: 'Created' });
    expect(await p).toEqual({ ok: true, status: 'PENDING', id: 'ap1' });
  });

  it('submitAppeal maps a 401 (no session) to error:"unauthenticated" — never a fake success', async () => {
    const p = service.submitAppeal('reason', null);
    (await nextRequest('/bff/me/appeal')).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(await p).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('submitAppeal maps a 422 to error:"invalid"', async () => {
    const p = service.submitAppeal('', null);
    (await nextRequest('/bff/me/appeal')).flush({}, { status: 422, statusText: 'Unprocessable Entity' });
    expect(await p).toEqual({ ok: false, error: 'invalid' });
  });

  it('submitAppeal maps a 500 to error:"server"', async () => {
    const p = service.submitAppeal('reason', null);
    (await nextRequest('/bff/me/appeal')).flush({}, { status: 500, statusText: 'Server Error' });
    expect(await p).toEqual({ ok: false, error: 'server' });
  });

  it('submitAppeal maps a transport failure (network down) to error:"network" — never throws', async () => {
    const p = service.submitAppeal('reason', null);
    (await nextRequest('/bff/me/appeal')).error(new ProgressEvent('network'));
    expect(await p).toEqual({ ok: false, error: 'network' });
  });

  // ══════════════════════════════════════════════════════════════════════════
  // FORGOT PASSWORD — the anonymous reset legs (user-bff, plain fetch like the
  // sign-in calls, because the committed contract under src/app/api is admin-bff's).
  // ══════════════════════════════════════════════════════════════════════════

  it('requestPasswordReset POSTs the username to /bff/password-reset/request', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ op: 'password-reset-request', status: 'accepted' },
      { ok: true, status: 202 }));

    const result = await service.requestPasswordReset('alice');

    expect(result.ok).toBe(true);
    const call = callTo('/bff/password-reset/request');
    expect(call).toBeTruthy();
    expect(JSON.parse(String(lastInit().body))).toEqual({ username: 'alice' });
  });

  /** The caller is anonymous BY CONSTRUCTION. Attaching a stale bff_ cookie would make a
   *  recovery flow depend on the very session the user has lost. */
  it('requestPasswordReset maps 503 to dark (this mesh has no reset at all)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 503 }));
    const result = await service.requestPasswordReset('alice');
    expect(result).toEqual(jasmine.objectContaining({ ok: false, dark: true }));
  });

  it('requestPasswordReset maps a transport failure to network, never to ok', async () => {
    fetchSpy.and.rejectWith(new TypeError('Failed to fetch'));
    const result = await service.requestPasswordReset('alice');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('network');
    expect(result.dark).toBeUndefined();
  });

  it('requestPasswordReset maps 400 to invalid and 500 to server', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ error: 'validation failed' }, { ok: false, status: 400 }));
    expect((await service.requestPasswordReset('')).error).toBe('invalid');

    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 500 }));
    expect((await service.requestPasswordReset('alice')).error).toBe('server');
  });

  it('confirmPasswordReset POSTs username, code and newPassword', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ op: 'password-reset-confirm', status: 'reset' }));

    const result = await service.confirmPasswordReset('alice', '123456', 's3cret-enough');

    expect(result.ok).toBe(true);
    expect(callTo('/bff/password-reset/confirm')).toBeTruthy();
    expect(JSON.parse(String(lastInit().body)))
      .toEqual({ username: 'alice', code: '123456', newPassword: 's3cret-enough' });
  });

  /** A refused reset must NEVER read as ok — the user would go on to sign in with a
   *  password that was never set. This is the sibling of the server-side guard that stops
   *  a Casdoor refusal becoming a success acknowledgement. */
  it('confirmPasswordReset reports ok:false for a refused reset, carrying the reason', async () => {
    fetchSpy.and.resolveTo(jsonResponse(
      { error: 'we could not complete that reset — the code may have expired' },
      { ok: false, status: 400 }));

    const result = await service.confirmPasswordReset('alice', '000000', 's3cret-enough');

    expect(result.ok).toBe(false);
    expect(result.error).toBe('invalid');
    expect(result.message).toContain('the code may have expired');
  });

  it('confirmPasswordReset maps 503 to dark', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 503 }));
    const result = await service.confirmPasswordReset('alice', '123456', 's3cret-enough');
    expect(result).toEqual(jasmine.objectContaining({ ok: false, dark: true }));
  });

  it('confirmPasswordReset never throws on a transport failure', async () => {
    fetchSpy.and.rejectWith(new TypeError('Failed to fetch'));
    const result = await service.confirmPasswordReset('alice', '123456', 's3cret-enough');
    expect(result).toEqual({ ok: false, error: 'network' });
  });

  it('confirmPasswordReset sends no credentials either', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}));
    await service.confirmPasswordReset('alice', '123456', 's3cret-enough');
    expect(lastInit().credentials).toBeUndefined();
  });

  /** The result type carries no per-account field at all — a UI cannot leak what it is
   *  never given, and this pins that the shape stays that way. */
  it('neither leg returns any per-account information', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: true, status: 202 }));
    const requested = await service.requestPasswordReset('alice');
    expect(Object.keys(requested).sort()).toEqual(['ok']);
  });
});

// ── httpOnly-cookie custody: no Bearer, credentials + CSRF on mutations ──────
// The ONLY session model since login-ui #3 — there is no flag to flip any more,
// so these run against the service exactly as it ships.
describe('BffService (cookie custody: credentials + CSRF on mutations)', () => {
  let service: BffService;
  let httpMock: HttpTestingController;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [BffService, SessionService, ...HTTP] });
    service = TestBed.inject(BffService);
    TestBed.inject(SessionService);
    httpMock = TestBed.inject(HttpTestingController);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  async function nextRequest(path: string): Promise<TestRequest> {
    for (let i = 0; i < 50; i++) {
      const [req] = httpMock.match((r) => r.url.includes(path));
      if (req) return req;
      await Promise.resolve();
    }
    throw new Error(`no request to ${path}`);
  }

  it('login sends credentials: include and NO Authorization header', async () => {
    // /bff/login is the cookie-MINT call and stays on `fetch`; in cookie mode it
    // also hydrates from GET /bff/session, which now rides the generated client.
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const p = service.login('alice', 's3cret');
    (await nextRequest('/bff/session')).flush({ roles: ['user'], registrationComplete: false });
    await p;
    const call = fetchSpy.calls.all().find((c) => String(c.args[0]).includes('/bff/login'))!;
    const init = (call.args[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('include');
    expect((init.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('a cookie-mint-adjacent call (completeRegistration) sends credentials but no Authorization and no CSRF header', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    const p = service.completeRegistration();
    const complete = await nextRequest('/bff/register/complete');
    expect(complete.request.withCredentials).toBeTrue();
    expect(complete.request.headers.has('Authorization')).toBeFalse();
    // /bff/register/** is CSRF-exempt (authHeaders(mutating=false))
    expect(complete.request.headers.has('X-CSRF-TOKEN')).toBeFalse();
    complete.flush({});
    // No session, so provisioning is skipped entirely.
    await p;
  });

  it('a mutating call (submitAppeal) echoes the X-CSRF-TOKEN from the XSRF-TOKEN cookie, no Bearer', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    const p = service.submitAppeal('reason', null);
    const req = await nextRequest('/bff/me/appeal');
    expect(req.request.withCredentials).toBeTrue();
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(req.request.headers.get('X-CSRF-TOKEN')).toBe('tok-123');
    req.flush({ id: 'ap1', status: 'PENDING' }, { status: 201, statusText: 'Created' });
    await p;
  });

  it('the provisioning POSTs echo the X-CSRF-TOKEN (mutating, non-mint)', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    const session = TestBed.inject(SessionService);
    session.set({ id: 'u1', label: 'a', provider: 'password', roles: ['user'], registrationComplete: false });
    const p = service.completeRegistration();
    (await nextRequest('/bff/register/complete')).flush({});
    const mx = await nextRequest('/bff/provision/matrix');
    expect(mx.request.headers.get('X-CSRF-TOKEN')).toBe('tok-123');
    mx.flush({});
    const md = await nextRequest('/bff/provision/mastodon');
    expect(md.request.headers.get('X-CSRF-TOKEN')).toBe('tok-123');
    md.flush({});
    await p;
  });


  /** The recovery legs are anonymous BY CONSTRUCTION. Even in cookie mode — where every
   *  other mutating call carries credentials and a CSRF header — these must not, or a
   *  flow for a user who has LOST their session would depend on holding one. */
  it('the password-reset legs send no credentials and no CSRF header even in cookie mode', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: true, status: 202 }));

    await service.requestPasswordReset('alice');

    const init = (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
    expect(String(fetchSpy.calls.mostRecent().args[0])).toContain('/bff/password-reset/request');
    expect(init.credentials).toBeUndefined();
    expect((init.headers as Record<string, string>)['X-CSRF-TOKEN']).toBeUndefined();
  });

});
