import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { MfaService } from './mfa.service';
import { SessionService, SnapSession } from './session.service';

const SESSION: SnapSession = {
  id: 'google:alice@gmail.com',
  label: 'alice@gmail.com',
  provider: 'google',
  roles: ['user'],
  registrationComplete: true,
};

/**
 * After the ng-openapi-gen migration this service delegates to the generated
 * MfaEnrollment/MfaChallenge controller clients (Angular {@code HttpClient}), so
 * the suite drives the BFF through {@link HttpTestingController} instead of a
 * {@code fetch} spy (mirrors appeal-contact.service.spec). The contract is
 * unchanged: same paths/methods/bodies, the cookie is attached via
 * {@code withCredentials} (the generated transport's credentialed opt-in) in
 * place of {@code credentials: 'include'}, never a Bearer, and a 503 is DARK.
 */
describe('MfaService', () => {
  let service: MfaService;
  let session: SessionService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [MfaService, SessionService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(MfaService);
    session = TestBed.inject(SessionService);
    session.set(SESSION);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => localStorage.clear());

  /** The single outstanding /bff/mfa/* request. */
  function expectCall(path: string) {
    return httpMock.expectOne((r) => r.url.includes(path));
  }

  it('enrollTotp POSTs the enroll path and returns the display-once secret', async () => {
    const p = service.enrollTotp();
    const req = expectCall('/bff/mfa/enroll/totp');
    expect(req.request.method).toBe('POST');
    req.flush({ factorId: 'f1', otpauthUri: 'otpauth://totp/x', secret: 'BASE32SECRET' });
    const r = await p;
    expect(r.ok).toBeTrue();
    expect(r.data?.secret).toBe('BASE32SECRET');
  });

  it('authenticates via the bff_ cookie: sends withCredentials and NO Bearer header', async () => {
    const p = service.factors();
    const req = expectCall('/bff/mfa/factors');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ factors: [] });
    await p;
  });

  it('NEVER puts the subject/owner in the request body (owner == authenticated session)', async () => {
    const start = service.enrollTotp();
    // enroll/totp takes no body at all.
    expectCall('/bff/mfa/enroll/totp').flush({ factorId: 'f1', otpauthUri: 'x', secret: 's' });
    await start;

    const verify = service.verifyTotp('123456');
    const req = expectCall('/bff/mfa/enroll/totp/verify');
    const body = req.request.body as Record<string, unknown>;
    expect(body).toEqual({ passcode: '123456' });
    expect(body['subject']).toBeUndefined();
    expect(body['owner']).toBeUndefined();
    expect(body['id']).toBeUndefined();
    req.flush({ enabled: true, recoveryCodes: [] });
    await verify;
  });

  it('maps a 503 from ANY /bff/mfa/* call to a DARK result (not an error)', async () => {
    const p = service.factors();
    expectCall('/bff/mfa/factors').flush({ error: 'ships dark' },
      { status: 503, statusText: 'Service Unavailable' });
    const r = await p;
    expect(r.dark).toBeTrue();
    expect(r.ok).toBeFalse();
    expect(r.error).toBeUndefined();
  });

  it('verifyTotp surfaces a 401 as a non-dark failure with the status', async () => {
    const p = service.verifyTotp('000000');
    expectCall('/bff/mfa/enroll/totp/verify').flush({ error: 'bad code' },
      { status: 401, statusText: 'Unauthorized' });
    const r = await p;
    expect(r.dark).toBeFalse();
    expect(r.status).toBe(401);
    expect(r.ok).toBeFalse();
    expect(r.error).toBe('bad code');
  });

  it('verifyWebauthn POSTs the attestation as a JSON string field', async () => {
    const p = service.verifyWebauthn('{"id":"abc"}');
    const req = expectCall('/bff/mfa/enroll/webauthn/verify');
    expect(req.request.body).toEqual({ attestation: '{"id":"abc"}' });
    req.flush({ factorId: 'w1', enabled: true });
    await p;
  });

  it('assertWebauthnOptions POSTs the assert-options path with no body', async () => {
    const p = service.assertWebauthnOptions();
    const req = expectCall('/bff/mfa/assert/webauthn/options');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toBeNull();
    req.flush({ challenge: 'c', rpId: 'r', rpName: 'n' });
    await p;
  });

  it('factors() GETs the list path (no secrets relied on by the client)', async () => {
    const p = service.factors();
    const req = expectCall('/bff/mfa/factors');
    expect(req.request.method).toBe('GET');
    req.flush({ factors: [{ id: 'f1', type: 'TOTP', enabled: true, createdAt: '2026-01-01T00:00:00Z' }] });
    const r = await p;
    expect(r.data?.factors[0].id).toBe('f1');
  });

  it('removeFactor DELETEs the per-factor path (URL-encoded id)', async () => {
    const p = service.removeFactor('a/b');
    const req = expectCall('/bff/mfa/factors/');
    expect(req.request.method).toBe('DELETE');
    expect(req.request.url).toContain('/bff/mfa/factors/a%2Fb');
    req.flush({ removed: true });
    await p;
  });

  it('removeFactor surfaces a 403 (needs fresh step-up) as a non-dark failure', async () => {
    const p = service.removeFactor('f1');
    expectCall('/bff/mfa/factors/').flush({ error: 'requires a fresh MFA step-up' },
      { status: 403, statusText: 'Forbidden' });
    const r = await p;
    expect(r.status).toBe(403);
    expect(r.dark).toBeFalse();
  });

  it('challenge POSTs factor + credential to the existing challenge endpoint', async () => {
    const p = service.challenge('totp', '123456');
    const req = expectCall('/bff/mfa/challenge');
    expect(req.request.body).toEqual({ factor: 'totp', credential: '123456' });
    req.flush({ mfaSatisfied: true });
    const r = await p;
    expect(r.data?.mfaSatisfied).toBeTrue();
  });

  it('degrades a network failure to a non-dark error result (never throws)', async () => {
    const p = service.factors();
    expectCall('/bff/mfa/factors').error(new ProgressEvent('network'));
    const r = await p;
    expect(r.ok).toBeFalse();
    expect(r.dark).toBeFalse();
    expect(r.status).toBe(0);
    expect(r.error).toBe('Network error');
  });

  it('omits the Authorization header when there is no session (cookie-only path still works)', async () => {
    // clear() AWAITS POST /bff/sessionOut before dropping local state (the
    // sign-out order contract); answer it so the local sign-out lands, then the
    // assertion below reads the /bff/mfa/factors request under test.
    const signedOut = session.clear();
    httpMock.expectOne((r) => r.url.includes('/bff/sessionOut')).flush({});
    await signedOut;

    const p = service.factors();
    const req = expectCall('/bff/mfa/factors');
    expect(req.request.headers.has('Authorization')).toBeFalse();
    // Cookie is still attached for the dual-read.
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ factors: [] });
    await p;
  });
});

// ── the double-submit CSRF header on MUTATING calls only ─────────────────────
// Cookie custody is the ONLY session model since login-ui #3 (no flag to flip),
// so this is simply how the service ships: the header rides whenever the
// JS-readable XSRF-TOKEN cookie exists and the call mutates.
describe('MfaService (CSRF double-submit on mutations)', () => {
  let service: MfaService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [MfaService, SessionService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(MfaService);
    httpMock = TestBed.inject(HttpTestingController);
    spyOnProperty(document, 'cookie', 'get').and.returnValue('XSRF-TOKEN=tok-123');
  });

  it('echoes X-CSRF-TOKEN on a mutating call (these are NOT cookie-mint endpoints)', async () => {
    const p = service.challenge('totp', '123456');
    const req = httpMock.expectOne((r) => r.url.includes('/bff/mfa/challenge'));
    expect(req.request.headers.get('X-CSRF-TOKEN')).toBe('tok-123');
    expect(req.request.withCredentials).toBeTrue();
    req.flush({ mfaSatisfied: true });
    await p;
  });

  it('does NOT send X-CSRF-TOKEN on the GET (non-mutating, require-matcher exempt)', async () => {
    const p = service.factors();
    const req = httpMock.expectOne((r) => r.url.includes('/bff/mfa/factors'));
    expect(req.request.headers.has('X-CSRF-TOKEN')).toBeFalse();
    req.flush({ factors: [] });
    await p;
  });
});
