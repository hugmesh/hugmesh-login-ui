import { ComponentFixture, TestBed } from '@angular/core/testing';
import { APP_BASE_HREF, Location, PlatformLocation } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { provideRouter, Router, Routes } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { routes as STANDALONE_ROUTES } from './app.routes';
import { LOGIN_ROUTES } from './login.routes';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { MfaSecurityComponent } from './mfa-security.component';
import { MfaService } from './mfa.service';
import { MfaFactor, MfaResult } from './mfa.types';

function ok<T>(data: T): MfaResult<T> {
  return { ok: true, dark: false, status: 200, data };
}
function dark<T>(): MfaResult<T> {
  return { ok: false, dark: true, status: 503 };
}
function err<T>(status: number): MfaResult<T> {
  return { ok: false, dark: false, status, error: 'no' };
}

const FACTORS: MfaFactor[] = [
  { id: 'f1', type: 'TOTP', enabled: true, createdAt: '2026-01-01T00:00:00Z' },
  { id: 'w1', type: 'WEBAUTHN', enabled: true, createdAt: '2026-02-02T00:00:00Z' },
];

describe('MfaSecurityComponent', () => {
  let mfa: jasmine.SpyObj<MfaService>;

  async function setup(factorsResult: MfaResult<{ factors: MfaFactor[] }>): Promise<{
    fixture: ComponentFixture<MfaSecurityComponent>;
    component: MfaSecurityComponent;
  }> {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['factors', 'removeFactor', 'regenerateRecovery']);
    mfa.factors.and.resolveTo(factorsResult);
    await TestBed.configureTestingModule({
      imports: [MfaSecurityComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }],
    }).compileComponents();
    const fixture = TestBed.createComponent(MfaSecurityComponent);
    const component = fixture.componentInstance;
    await component.load(); // constructor already kicked one off; ensure settled
    fixture.detectChanges();
    return { fixture, component };
  }

  function html(fixture: ComponentFixture<MfaSecurityComponent>): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  it('lists the caller factors with a human type label + per-row remove button', async () => {
    const { fixture, component } = await setup(ok({ factors: FACTORS }));
    expect(component.factors().length).toBe(2);
    const rows = html(fixture).querySelectorAll('[data-testid="mfa-factor"]');
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain('Authenticator app');
    expect(rows[1].textContent).toContain('Passkey');
    const removeBtn = html(fixture).querySelector('[data-testid="mfa-factor-remove"]');
    expect(removeBtn?.getAttribute('aria-label')).toContain('Remove');
  });

  it('shows the empty state when there are no factors', async () => {
    const { fixture } = await setup(ok({ factors: [] }));
    expect(html(fixture).querySelector('[data-testid="mfa-security-empty"]')).toBeTruthy();
  });

  it('maps a 503 factors() response to the DARK state (whole surface hidden)', async () => {
    const { fixture, component } = await setup(dark());
    expect(component.dark()).toBeTrue();
    expect(html(fixture).querySelector('[data-testid="mfa-security-dark"]')).toBeTruthy();
    expect(html(fixture).querySelector('[data-testid="mfa-factor-list"]')).toBeFalsy();
  });

  it('removing a factor drops it from the list on success', async () => {
    const { component } = await setup(ok({ factors: FACTORS }));
    mfa.removeFactor.and.resolveTo(ok({ removed: true }));
    await component.remove(FACTORS[0]);
    expect(component.factors().map((f) => f.id)).toEqual(['w1']);
  });

  it('a 403 on remove routes to the step-up challenge with a returnTo', async () => {
    const { component } = await setup(ok({ factors: FACTORS }));
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigateByUrl');
    mfa.removeFactor.and.resolveTo(err(403));
    await component.remove(FACTORS[0]);
    expect(nav).toHaveBeenCalled();
    expect(String(nav.calls.mostRecent().args[0])).toContain('/login/mfa/challenge');
    expect(String(nav.calls.mostRecent().args[0])).toContain('returnTo=');
    // The factor is NOT removed locally without a successful server removal.
    expect(component.factors().length).toBe(2);
  });

  it('regenerate shows display-once codes on success', async () => {
    const { fixture, component } = await setup(ok({ factors: FACTORS }));
    mfa.regenerateRecovery.and.resolveTo(ok({ recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] }));
    await component.regenerate();
    fixture.detectChanges();
    expect(component.newRecoveryCodes()).toEqual(['AAAA-BBBB-CCCC-DDDD']);
    expect(html(fixture).querySelector('[data-testid="mfa-new-recovery-codes"]')?.textContent).toContain(
      'AAAA-BBBB-CCCC-DDDD',
    );
  });

  it('a 403 on regenerate routes to the step-up challenge', async () => {
    const { component } = await setup(ok({ factors: FACTORS }));
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigateByUrl');
    mfa.regenerateRecovery.and.resolveTo(err(403));
    await component.regenerate();
    expect(String(nav.calls.mostRecent().args[0])).toContain('/login/mfa/challenge');
  });
});

/**
 * GUI-32 — every link on this page must resolve against the MOUNT, not against
 * the router root.
 *
 * The fe-gateway serves THIS repo's own index.html for `/login/**`, built with
 * `--base-href=/login/` (Dockerfile). A hard load of `/login/security` is
 * therefore router URL `/security`, and an ABSOLUTE `routerLink="/login/…"` is
 * prefixed with the base href a second time: `/login/login/mfa/enroll`. That
 * still rendered (app.routes.ts also mounts the routes under `login`), which is
 * why nothing failed — the live stack recorded the doubled href for all six
 * seeded personas. Under the host shell the same routes sit under a `login`
 * mount with base `/`. A link relative to the route works in both; these tests
 * pin BOTH mounts with the real route tables, so a link that only works in one
 * of them goes red.
 *
 * The real PathLocationStrategy is in play (TestBed backs it with a mock
 * PlatformLocation), so APP_BASE_HREF is honoured exactly as in the browser.
 */
describe('MfaSecurityComponent — mount-relative links (GUI-32)', () => {
  let mfa: jasmine.SpyObj<MfaService>;

  async function mount(opts: {
    baseHref: string;
    routes: Routes;
    url: string;
    factors: MfaResult<{ factors: MfaFactor[] }>;
  }): Promise<{ harness: RouterTestingHarness; component: MfaSecurityComponent; el: HTMLElement }> {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['factors', 'removeFactor', 'regenerateRecovery']);
    mfa.factors.and.resolveTo(opts.factors);
    TestBed.configureTestingModule({
      providers: [
        provideRouter(opts.routes),
        { provide: APP_BASE_HREF, useValue: opts.baseHref },
        provideHttpClient(),
        provideHttpClientTesting(),
        { provide: MfaService, useValue: mfa },
      ],
    });
    const harness = await RouterTestingHarness.create();
    const component = await harness.navigateByUrl(opts.url, MfaSecurityComponent);
    await component.load();
    harness.detectChanges();
    return { harness, component, el: harness.routeNativeElement as HTMLElement };
  }

  /** The production standalone deploy: base href /login/, the dev-shell route
   *  table, the document hard-loaded at /login/security. */
  const standalone = (factors: MfaResult<{ factors: MfaFactor[] }>) =>
    mount({ baseHref: '/login/', routes: STANDALONE_ROUTES, url: '/security', factors });

  /** The host shell: base href /, LOGIN_ROUTES federated in under `login`. */
  const shell = (factors: MfaResult<{ factors: MfaFactor[] }>) =>
    mount({ baseHref: '/', routes: [{ path: 'login', children: LOGIN_ROUTES }], url: '/login/security', factors });

  const addHref = (el: HTMLElement) =>
    el.querySelector('[data-testid="mfa-security-add"]')?.getAttribute('href');

  it('standalone (base /login/): "Add a method" points at /login/mfa/enroll, not /login/login/mfa/enroll', async () => {
    const { el } = await standalone(ok({ factors: FACTORS }));
    expect(TestBed.inject(Location).path()).toBe('/security');
    expect(addHref(el)).toBe('/login/mfa/enroll');
  });

  it('standalone (base /login/): clicking "Add a method" lands on /login/mfa/enroll and renders the wizard', async () => {
    const { harness, el } = await standalone(ok({ factors: FACTORS }));
    (el.querySelector('[data-testid="mfa-security-add"]') as HTMLAnchorElement).click();
    await harness.fixture.whenStable();
    harness.detectChanges();
    expect(TestBed.inject(Location).path()).toBe('/mfa/enroll');
    expect(TestBed.inject(PlatformLocation).pathname).toBe('/login/mfa/enroll');
    expect(harness.fixture.debugElement.query((d) => d.componentInstance instanceof MfaEnrollComponent)).toBeTruthy();
  });

  it('host shell (base /, `login` mount): "Add a method" points at /login/mfa/enroll', async () => {
    const { el } = await shell(ok({ factors: FACTORS }));
    expect(addHref(el)).toBe('/login/mfa/enroll');
  });

  // ---- anonymous visitor (GUI-32 part 2) -----------------------------------

  const signinHref = (el: HTMLElement) =>
    el.querySelector('[data-testid="mfa-security-signin-link"]')?.getAttribute('href');

  it('a 401 from the factor list shows "sign in" — no raw status, no add/regenerate controls', async () => {
    const { component, el } = await standalone(err(401));
    expect(component.signedOut()).toBeTrue();
    expect(el.querySelector('[data-testid="mfa-security-signed-out"]')?.textContent).toContain(
      'Sign in to manage your security methods',
    );
    expect(el.querySelector('[data-testid="mfa-security-error"]')).toBeNull();
    expect(el.textContent).not.toContain('HTTP 401');
    expect(el.querySelector('[data-testid="mfa-security-add"]')).toBeNull();
    expect(el.querySelector('[data-testid="mfa-security-regenerate"]')).toBeNull();
    expect(el.querySelector('[data-testid="mfa-security-empty"]')).toBeNull();
  });

  it('standalone (base /login/): the sign-in link is the sign-in form at /login/', async () => {
    const { el } = await standalone(err(401));
    expect(signinHref(el)).toBe('/login/');
  });

  it('host shell (base /, `login` mount): the sign-in link is the sign-in form at /login', async () => {
    const { el } = await shell(err(401));
    expect(signinHref(el)).toBe('/login');
  });

  it('only a 401 is "signed out": any other failure still reports the error', async () => {
    const { component, el } = await standalone(err(500));
    expect(component.signedOut()).toBeFalse();
    expect(el.querySelector('[data-testid="mfa-security-signed-out"]')).toBeNull();
    expect(el.querySelector('[data-testid="mfa-security-error"]')).toBeTruthy();
  });
});
