import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, convertToParamMap, ParamMap, provideRouter } from '@angular/router';

import { AppealComponent } from './appeal.component';
import { AppealContactService } from './appeal-contact.service';
import { BffService } from './bff.service';
import { HardNavigationService } from './hard-navigation.service';
import { LocalAgentService, LocalRole } from './local-agent.service';
import { LoginBannerComponent } from './login-banner.component';
import { LoginComponent } from './login.component';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { MfaSecurityComponent } from './mfa-security.component';
import { MfaService } from './mfa.service';
import { MfaFactor } from './mfa.types';
import { PublicAnnouncementsService } from './public-announcements.service';
import { RolePickerComponent } from './role-picker.component';
import { SessionService } from './session.service';

/**
 * CROSS-COMPONENT BUTTON-STYLING GUARD.
 *
 * The regression this exists to stop: a `<button>` that carries no class (or a
 * class whose rule never sets background/colour/font) falls back to the user
 * agent's default button chrome — Chrome paints `ButtonFace` grey with a 2px
 * `outset` border and a 13.33px non-inherited font. On the dark hugmesh shell
 * that reads as a "random grey button", and on the animated light login
 * backdrop it is close to invisible. The shipped sign-in button did exactly
 * that: `class=""`, 65x30, `background: rgb(239,239,239)`.
 *
 * These assertions are deliberately DIFFERENTIAL rather than absolute: each
 * button is compared against a bare `<button>` rendered in the same document,
 * so the test does not hardcode a Chrome-version-specific `ButtonFace` value
 * and does not pin the design to particular colours. It only insists that a
 * hugmesh button is styled AT ALL.
 *
 * Note this must run in a real browser (karma/ChromeHeadless) — `getComputedStyle`
 * is what makes the UA fallback observable; a DOM-only class-name assertion
 * would pass on a button whose class exists but styles nothing.
 */
describe('button styling convention', () => {
  /**
   * Bare, unstyled `<button>`s in the same document: the UA-default baseline.
   * TWO of them, because Chrome paints a disabled button a DIFFERENT default
   * (`rgba(239,239,239,0.3)` vs `rgb(239,239,239)`). Comparing a disabled app
   * button against the enabled baseline would pass vacuously — which is exactly
   * what the first draft of this spec did on the sign-in button.
   */
  let baseline: { enabled: string; disabled: string };
  let host: HTMLElement;

  beforeEach(() => {
    host = document.createElement('div');
    document.body.appendChild(host);
    const bare = document.createElement('button');
    bare.textContent = 'x';
    const bareOff = document.createElement('button');
    bareOff.textContent = 'x';
    bareOff.disabled = true;
    host.append(bare, bareOff);
    baseline = {
      enabled: getComputedStyle(bare).backgroundColor,
      disabled: getComputedStyle(bareOff).backgroundColor,
    };
  });

  afterEach(() => host.remove());

  /**
   * Assert every rendered <button> is styled: it must not paint the UA default
   * button background, and it must inherit the page font rather than the UA's
   * private button font.
   */
  function expectStyledButtons(root: HTMLElement, where: string): void {
    const buttons = Array.from(root.querySelectorAll<HTMLButtonElement>('button'));
    expect(buttons.length).withContext(`${where} renders at least one button`).toBeGreaterThan(0);
    const bodyFont = getComputedStyle(document.body).fontFamily;
    for (const btn of buttons) {
      const label = (btn.dataset['testid'] ?? btn.textContent ?? '').trim().slice(0, 40);
      const cs = getComputedStyle(btn);
      const uaBackground = btn.disabled ? baseline.disabled : baseline.enabled;
      expect(cs.backgroundColor)
        .withContext(`${where}: <button ${label}> paints the UA default button background`)
        .not.toBe(uaBackground);
      expect(cs.fontFamily)
        .withContext(`${where}: <button ${label}> does not inherit the page font (needs font: inherit)`)
        .toBe(bodyFont);
    }
  }

  // ---------------------------------------------------------------- login

  describe('LoginComponent', () => {
    const sessionStub = {
      loggedIn: () => false,
      fullyRegistered: () => false,
      session: () => null as { label: string } | null,
    };

    beforeEach(async () => {
      const bff = jasmine.createSpyObj<BffService>('BffService', ['login', 'loginLocal', 'completeRegistration']);
      const localAgent = jasmine.createSpyObj<LocalAgentService>('LocalAgentService', ['roles', 'handoff']);
      localAgent.roles.and.resolveTo([]);
      const announcements = jasmine.createSpyObj<PublicAnnouncementsService>('PublicAnnouncementsService', ['login']);
      announcements.login.and.resolveTo({ announcements: [] });
      const hardNav = jasmine.createSpyObj<HardNavigationService>('HardNavigationService', ['navigate']);

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
    });

    it('styles the sign-in submit button', () => {
      const fixture = TestBed.createComponent(LoginComponent);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="login-submit"]')).withContext('sign-in form is showing').toBeTruthy();
      expectStyledButtons(root, 'sign-in view');
      fixture.destroy();
    });

    it('styles the MFA step-up submit button', () => {
      const fixture = TestBed.createComponent(LoginComponent);
      fixture.detectChanges();
      fixture.componentInstance.mfaRequired.set(true);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="login-mfa-submit"]')).withContext('MFA form is showing').toBeTruthy();
      expectStyledButtons(root, 'MFA step-up view');
      fixture.destroy();
    });

    it('styles the complete-registration button', () => {
      spyOn(sessionStub, 'loggedIn').and.returnValue(true);
      spyOn(sessionStub, 'session').and.returnValue({ label: 'alice' });
      const fixture = TestBed.createComponent(LoginComponent);
      fixture.detectChanges();
      const root = fixture.nativeElement as HTMLElement;
      expect(root.querySelector('[data-testid="login-complete"]')).withContext('complete view is showing').toBeTruthy();
      expectStyledButtons(root, 'complete-registration view');
      fixture.destroy();
    });
  });

  // --------------------------------------------------------------- appeal

  it('styles the appeal submit button', async () => {
    const contact = jasmine.createSpyObj<AppealContactService>('AppealContactService', ['contact']);
    contact.contact.and.resolveTo({ email: 'abuse@hugmesh.net' });
    const bff = jasmine.createSpyObj<BffService>('BffService', ['submitAppeal']);
    const activatedRouteStub = {
      snapshot: {
        get queryParamMap(): ParamMap {
          return convertToParamMap({});
        },
      },
    };
    // A STUB session, not the real SessionService: its constructor opens a
    // BroadcastChannel and registers window listeners it never removes, so an
    // extra live instance per spec accumulates across the suite. AppealComponent
    // only reads `loggedIn()`, which is all the structured form is gated on.
    const sessionStub = { loggedIn: () => true };

    await TestBed.configureTestingModule({
      imports: [AppealComponent],
      providers: [
        provideRouter([]),
        { provide: SessionService, useValue: sessionStub },
        { provide: AppealContactService, useValue: contact },
        { provide: BffService, useValue: bff },
        { provide: ActivatedRoute, useValue: activatedRouteStub },
      ],
    }).compileComponents();

    const fixture = TestBed.createComponent(AppealComponent);
    // Drive the async init directly rather than through whenStable(): the view
    // it renders holds a sandboxed <iframe>, which can keep the zone busy.
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="appeal-submit"]')).withContext('appeal form is showing').toBeTruthy();
    expectStyledButtons(root, 'appeal view');
    fixture.destroy();
  });

  // -------------------------------------------------- announcement banner

  it('styles the announcement dismiss button', async () => {
    const feed = jasmine.createSpyObj<PublicAnnouncementsService>('PublicAnnouncementsService', ['login']);
    feed.login.and.resolveTo({
      announcements: [
        {
          id: 'a1',
          title: 'Scheduled maintenance',
          body_html: '<p>We will be down briefly.</p>',
          format: 'html',
          state: 'published',
          target_home: false,
          target_login: true,
          target_akkoma: false,
          target_forum: false,
          priority: 0,
          starts_at: null,
          ends_at: null,
          timezone: 'UTC',
          dismissible: true,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    });
    await TestBed.configureTestingModule({
      imports: [LoginBannerComponent],
      providers: [{ provide: PublicAnnouncementsService, useValue: feed }],
    }).compileComponents();
    const fixture = TestBed.createComponent(LoginBannerComponent);
    // ngOnInit directly, not whenStable(): the banner renders the announcement
    // body in a sandboxed <iframe srcdoc>, whose load can keep the zone busy.
    await fixture.componentInstance.ngOnInit();
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    expect(root.querySelector('[data-testid="login-announcement-dismiss"]'))
      .withContext('a dismissible announcement is showing')
      .toBeTruthy();
    expectStyledButtons(root, 'announcement banner');
    fixture.destroy();
  });

  // ---------------------------------------------------------- role picker

  it('styles the passwordless role cards', async () => {
    const roles: LocalRole[] = [
      { id: 'brandowner', label: 'Brand Owner', brand: 'acme' },
      { id: 'moderator', label: 'Moderator', brand: '' },
    ];
    await TestBed.configureTestingModule({ imports: [RolePickerComponent] }).compileComponents();
    const fixture = TestBed.createComponent(RolePickerComponent);
    fixture.componentRef.setInput('roles', roles);
    fixture.detectChanges();
    expectStyledButtons(fixture.nativeElement as HTMLElement, 'role picker');
    fixture.destroy();
  });

  // ------------------------------------------------------------------ MFA
  // These already used the .mfa-btn convention before the shared mixin landed;
  // they are here as the anchor that promoting it out of `.hug-mfa` changed
  // nothing for the surface that already had it.

  it('styles the MFA enrollment buttons', async () => {
    const mfa = jasmine.createSpyObj<MfaService>('MfaService', [
      'enrollTotp',
      'verifyTotp',
      'enrollWebauthnOptions',
      'verifyWebauthn',
    ]);
    await TestBed.configureTestingModule({
      imports: [MfaEnrollComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }],
    }).compileComponents();
    const fixture = TestBed.createComponent(MfaEnrollComponent);
    fixture.detectChanges();
    expectStyledButtons(fixture.nativeElement as HTMLElement, 'MFA enrollment');
    fixture.destroy();
  });

  it('styles the MFA security-section buttons', async () => {
    const factors: MfaFactor[] = [{ id: 'f1', type: 'TOTP', enabled: true, createdAt: '2026-01-01T00:00:00Z' }];
    const mfa = jasmine.createSpyObj<MfaService>('MfaService', ['factors', 'removeFactor', 'regenerateRecovery']);
    mfa.factors.and.resolveTo({ ok: true, dark: false, status: 200, data: { factors } });
    await TestBed.configureTestingModule({
      imports: [MfaSecurityComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }],
    }).compileComponents();
    const fixture = TestBed.createComponent(MfaSecurityComponent);
    await fixture.componentInstance.load();
    fixture.detectChanges();
    expectStyledButtons(fixture.nativeElement as HTMLElement, 'MFA security section');
    fixture.destroy();
  });
});
