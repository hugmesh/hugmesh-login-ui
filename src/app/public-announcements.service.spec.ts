import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { PublicAnnouncementsService } from './public-announcements.service';

/**
 * After the ng-openapi-gen migration this service delegates to the generated
 * {@code AnnouncementSurfaceControllerService} (Angular {@code HttpClient}), so
 * the suite drives the BFF through {@link HttpTestingController} instead of a
 * {@code fetch} spy. The behavioural contract is unchanged: it GETs the PUBLIC
 * login path with NO Authorization header and NO credentials, and degrades to
 * an empty feed on a non-OK / network / unexpected-shape response.
 */
describe('PublicAnnouncementsService', () => {
  let service: PublicAnnouncementsService;
  let httpMock: HttpTestingController;

  const PATH = '/bff/public/announcements/login';

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [PublicAnnouncementsService, provideHttpClient(), provideHttpClientTesting()],
    });
    service = TestBed.inject(PublicAnnouncementsService);
    httpMock = TestBed.inject(HttpTestingController);
  });

  afterEach(() => httpMock.verify());

  it('GETs the PUBLIC login feed path', async () => {
    const p = service.login();
    const req = httpMock.expectOne((r) => r.url.includes(PATH));
    expect(req.request.method).toBe('GET');
    req.flush({ announcements: [] });
    await p;
  });

  it('sends NO Authorization header (anonymous, unauthenticated feed)', async () => {
    const p = service.login();
    const req = httpMock.expectOne((r) => r.url.includes(PATH));
    expect(req.request.headers.has('Authorization')).toBeFalse();
    // And no cookies are attached (no credentials on the anonymous read).
    expect(req.request.withCredentials).toBeFalse();
    req.flush({ announcements: [] });
    await p;
  });

  it('returns the announcements array on success', async () => {
    const a = { id: 'x', target_login: true } as any;
    const p = service.login();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({ announcements: [a] });
    const feed = await p;
    expect(feed.announcements).toEqual([a]);
  });

  it('degrades to an empty feed on a non-OK response', async () => {
    const p = service.login();
    httpMock
      .expectOne((r) => r.url.includes(PATH))
      .flush({}, { status: 503, statusText: 'Service Unavailable' });
    const feed = await p;
    expect(feed.announcements).toEqual([]);
  });

  it('degrades to an empty feed when fetch rejects (network down)', async () => {
    const p = service.login();
    httpMock.expectOne((r) => r.url.includes(PATH)).error(new ProgressEvent('network'));
    const feed = await p;
    expect(feed.announcements).toEqual([]);
  });

  it('degrades to an empty feed when the body is not the expected shape', async () => {
    const p = service.login();
    httpMock.expectOne((r) => r.url.includes(PATH)).flush({ nope: 1 });
    const feed = await p;
    expect(feed.announcements).toEqual([]);
  });
});
