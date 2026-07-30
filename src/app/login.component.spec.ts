import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter, Router } from '@angular/router';
import { LoginComponent } from './login.component';
import { BffService } from './bff.service';
import { SessionService } from './session.service';
import { HardNavigationService } from './hard-navigation.service';
import { LocalAgentService, LocalRole } from './local-agent.service';
import { PublicAnnouncementsService } from './public-announcements.service';

describe('LoginComponent', () => {
  let fixture: ComponentFixture<LoginComponent>;
  let component: LoginComponent;
  let bff: jasmine.SpyObj<BffService>;
  // The login view carries `routerLink`s (the appeal/contact link), so the
  // component needs a REAL router provider tree (provideRouter) for RouterLink to
  // resolve ActivatedRoute — but post-login/registration handoff is a HARD
  // navigation (login-ui is deployed standalone, no module-federation remoteEntry
  // in this stack; see login.component.ts's goToHost() doc comment), asserted via
  // a mocked HardNavigationService rather than the real window.location (whose
  // methods aren't spy-able/configurable in a real browser) or a fake DOCUMENT
  // (which broke Angular's own TestBed.createComponent — it needs a real document
  // to render into).
  let hardNav: jasmine.SpyObj<HardNavigationService>;
  let announcements: jasmine.SpyObj<PublicAnnouncementsService>;
  // The passwordless local-login probe; defaults to "no agent" so the existing
  // tests render the normal password form (the graceful-fallback path).
  let localAgent: jasmine.SpyObj<LocalAgentService>;
  // The component reads loggedIn()/fullyRegistered()/session() off SessionService.
  const sessionStub = {
    loggedIn: () => false,
    fullyRegistered: () => false,
    session: () => null as { label: string } | null,
  };

  beforeEach(async () => {
    bff = jasmine.createSpyObj<BffService>('BffService', ['login', 'loginLocal', 'completeRegistration']);
    // No local agent by default → roles() resolves [] → the password form renders.
    localAgent = jasmine.createSpyObj<LocalAgentService>('LocalAgentService', ['roles', 'handoff']);
    localAgent.roles.and.resolveTo([]);
    // The embedded login banner fetches the public announcement feed on init;
    // stub it to an empty feed so it renders nothing in these login-form tests.
    announcements = jasmine.createSpyObj<PublicAnnouncementsService>('PublicAnnouncementsService', ['login']);
    announcements.login.and.resolveTo({ announcements: [] });

    hardNav = jasmine.createSpyObj<HardNavigationService>('HardNavigationService', ['navigate']);

    await TestBed.configureTestingModule({
      imports: [LoginComponent],
      providers: [
        provideRouter([]),
        { provide: BffService, useValue: bff },
        { provide: SessionService, useValue: sessionStub },
        { provide: LocalAgentService, useValue: localAgent },
        { provide: PublicAnnouncementsService, useValue: announcements },
        { provide: HardNavigationService, useValue: hardNav },
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(LoginComponent);
    component = fixture.componentInstance;
  });

  /** Drive the component into the logged-in-but-incomplete (complete) view. */
  function showCompleteView(label = 'alice'): void {
    spyOn(sessionStub, 'loggedIn').and.returnValue(true);
    spyOn(sessionStub, 'fullyRegistered').and.returnValue(false);
    spyOn(sessionStub, 'session').and.returnValue({ label });
  }

  // =====================================================================
  // NATIVE username/password form — OUR OWN login surface
  // =====================================================================

  it('mounts the public announcement banner ABOVE the login form', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const banner = el.querySelector('hug-login-banner');
    const form = el.querySelector('[data-testid="login-view"]');
    expect(banner).withContext('banner is present').toBeTruthy();
    expect(form).withContext('login form is present').toBeTruthy();
    expect(banner!.compareDocumentPosition(form!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders the native username/password sign-in form when not logged in', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="login-view"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="login-username"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="login-password"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="login-submit"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="complete-view"]')).toBeNull();
  });

  it('exposes NO Casdoor SSO button and NO Google/Discord provider fieldsets', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    // The browser is never redirected to Casdoor — there is no SSO entry point,
    // and the legacy provider fieldsets are gone.
    expect(el.querySelector('[data-testid="login-oidc"]')).toBeNull();
    expect(el.querySelector('[data-testid="login-google-register"]')).toBeNull();
    expect(el.querySelector('[data-testid="login-discord"]')).toBeNull();
    expect(el.querySelector('[data-testid="login-signin"]')).toBeNull();
  });

  it('the submit button is disabled until both username and password are present', async () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    await fixture.whenStable();
    const el: HTMLElement = fixture.nativeElement;
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-submit"]')!;
    expect(btn.disabled).withContext('blocked before any credentials').toBeTrue();

    // Drive the values through the real inputs so the template-driven ngModel
    // updates the component fields (a direct field write can race ngModel setup).
    const user = el.querySelector<HTMLInputElement>('[data-testid="login-username"]')!;
    user.value = 'alice';
    user.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(btn.disabled).withContext('still blocked with only a username').toBeTrue();

    const pass = el.querySelector<HTMLInputElement>('[data-testid="login-password"]')!;
    pass.value = 's3cret';
    pass.dispatchEvent(new Event('input'));
    fixture.detectChanges();
    expect(btn.disabled).withContext('enabled once both fields are filled').toBeFalse();
  });

  it('submit() POSTs {username,password} to bff.login and navigates home when fully registered', async () => {
    bff.login.and.resolveTo({ ok: true, registrationComplete: true, status: 'active' });
    spyOn(sessionStub, 'fullyRegistered').and.returnValue(true);
    component.username = '  alice  ';
    component.password = 's3cret';
    await component.submit();
    expect(bff.login).toHaveBeenCalledWith('alice', 's3cret', undefined);
    expect(hardNav.navigate).toHaveBeenCalledWith('/');
    expect(component.error()).toBe('');
  });

  it('does NOT navigate after sign-in while registration is incomplete (complete gate shows)', async () => {
    bff.login.and.resolveTo({ ok: true, registrationComplete: false, status: 'active' });
    spyOn(sessionStub, 'fullyRegistered').and.returnValue(false);
    component.username = 'carol';
    component.password = 's3cret';
    await component.submit();
    expect(hardNav.navigate).not.toHaveBeenCalled();
  });

  it('shows a sign-in error and does not navigate when the credentials are rejected', async () => {
    bff.login.and.resolveTo({ ok: false, error: 'invalid_credentials' });
    component.username = 'mallory';
    component.password = 'nope';
    await component.submit();
    expect(component.error()).toBe('Sign-in failed: invalid_credentials');
    expect(hardNav.navigate).not.toHaveBeenCalled();
  });

  it('surfaces an "unavailable" message when the SSO surface is dark (503)', async () => {
    bff.login.and.resolveTo({ ok: false, dark: true, error: 'unavailable' });
    component.username = 'alice';
    component.password = 's3cret';
    await component.submit();
    expect(component.error()).toContain('temporarily unavailable');
    expect(hardNav.navigate).not.toHaveBeenCalled();
  });

  it('does not call the BFF when the form is submitted with empty credentials', async () => {
    component.username = '   ';
    component.password = '';
    await component.submit();
    expect(bff.login).not.toHaveBeenCalled();
    expect(component.error()).toContain('username and password');
  });

  // =====================================================================
  // BLOCKED account (banned / suspended) — auto-route to the appeal page
  // instead of surfacing the raw status token. The documented login.routes.ts
  // contract that submit() had never implemented (users saw
  // "Sign-in failed: account_banned").
  // =====================================================================

  describe('blocked account (banned/suspended) sign-in routes to the appeal page', () => {
    it('routes a banned sign-in to /login/appeal with the reason and shows NO error', async () => {
      const router = TestBed.inject(Router);
      const route = TestBed.inject(ActivatedRoute);
      const nav = spyOn(router, 'navigate').and.resolveTo(true);
      bff.login.and.resolveTo({ ok: false, blocked: true, error: 'account_banned', reason: 'Repeated spam reports' });
      component.username = 'bob';
      component.password = 's3cret';
      await component.submit();
      expect(nav).toHaveBeenCalledWith(['appeal'], {
        relativeTo: route,
        queryParams: { reason: 'Repeated spam reports' },
      });
      // The raw token must NEVER be shown as a sign-in error, and no host nav.
      expect(component.error()).toBe('');
      expect(hardNav.navigate).not.toHaveBeenCalled();
    });

    it('routes a suspended sign-in to the appeal page too', async () => {
      const router = TestBed.inject(Router);
      const nav = spyOn(router, 'navigate').and.resolveTo(true);
      bff.login.and.resolveTo({ ok: false, blocked: true, error: 'account_suspended', reason: 'Under review' });
      component.username = 'bob';
      component.password = 's3cret';
      await component.submit();
      expect(nav).toHaveBeenCalledWith(['appeal'], jasmine.objectContaining({
        queryParams: { reason: 'Under review' },
      }));
    });

    it('omits an empty reason from the appeal query params (no blank alert)', async () => {
      const router = TestBed.inject(Router);
      const nav = spyOn(router, 'navigate').and.resolveTo(true);
      bff.login.and.resolveTo({ ok: false, blocked: true, error: 'account_banned', reason: '' });
      component.username = 'bob';
      component.password = 's3cret';
      await component.submit();
      expect(nav).toHaveBeenCalledWith(['appeal'], jasmine.objectContaining({ queryParams: {} }));
    });

    it('routes a blocked PASSWORDLESS local sign-in to the appeal page as well', async () => {
      const router = TestBed.inject(Router);
      const nav = spyOn(router, 'navigate').and.resolveTo(true);
      bff.loginLocal.and.resolveTo({ ok: false, blocked: true, error: 'account_banned', reason: 'Repeated spam reports' });
      await component.pickRole('brandowner');
      expect(nav).toHaveBeenCalledWith(['appeal'], jasmine.objectContaining({
        queryParams: { reason: 'Repeated spam reports' },
      }));
      expect(component.error()).toBe('');
      expect(hardNav.navigate).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // MFA challenge — re-POST /bff/login with the passcode
  // =====================================================================

  describe('MFA challenge (mfaRequired re-POST)', () => {
    it('renders the MFA passcode challenge when the BFF answers mfaRequired', async () => {
      bff.login.and.resolveTo({ ok: false, mfaRequired: true, mfaType: ['totp'] });
      component.username = 'alice';
      component.password = 's3cret';
      await component.submit();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(component.mfaRequired()).toBeTrue();
      expect(el.querySelector('[data-testid="login-mfa-code"]')).toBeTruthy();
      expect(el.querySelector('[data-testid="login-mfa-submit"]')).toBeTruthy();
      // The username/password fields are swapped out for the challenge.
      expect(el.querySelector('[data-testid="login-username"]')).toBeNull();
    });

    it('re-POSTs the SAME credentials plus the passcode + factor type on the challenge submit', async () => {
      bff.login.and.returnValues(
        Promise.resolve({ ok: false, mfaRequired: true, mfaType: ['totp'] }),
        Promise.resolve({ ok: true, registrationComplete: true, status: 'active' }),
      );
      spyOn(sessionStub, 'fullyRegistered').and.returnValue(true);
      component.username = 'alice';
      component.password = 's3cret';
      await component.submit(); // first pass → mfaRequired

      component.mfaCode = '123456';
      await component.submit(); // second pass → passcode re-POST

      expect(bff.login).toHaveBeenCalledTimes(2);
      expect(bff.login.calls.mostRecent().args).toEqual([
        'alice',
        's3cret',
        { passcode: '123456', mfaType: 'totp' },
      ]);
      expect(hardNav.navigate).toHaveBeenCalledWith('/');
    });

    it('blocks the MFA submit (no BFF call) until a passcode is entered', async () => {
      bff.login.and.resolveTo({ ok: false, mfaRequired: true, mfaType: ['totp'] });
      component.username = 'alice';
      component.password = 's3cret';
      await component.submit(); // enter the MFA state
      bff.login.calls.reset();
      component.mfaCode = '  ';
      await component.submit();
      expect(bff.login).not.toHaveBeenCalled();
      expect(component.error()).toContain('verification code');
    });

    it('announces an MFA rejection through the role=alert error region', async () => {
      bff.login.and.returnValues(
        Promise.resolve({ ok: false, mfaRequired: true, mfaType: ['totp'] }),
        Promise.resolve({ ok: false, error: 'invalid_credentials' }),
      );
      component.username = 'alice';
      component.password = 's3cret';
      await component.submit();
      component.mfaCode = '000000';
      await component.submit();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const alert = el.querySelector('[data-testid="login-error"]')!;
      expect(alert.getAttribute('role')).toBe('alert');
      expect(alert.textContent).toContain('Sign-in failed');
    });
  });

  // =====================================================================
  // Complete-registration (stage two) — unchanged flow, reached via session
  // =====================================================================

  it('links a suspended/banned visitor to the appeal page (routerLink to appeal)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const link = el.querySelector('[data-testid="login-appeal-link"]') as HTMLAnchorElement;
    expect(link).withContext('appeal link is present on the login view').toBeTruthy();
    expect(link.getAttribute('href')).toContain('appeal');
  });

  // =====================================================================
  // Account security nav link — gated on the SAME session/feature signal
  // (SessionService.fullyRegistered()) the host's registeredGuard uses to
  // unlock Matrix/Mastodon, so the MFA self-service surface (/login/security)
  // becomes discoverable/hidden in lockstep with the rest of the account UI.
  // =====================================================================

  it('hides the account-security link when not fully registered', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    spyOn(sessionStub, 'fullyRegistered').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="login-security-link"]')).toBeNull();
  });

  it('shows a discoverable link into /login/security once fully registered', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(true);
    spyOn(sessionStub, 'fullyRegistered').and.returnValue(true);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const link = el.querySelector('[data-testid="login-security-link"]') as HTMLAnchorElement;
    expect(link).withContext('account-security link is present once fullyRegistered()').toBeTruthy();
    expect(link.getAttribute('href')).toContain('security');
  });

  it('shows the complete-registration view when logged in but not fully registered', () => {
    showCompleteView();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('[data-testid="complete-view"]')).toBeTruthy();
    expect(el.textContent).toContain('alice');
    // The sign-in form is gone in the complete view.
    expect(el.querySelector('[data-testid="login-username"]')).toBeNull();
    expect(el.querySelector('[data-testid="login-password"]')).toBeNull();
  });

  it('complete() finishes registration then navigates home (ASCII display name)', async () => {
    showCompleteView();
    bff.completeRegistration.and.resolveTo();
    component.displayName.set('Alice');
    await component.complete();
    expect(bff.completeRegistration).toHaveBeenCalled();
    expect(hardNav.navigate).toHaveBeenCalledWith('/');
  });

  describe('screenReaderName registration prompt', () => {
    it('an ASCII display name fills the default and does NOT prompt or block submit', () => {
      showCompleteView();
      component.displayName.set('Alex');
      expect(component.needsScreenReaderName()).toBeFalse();
      expect(component.completeBlocked()).toBeFalse();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="register-screen-reader-name"]'))
        .withContext('no ASCII screen-reader field is revealed for an ASCII name')
        .toBeNull();
    });

    it('the default screen-reader name sent for an ASCII display name IS the display name', async () => {
      showCompleteView();
      bff.completeRegistration.and.resolveTo();
      component.displayName.set('  Alex  ');
      await component.complete();
      expect(bff.completeRegistration).toHaveBeenCalledWith({
        displayName: 'Alex',
        screenReaderName: 'Alex',
      });
    });

    it('a NON-ASCII display name clears the default, reveals the field, prompts, and BLOCKS submit', async () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      expect(component.needsScreenReaderName()).withContext('prompt is required').toBeTrue();
      expect(component.completeBlocked()).withContext('submit blocked until ASCII entered').toBeTrue();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const field = el.querySelector('[data-testid="register-screen-reader-name"]');
      const help = el.querySelector('[data-testid="register-screen-reader-help"]');
      expect(field).withContext('ASCII screen-reader field is revealed').toBeTruthy();
      expect(help!.textContent).toContain('a screen reader cannot announce cleanly');
      await component.complete();
      expect(bff.completeRegistration).not.toHaveBeenCalled();
      expect(component.error()).toContain('a screen reader cannot announce cleanly');
    });

    it('a non-ASCII display name with a VALID ASCII screen-reader name unblocks + sends both', async () => {
      showCompleteView('山田太郎');
      bff.completeRegistration.and.resolveTo();
      component.displayName.set('山田太郎');
      component.screenReaderName.set('Yamada Taro');
      expect(component.screenReaderNameValid()).toBeTrue();
      expect(component.completeBlocked()).toBeFalse();
      await component.complete();
      expect(bff.completeRegistration).toHaveBeenCalledWith({
        displayName: '山田太郎',
        screenReaderName: 'Yamada Taro',
      });
    });

    it('a screen-reader name with control chars (tab/NUL/DEL) stays invalid and blocks submit', () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      for (const bad of ['tab\there', 'a\x00b', 'a\x7Fb', 'José']) {
        component.screenReaderName.set(bad);
        expect(component.screenReaderNameValid()).withContext(JSON.stringify(bad)).toBeFalse();
        expect(component.completeBlocked()).withContext(JSON.stringify(bad)).toBeTrue();
      }
    });

    it('blocks (and does not call the BFF) when no display name is entered at all', async () => {
      showCompleteView();
      component.displayName.set('   ');
      expect(component.completeBlocked()).toBeTrue();
      await component.complete();
      expect(bff.completeRegistration).not.toHaveBeenCalled();
      expect(component.error()).toContain('display name');
    });

    it('marks the screen-reader field aria-invalid while its value is not valid ASCII', () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      component.screenReaderName.set('José'); // non-ASCII
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const field = el.querySelector('[data-testid="register-screen-reader-name"]')!;
      expect(field.getAttribute('aria-invalid')).toBe('true');
      expect(field.getAttribute('aria-describedby')).toBe('hug-register-screen-reader-help');
    });

    it('exposes screenReaderName as the greeting aria-label when the label is non-ASCII', () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      component.screenReaderName.set('Yamada Taro');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const greeting = el.querySelector('[data-testid="complete-greeting"]')!;
      expect(greeting.getAttribute('aria-label')).toBe('Yamada Taro');
      expect(greeting.textContent).toContain('山田太郎'); // visible text stays UTF-8
    });

    it('does NOT set a greeting aria-label when the label is plain ASCII', () => {
      showCompleteView('alice');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const greeting = el.querySelector('[data-testid="complete-greeting"]')!;
      expect(greeting.getAttribute('aria-label')).toBeNull();
    });
  });

  describe('required display name contract (rendered Complete button)', () => {
    it('disables the rendered Complete-registration button while the display name is empty', () => {
      showCompleteView();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-complete"]')!;
      expect(btn.disabled).withContext('blocked before any name is typed').toBeTrue();

      component.displayName.set('   ');
      fixture.detectChanges();
      expect(btn.disabled).withContext('blocked on a whitespace-only name').toBeTrue();
    });

    it('reveals the ASCII screen-reader prompt and disables the rendered button for ANY non-ASCII name', () => {
      showCompleteView('Zoë 🌟');
      component.displayName.set('Zoë 🌟');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-complete"]')!;
      const field = el.querySelector('[data-testid="register-screen-reader-name"]');
      expect(field).withContext('ASCII screen-reader field is revealed for a non-ASCII name').toBeTruthy();
      expect(btn.disabled).withContext('rendered button stays blocked until an ASCII name is given').toBeTrue();
    });

    it('enables the rendered Complete-registration button for a valid ASCII display name', () => {
      showCompleteView('Alice');
      component.displayName.set('Alice');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-complete"]')!;
      expect(btn.disabled).withContext('unblocked on a plain ASCII display name').toBeFalse();
      expect(el.querySelector('[data-testid="register-screen-reader-name"]'))
        .withContext('no ASCII prompt for an ASCII name')
        .toBeNull();
    });

    it('re-enables the rendered button once a blocked non-ASCII name is fixed with a valid screen-reader name', () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-complete"]')!;
      expect(btn.disabled).withContext('starts blocked: non-ASCII name, no screen-reader name yet').toBeTrue();

      component.screenReaderName.set('Yamada Taro');
      fixture.detectChanges();
      expect(btn.disabled).withContext('re-enabled once the ASCII screen-reader name is supplied').toBeFalse();
    });
  });

  // =====================================================================
  // HELP TEXT — sighted (visible) + no-sight (aria-describedby wired)
  // =====================================================================

  function expectDescribedByResolves(el: HTMLElement, control: Element): void {
    const ids = (control.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids.length).withContext('control has an aria-describedby').toBeGreaterThan(0);
    for (const id of ids) {
      const target = el.querySelector(`#${id}`);
      expect(target).withContext(`describedby target #${id} exists`).toBeTruthy();
      expect(target!.textContent!.trim().length).withContext(`#${id} has visible help`).toBeGreaterThan(0);
    }
  }

  describe('help text (sighted + screen reader)', () => {
    it('shows a visible sign-in lead-in that the username/password fields describe', () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const intro = el.querySelector('[data-testid="login-intro"]')!;
      expect(intro).withContext('intro help is visible').toBeTruthy();
      expect(intro.textContent!.toLowerCase()).toContain('sign in');
      for (const id of ['login-username', 'login-password', 'login-submit']) {
        const ctrl = el.querySelector(`[data-testid="${id}"]`)!;
        expect((ctrl.getAttribute('aria-describedby') ?? '').split(/\s+/))
          .withContext(`${id} describes the intro help`)
          .toContain('hug-login-intro');
        expectDescribedByResolves(el, ctrl);
      }
    });

    it('keeps the error id in describedby ALONGSIDE the intro help when there is an error', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      bff.login.and.resolveTo({ ok: false, error: 'invalid_credentials' });
      component.username = 'alice';
      component.password = 'nope';
      await component.submit();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const username = el.querySelector('[data-testid="login-username"]')!;
      const ids = (username.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(ids).toContain('hug-login-error');
      expect(ids).toContain('hug-login-intro');
      expectDescribedByResolves(el, username);
    });

    it('describes the display-name input with visible, useful help', () => {
      showCompleteView();
      component.displayName.set('Alex');
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const input = el.querySelector('[data-testid="register-display-name"]')!;
      expect(input.getAttribute('aria-describedby')).toBe('hug-register-display-name-help');
      const help = el.querySelector('[data-testid="register-display-name-help"]')!;
      expect(help.textContent!.toLowerCase()).toContain('matrix');
      expectDescribedByResolves(el, input);
    });

    it('ALWAYS describes the Complete button with its action help (even when not blocked)', () => {
      showCompleteView();
      component.displayName.set('Alex');
      expect(component.completeBlocked()).toBeFalse();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector('[data-testid="login-complete"]')!;
      const ids = (btn.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(ids).toContain('hug-register-complete-help');
      expectDescribedByResolves(el, btn);
    });

    it('ADDS the screen-reader prompt to the Complete button describedby while blocked', () => {
      showCompleteView('山田太郎');
      component.displayName.set('山田太郎');
      expect(component.completeBlocked()).toBeTrue();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const btn = el.querySelector('[data-testid="login-complete"]')!;
      const ids = (btn.getAttribute('aria-describedby') ?? '').split(/\s+/);
      expect(ids).toContain('hug-register-complete-help');
      expect(ids).toContain('hug-register-screen-reader-help');
      expectDescribedByResolves(el, btn);
    });
  });

  // =====================================================================
  // Accessibility (WCAG) — baseline coverage
  // =====================================================================

  it('labels every text input with an associated <label for> (WCAG 1.3.1/3.3.2)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('input'));
    expect(inputs.length).toBeGreaterThan(0);
    for (const input of inputs) {
      const id = input.getAttribute('id');
      expect(id).withContext('input has an id').toBeTruthy();
      const label = el.querySelector(`label[for="${id}"]`);
      expect(label).withContext(`a <label for="${id}"> exists`).toBeTruthy();
      expect(label!.textContent!.trim().length).toBeGreaterThan(0);
    }
  });

  it('labels the MFA challenge input with an associated <label for>', async () => {
    bff.login.and.resolveTo({ ok: false, mfaRequired: true, mfaType: ['totp'] });
    component.username = 'alice';
    component.password = 's3cret';
    await component.submit();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const input = el.querySelector<HTMLInputElement>('[data-testid="login-mfa-code"]')!;
    const label = el.querySelector(`label[for="${input.id}"]`);
    expect(label).withContext('a <label for> exists for the MFA code').toBeTruthy();
  });

  it('labels the complete-view inputs with an associated <label for> (WCAG 1.3.1/3.3.2)', () => {
    showCompleteView('山田太郎');
    component.displayName.set('山田太郎');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const inputs = Array.from(el.querySelectorAll<HTMLInputElement>('[data-testid="complete-view"] input'));
    expect(inputs.length).toBe(2);
    for (const input of inputs) {
      const id = input.getAttribute('id')!;
      const label = el.querySelector(`label[for="${id}"]`);
      expect(label).withContext(`a <label for="${id}"> exists`).toBeTruthy();
    }
  });

  it('marks inputs aria-invalid and points aria-describedby at the alert when there is an error (WCAG 3.3.1)', async () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    bff.login.and.resolveTo({ ok: false, error: 'invalid_credentials' });
    component.username = 'alice';
    component.password = 'nope';
    await component.submit();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const username = el.querySelector<HTMLInputElement>('[data-testid="login-username"]')!;
    expect(username.getAttribute('aria-invalid')).toBe('true');
    const ids = (username.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toContain('hug-login-error');
    expect(el.querySelector('#hug-login-error')).withContext('aria-describedby target exists').toBeTruthy();
  });

  it('clears aria-invalid (and drops the error id from describedby) when there is no error', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const username = el.querySelector<HTMLInputElement>('[data-testid="login-username"]')!;
    expect(username.getAttribute('aria-invalid')).toBeNull();
    const ids = (username.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
    expect(ids).toContain('hug-login-intro');
    expect(ids).not.toContain('hug-login-error');
  });

  it('announces errors via a role=alert / aria-live=assertive region (WCAG 4.1.3)', async () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    bff.login.and.resolveTo({ ok: false, error: 'invalid_credentials' });
    component.username = 'alice';
    component.password = 'nope';
    await component.submit();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const alert = el.querySelector('[data-testid="login-error"]')!;
    expect(alert).toBeTruthy();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.textContent).toContain('invalid_credentials');
  });

  it('gives the section an accessible name via aria-labelledby (WCAG 1.3.1)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const section = el.querySelector('[data-testid="login-view"]')!;
    const labelledBy = section.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(el.querySelector(`#${labelledBy}`)).toBeTruthy();
  });

  // =====================================================================
  // KEYBOARD OPERABILITY (WCAG 2.1.1) — native form controls only
  // =====================================================================

  function interactiveNodes(root: HTMLElement): HTMLElement[] {
    return Array.from(
      root.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex], [role]'),
    );
  }

  it('renders the sign-in action as a native submit <button> inside a <form>', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const btn = el.querySelector('[data-testid="login-submit"]')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.getAttribute('type')).toBe('submit');
    expect(btn.closest('form')).withContext('submit lives inside a form so Enter submits').toBeTruthy();
  });

  it('uses NO positive tabindex anywhere in the sign-in view (preserves natural focus order, WCAG 2.4.3)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const nodes = interactiveNodes(el);
    expect(nodes.length).withContext('the sign-in view has interactive controls').toBeGreaterThan(0);
    for (const node of nodes) {
      const ti = node.getAttribute('tabindex');
      if (ti !== null) {
        expect(Number(ti)).withContext(`${node.tagName} tabindex`).toBeLessThanOrEqual(0);
      }
    }
  });

  it('exposes NO custom-role interactive widget without keyboard support (native elements only)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const interactiveRoles = ['button', 'menu', 'menuitem', 'tab', 'tablist', 'checkbox', 'switch', 'option', 'listbox'];
    const offenders = Array.from(el.querySelectorAll('[role]')).filter((n) =>
      interactiveRoles.includes(n.getAttribute('role') ?? ''),
    );
    expect(offenders).withContext('custom interactive-role widgets (must be native instead)').toEqual([]);
  });

  it('submits sign-in when the native form fires ngSubmit (Enter on a field)', () => {
    spyOn(sessionStub, 'loggedIn').and.returnValue(false);
    bff.login.and.resolveTo({ ok: true, registrationComplete: false, status: 'active' });
    component.username = 'alice';
    component.password = 's3cret';
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const form = el.querySelector('form')!;
    form.dispatchEvent(new Event('submit'));
    expect(bff.login).toHaveBeenCalledWith('alice', 's3cret', undefined);
  });

  it('keeps the Complete-registration control a native button so Enter/Space submits', () => {
    showCompleteView('alice');
    component.displayName.set('Alice');
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-complete"]')!;
    expect(btn.tagName).toBe('BUTTON');
    expect(btn.disabled).withContext('enabled once a valid display name exists').toBeFalse();
    btn.focus();
    expect(document.activeElement).toBe(btn);
  });

  // =====================================================================
  // PASSWORDLESS local-role picker — probe the local agent, render the picker
  // INSTEAD of the password form, sign in via bff.loginLocal. The password path
  // MUST stay intact (graceful fallback when the agent is absent).
  // =====================================================================

  describe('passwordless local-role picker', () => {
    const acmeRoles: LocalRole[] = [{ id: 'brandowner', label: 'Brand Owner', brand: 'acme' }];

    it('probes the local agent on init and renders the picker (NOT the password form) when roles exist', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      localAgent.roles.and.resolveTo(acmeRoles);
      fixture.detectChanges(); // ngOnInit fires the probe
      await fixture.whenStable(); // await roles()
      fixture.detectChanges(); // render with the resolved roles
      expect(localAgent.roles).toHaveBeenCalled();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="role-picker"]')).withContext('picker shown').toBeTruthy();
      expect(el.querySelector('[data-testid="role-card-brandowner"]')).toBeTruthy();
      // The username/password form is replaced by the picker.
      expect(el.querySelector('[data-testid="login-username"]')).toBeNull();
      expect(el.querySelector('[data-testid="login-password"]')).toBeNull();
    });

    it('GRACEFUL FALLBACK: renders the normal password form when the agent advertises no roles', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      localAgent.roles.and.resolveTo([]);
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(el.querySelector('[data-testid="role-picker"]')).toBeNull();
      expect(el.querySelector('[data-testid="login-username"]')).toBeTruthy();
      expect(el.querySelector('[data-testid="login-password"]')).toBeTruthy();
    });

    it('GRACEFUL FALLBACK: a probe that rejects still leaves the password form working', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      localAgent.roles.and.rejectWith(new Error('boom'));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      expect(component.localRoles()).toEqual([]);
      expect(el.querySelector('[data-testid="login-username"]')).toBeTruthy();
    });

    it('clicking a role card signs in via bff.loginLocal for that role', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      spyOn(sessionStub, 'fullyRegistered').and.returnValue(true);
      bff.loginLocal.and.resolveTo({ ok: true, registrationComplete: true, status: 'active' });
      component.localRoles.set(acmeRoles);
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      const card = el.querySelector<HTMLButtonElement>('[data-testid="role-card-brandowner"]')!;
      card.click();
      await fixture.whenStable();
      expect(bff.loginLocal).toHaveBeenCalledWith('brandowner');
    });

    it('pickRole() navigates home on a fully-registered local sign-in', async () => {
      spyOn(sessionStub, 'fullyRegistered').and.returnValue(true);
      bff.loginLocal.and.resolveTo({ ok: true, registrationComplete: true, status: 'active' });
      await component.pickRole('brandowner');
      expect(bff.loginLocal).toHaveBeenCalledWith('brandowner');
      expect(hardNav.navigate).toHaveBeenCalledWith('/');
      expect(component.error()).toBe('');
    });

    it('pickRole() does NOT navigate when the local session is not fully registered', async () => {
      spyOn(sessionStub, 'fullyRegistered').and.returnValue(false);
      bff.loginLocal.and.resolveTo({ ok: true, registrationComplete: false, status: 'active' });
      await component.pickRole('brandowner');
      expect(hardNav.navigate).not.toHaveBeenCalled();
    });

    it('pickRole() surfaces a sign-in error and does not navigate on failure (like a bad password)', async () => {
      bff.loginLocal.and.resolveTo({ ok: false, error: 'invalid_credentials' });
      await component.pickRole('brandowner');
      expect(component.error()).toBe('Sign-in failed: invalid_credentials');
      expect(hardNav.navigate).not.toHaveBeenCalled();
    });

    it('pickRole() shows an unavailable message when the SSO surface is dark (503)', async () => {
      bff.loginLocal.and.resolveTo({ ok: false, dark: true, error: 'unavailable' });
      await component.pickRole('brandowner');
      expect(component.error()).toContain('temporarily unavailable');
      expect(hardNav.navigate).not.toHaveBeenCalled();
    });

    it('pickRole() falls back to the password form when the role needs an MFA passcode', async () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(false);
      bff.loginLocal.and.resolveTo({ ok: false, mfaRequired: true, mfaType: ['totp'] });
      component.localRoles.set(acmeRoles);
      fixture.detectChanges();
      expect(component.showRolePicker()).withContext('picker shown before the MFA fallback').toBeTrue();
      await component.pickRole('brandowner');
      expect(component.forcePasswordForm()).toBeTrue();
      expect(component.showRolePicker()).withContext('picker hidden after the MFA fallback').toBeFalse();
      fixture.detectChanges();
      const el: HTMLElement = fixture.nativeElement;
      // The password form (which supports the MFA challenge) is now revealed.
      expect(el.querySelector('[data-testid="login-username"]')).toBeTruthy();
      expect(component.error()).toContain('verification code');
    });

    it('pickRole() ignores a second pick while a local sign-in is already in flight', async () => {
      let resolveLogin!: (r: { ok: boolean; registrationComplete?: boolean; status?: string }) => void;
      bff.loginLocal.and.returnValue(new Promise((res) => (resolveLogin = res)));
      const first = component.pickRole('brandowner');
      expect(component.localBusyRole()).toBe('brandowner');
      await component.pickRole('otherrole'); // ignored while busy
      expect(bff.loginLocal).toHaveBeenCalledTimes(1);
      resolveLogin({ ok: true, registrationComplete: false, status: 'active' });
      await first;
      expect(component.localBusyRole()).toBeNull();
    });
  });
});
