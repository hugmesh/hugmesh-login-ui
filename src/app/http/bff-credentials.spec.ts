import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AuthControllerService } from '../api/services/auth-controller.service';
import { AppealContactControllerService } from '../api/services/appeal-contact-controller.service';
import { bffFailure, withBffCredentials } from './bff-credentials';

/**
 * The credentialed-request seam itself: proof that the GENERATED transport
 * (src/app/api/request-builder.ts, produced from templates/requestBuilder.handlebars)
 * honours the BFF_CREDENTIALS context token — the gap that kept the credentialed
 * `/bff/*` calls on raw `fetch`. Driven through real generated clients so the
 * assertion covers the transport as it actually ships, not a stand-in.
 */
describe('bff-credentials (generated transport)', () => {
  let auth: AuthControllerService;
  let publicContact: AppealContactControllerService;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    auth = TestBed.inject(AuthControllerService);
    publicContact = TestBed.inject(AppealContactControllerService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('sends withCredentials on a call marked credentialed', () => {
    auth.authSession({}, withBffCredentials()).subscribe({ error: () => undefined });
    const req = httpMock.expectOne((r) => r.url.includes('/bff/session'));
    expect(req.request.withCredentials).toBeTrue();
    req.flush({});
  });

  it('applies the caller-supplied headers (the double-submit CSRF token)', () => {
    auth.authSessionOut({}, withBffCredentials({ 'X-CSRF-TOKEN': 'tok-123' }))
      .subscribe({ error: () => undefined });
    const req = httpMock.expectOne((r) => r.url.includes('/bff/sessionOut'));
    expect(req.request.headers.get('X-CSRF-TOKEN')).toBe('tok-123');
    expect(req.request.withCredentials).toBeTrue();
    // Never a bearer: auth rides in the httpOnly bff_ cookie.
    expect(req.request.headers.has('Authorization')).toBeFalse();
    req.flush({});
  });

  it('leaves an UNMARKED call anonymous — the public-floor reads must not send the cookie', () => {
    publicContact.appealContactAppealContact().subscribe({ error: () => undefined });
    const req = httpMock.expectOne((r) => r.url.includes('/bff/public/appeal-contact'));
    expect(req.request.withCredentials).toBeFalse();
    req.flush({ email: 'appeals@hugmesh.net' });
  });

  it('bffFailure reads the status and the parsed JSON error body off an HttpErrorResponse', () => {
    const err = new HttpErrorResponse({ status: 423, error: { error: 'account_banned', reason: 'spam' } });
    expect(bffFailure(err)).toEqual({ status: 423, body: { error: 'account_banned', reason: 'spam' } });
  });

  it('bffFailure degrades a transport failure to {status:0, body:{}}', () => {
    const err = new HttpErrorResponse({ status: 0, error: new ProgressEvent('error') });
    expect(bffFailure(err)).toEqual({ status: 0, body: {} });
  });

  it('bffFailure degrades a non-JSON error body to {}', () => {
    const err = new HttpErrorResponse({ status: 500, error: '<html>oops</html>' });
    expect(bffFailure(err)).toEqual({ status: 500, body: {} });
  });

  it('bffFailure tolerates a non-HttpErrorResponse throw', () => {
    expect(bffFailure(new Error('boom'))).toEqual({ status: 0, body: {} });
  });
});
