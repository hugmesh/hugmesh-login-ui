import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { AppealContactService } from './appeal-contact.service';

/**
 * After the ng-openapi-gen migration this service delegates to the generated
 * {@code AppealContactControllerService} (Angular {@code HttpClient}), so the
 * suite drives the BFF through {@link HttpTestingController} instead of a
 * {@code fetch} spy (mirrors public-announcements.service.spec). The
 * behavioural contract is unchanged: it GETs the PUBLIC appeal-contact path
 * with NO Authorization header and NO credentials, and degrades to
 * `{ email: null }` on a non-OK / network / unexpected-shape response.
 */
describe('AppealContactService', () => {
  let service: AppealContactService;
  let httpMock: HttpTestingController;

  const PATH = '/bff/public/appeal-contact';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [AppealContactService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(AppealContactService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs the PUBLIC appeal-contact resolver path', async () => {
    const p = service.contact();
    const req = httpMock.expectOne((r) => r.url.includes(PATH));
    expect(req.request.method).toBe('GET');
    req.flush({ email: 'appeals@hugmesh.systems' });
    await p;
  });

  it('sends NO Authorization header (anonymous, banned/logged-out principal)', async () => {
    const p = service.contact();
    const req = httpMock.expectOne((r) => r.url.includes(PATH));
    expect(req.request.headers.has('Authorization')).toBeFalse();
    // And no cookies are attached (no credentials on the anonymous read).
    expect(req.request.withCredentials).toBeFalse();
    req.flush({ email: 'appeals@hugmesh.systems' });
    await p;
  });

  it('returns the resolved email on success', async () => {
    const p = service.contact();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({ email: 'appeals@hugmesh.systems' });
    expect(await p).toEqual({ email: 'appeals@hugmesh.systems' });
  });

  it('degrades to { email: null } on a non-OK response (e.g. gateway 401)', async () => {
    const p = service.contact();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({}, { status: 401, statusText: 'Unauthorized' });
    expect(await p).toEqual({ email: null });
  });

  it('degrades to { email: null } when the request errors (network down)', async () => {
    const p = service.contact();
    httpMock.expectOne((r) => r.url.includes(PATH)).error(new ProgressEvent('network'));
    expect(await p).toEqual({ email: null });
  });

  it('degrades to { email: null } when the body has no usable email', async () => {
    const p = service.contact();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({ nope: 1 });
    expect(await p).toEqual({ email: null });
  });

  it('degrades to { email: null } when the email is blank/whitespace', async () => {
    const p = service.contact();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({ email: '   ' });
    expect(await p).toEqual({ email: null });
  });
});
