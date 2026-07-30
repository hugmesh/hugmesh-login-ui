import { TestBed } from '@angular/core/testing';
import { BffService } from './bff.service';
import { SessionService } from './session.service';
import { LocalAgentService, LocalHandoff } from './local-agent.service';

/** Minimal fetch Response stub. */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

describe('BffService', () => {
  let service: BffService;
  let session: SessionService;
  let localAgent: LocalAgentService;
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
      providers: [BffService, SessionService],
    });
    service = TestBed.inject(BffService);
    session = TestBed.inject(SessionService);
    localAgent = TestBed.inject(LocalAgentService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => localStorage.clear());

  function lastUrl(): string {
    return String(fetchSpy.calls.mostRecent().args[0]);
  }
  function lastInit(): RequestInit {
    return (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
  }
  function callTo(substr: string) {
    return fetchSpy.calls.all().find((c) => String(c.args[0]).includes(substr));
  }

  it('login POSTs {username,password} to /bff/login and stores a session (no token in the body)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const r = await service.login('alice', 's3cret');
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
    const r = await service.login('alice', 's3cret');
    expect(r.ok).toBeTrue();
    expect(callTo('/bff/provision/matrix')).toBeUndefined();
  });

  it('TRIGGERS server-side provisioning on login when already fully registered, but stores NO token in the session', async () => {
    fetchSpy.and.callFake((url: string) => {
      if (String(url).includes('/bff/login')) return Promise.resolve(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
      // The provision endpoints still return an access_token; the browser MUST ignore it.
      if (String(url).includes('/provision/matrix')) return Promise.resolve(jsonResponse({ access_token: 'mx-tok', user_id: '@a:hs' }));
      if (String(url).includes('/provision/mastodon')) return Promise.resolve(jsonResponse({ access_token: 'md-tok' }));
      return Promise.resolve(jsonResponse({}));
    });
    await service.login('alice', 's3cret');
    // Both provision POSTs fire with credentials (the bff_ cookie), no Bearer.
    const mx = callTo('/bff/provision/matrix')!;
    const md = callTo('/bff/provision/mastodon')!;
    expect(mx.args[1]!.method).toBe('POST');
    expect(mx.args[1]!.credentials).toBe('include');
    expect((mx.args[1]!.headers as Record<string, string>)['authorization']).toBeUndefined();
    expect(md.args[1]!.method).toBe('POST');
    expect(md.args[1]!.credentials).toBe('include');
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
    await service.login('alice', 's3cret', { passcode: '123456', mfaType: 'totp' });
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
    const r = await service.loginLocal('brandowner');
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
    fetchSpy.and.callFake((url: string) => {
      if (String(url).includes('/bff/login/local')) return Promise.resolve(jsonResponse({ registrationComplete: true, status: 'active', mfaRequired: false }));
      if (String(url).includes('/provision/matrix')) return Promise.resolve(jsonResponse({ access_token: 'mx-tok' }));
      if (String(url).includes('/provision/mastodon')) return Promise.resolve(jsonResponse({ access_token: 'md-tok' }));
      return Promise.resolve(jsonResponse({}));
    });
    await service.loginLocal('brandowner');
    expect(callTo('/bff/provision/matrix')).toBeDefined();
    expect(callTo('/bff/provision/mastodon')).toBeDefined();
    expect((session.session() as any)?.matrix).toBeUndefined();
  });

  it('loginLocal does NOT provision service tokens when registration is incomplete', async () => {
    spyOn(localAgent, 'handoff').and.resolveTo(HANDOFF);
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    const r = await service.loginLocal('brandowner');
    expect(r.ok).toBeTrue();
    expect(callTo('/bff/provision/matrix')).toBeUndefined();
  });

  it('completeRegistration TRIGGERS server-side provisioning BEFORE flipping registrationComplete, storing NO token', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    let flippedWhileProvisioning = false;
    fetchSpy.and.callFake((url: string) => {
      if (String(url).includes('/provision/')) {
        // The registration gate must NOT be open until provisioning has run.
        flippedWhileProvisioning = flippedWhileProvisioning || session.session()!.registrationComplete;
        const tok = String(url).includes('matrix') ? { access_token: 'mx', user_id: '@a:hs' } : { access_token: 'md' };
        return Promise.resolve(jsonResponse(tok));
      }
      return Promise.resolve(jsonResponse({}));
    });
    await service.completeRegistration();
    expect(flippedWhileProvisioning).toBeFalse();
    expect(session.session()?.registrationComplete).toBeTrue();
    // Both services were provisioned server-side; NO homeserver token reaches the session.
    expect(callTo('/bff/provision/matrix')).toBeDefined();
    expect(callTo('/bff/provision/mastodon')).toBeDefined();
    expect((session.session() as any)?.matrix).toBeUndefined();
    expect((session.session() as any)?.mastodon).toBeUndefined();
  });

  it('completeRegistration sends credentials (bff_ cookie) and NO bearer to the complete endpoint', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    fetchSpy.and.resolveTo(jsonResponse({ access_token: 'x' }));
    await service.completeRegistration();
    const complete = callTo('/bff/register/complete')!;
    expect(complete.args[1]!.credentials).toBe('include');
    expect((complete.args[1]!.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('completeRegistration forwards displayName + screenReaderName in the complete body', async () => {
    session.set({
      id: 'u1', label: 'a', provider: 'google', roles: ['user'],
      registrationComplete: false,
    });
    fetchSpy.and.resolveTo(jsonResponse({ access_token: 'x' }));
    await service.completeRegistration({ displayName: '山田太郎', screenReaderName: 'Yamada Taro' });
    const complete = callTo('/bff/register/complete')!;
    expect(JSON.parse(String(complete.args[1]!.body))).toEqual({
      displayName: '山田太郎',
      screenReaderName: 'Yamada Taro',
    });
  });

  // ── submitAppeal (POST /bff/me/appeal) ──────────────────────────────────────

  it('submitAppeal POSTs the reason + contactEmail with credentials, and returns the recorded appeal', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ id: 'ap1', status: 'PENDING' }));
    const result = await service.submitAppeal('let me back in', 'alt@example.com');

    expect(lastUrl()).toContain('/bff/me/appeal');
    expect(lastInit().method).toBe('POST');
    expect(lastInit().credentials).toBe('include');
    expect(JSON.parse(String(lastInit().body))).toEqual({ reason: 'let me back in', contactEmail: 'alt@example.com' });
    expect(result).toEqual({ ok: true, status: 'PENDING', id: 'ap1' });
  });

  it('submitAppeal maps a 401 (no session) to error:"unauthenticated" — never a fake success', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 401 }));
    const result = await service.submitAppeal('reason', null);
    expect(result).toEqual({ ok: false, error: 'unauthenticated' });
  });

  it('submitAppeal maps a 422 to error:"invalid"', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 422 }));
    const result = await service.submitAppeal('', null);
    expect(result).toEqual({ ok: false, error: 'invalid' });
  });

  it('submitAppeal maps a 500 to error:"server"', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 500 }));
    const result = await service.submitAppeal('reason', null);
    expect(result).toEqual({ ok: false, error: 'server' });
  });

  it('submitAppeal maps a thrown fetch (network down) to error:"network" — never throws', async () => {
    fetchSpy.and.rejectWith(new Error('offline'));
    const result = await service.submitAppeal('reason', null);
    expect(result).toEqual({ ok: false, error: 'network' });
  });
});

// ── D6 cookie mode: Bearer dropped, credentials + CSRF on mutations ──────────
describe('BffService (cookie mode)', () => {
  let service: BffService;
  let session: SessionService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    localStorage.clear();
    (globalThis as any).__HUG_SESSION_COOKIE_MODE__ = true;
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ providers: [BffService, SessionService] });
    service = TestBed.inject(BffService);
    session = TestBed.inject(SessionService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    delete (globalThis as any).__HUG_SESSION_COOKIE_MODE__;
    localStorage.clear();
  });

  function lastInit(): RequestInit {
    return (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
  }
  function headersOf(init: RequestInit): Record<string, string> {
    return (init.headers ?? {}) as Record<string, string>;
  }

  it('login sends credentials: include and NO Authorization header', async () => {
    // In cookie mode login also hydrates from GET /bff/session; both round-trips
    // must ride the cookie with no bearer. Assert on the /bff/login POST itself.
    fetchSpy.and.resolveTo(jsonResponse({ registrationComplete: false, status: 'active', mfaRequired: false }));
    await service.login('alice', 's3cret');
    const call = fetchSpy.calls.all().find((c) => String(c.args[0]).includes('/bff/login'))!;
    const init = (call.args[1] ?? {}) as RequestInit;
    expect(init.credentials).toBe('include');
    expect(headersOf(init)['authorization']).toBeUndefined();
  });

  it('a cookie-mint-adjacent call (completeRegistration) sends credentials but no Authorization and no CSRF header', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    fetchSpy.and.resolveTo(jsonResponse({}));
    await service.completeRegistration();
    const init = lastInit();
    expect(init.credentials).toBe('include');
    const h = headersOf(init);
    expect(h['authorization']).toBeUndefined();
    expect(h['X-CSRF-TOKEN']).toBeUndefined(); // /bff/register/** is CSRF-exempt (authHeaders(mutating=false))
  });

  it('a mutating call (submitAppeal) echoes the X-CSRF-TOKEN from the XSRF-TOKEN cookie, no Bearer', async () => {
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
    fetchSpy.and.resolveTo(jsonResponse({ id: 'ap1', status: 'PENDING' }));
    await service.submitAppeal('reason', null);
    const init = lastInit();
    expect(init.credentials).toBe('include');
    const h = headersOf(init);
    expect(h['authorization']).toBeUndefined();
    expect(h['X-CSRF-TOKEN']).toBe('tok-123');
  });
});
