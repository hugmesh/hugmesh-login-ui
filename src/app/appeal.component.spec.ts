import { ComponentFixture, TestBed } from '@angular/core/testing';
import { ActivatedRoute, provideRouter } from '@angular/router';
import { convertToParamMap, ParamMap } from '@angular/router';
import { AppealComponent } from './appeal.component';
import { AppealContactService } from './appeal-contact.service';
import { AppealSubmitResult, BffService } from './bff.service';
import { SessionService } from './session.service';

describe('AppealComponent', () => {
  let fixture: ComponentFixture<AppealComponent>;
  let component: AppealComponent;
  let service: jasmine.SpyObj<AppealContactService>;
  let bff: jasmine.SpyObj<BffService>;
  let session: SessionService;
  // Mutable query params the ActivatedRoute snapshot exposes (set per test).
  let queryParams: Record<string, string>;

  async function setup(email: string | null, loggedIn = false): Promise<void> {
    service = jasmine.createSpyObj<AppealContactService>('AppealContactService', ['contact']);
    service.contact.and.resolveTo({ email });
    bff = jasmine.createSpyObj<BffService>('BffService', ['submitAppeal']);

    const activatedRouteStub = {
      snapshot: {
        get queryParamMap(): ParamMap {
          return convertToParamMap(queryParams);
        },
      },
    };

    await TestBed.configureTestingModule({
      imports: [AppealComponent],
      providers: [
        provideRouter([]),
        SessionService,
        { provide: AppealContactService, useValue: service },
        { provide: BffService, useValue: bff },
        { provide: ActivatedRoute, useValue: activatedRouteStub },
      ],
    }).compileComponents();

    session = TestBed.inject(SessionService);
    if (loggedIn) {
      session.set({ id: 'u1', label: 'alice', provider: 'google', roles: ['user'], registrationComplete: true });
    }

    fixture = TestBed.createComponent(AppealComponent);
    component = fixture.componentInstance;
  }

  beforeEach(() => {
    queryParams = {};
    localStorage.clear();
  });

  afterEach(() => localStorage.clear());

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
  function testid(id: string): HTMLElement | null {
    return el().querySelector(`[data-testid="${id}"]`);
  }

  // =====================================================================
  // USER-SITUATIONAL — a single banned/suspended visitor's appeal page
  // =====================================================================

  it('renders an accessible heading that labels the appeal region', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const heading = el().querySelector('h2')!;
    expect(heading.textContent).toContain('Appeal');
    expect(heading.id).toBeTruthy();
    const region = testid('appeal-view')!;
    // aria-labelledby points at the heading id (an accessible name for the region).
    expect(region.getAttribute('aria-labelledby')).toBe(heading.id);
  });

  it('renders the resolved email as a REAL mailto link with an accessible name', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const link = testid('appeal-mailto') as HTMLAnchorElement;
    expect(link).toBeTruthy();
    expect(link.getAttribute('href')).toContain('mailto:appeals@hugmesh.systems');
    // The mailto pre-fills an appeal subject.
    expect(link.getAttribute('href')).toContain('subject=');
    // The accessible name announces the action + address, not a bare string.
    const ariaLabel = link.getAttribute('aria-label') ?? '';
    expect(ariaLabel).toContain('appeals@hugmesh.systems');
    expect(ariaLabel.toLowerCase()).toContain('appeal');
    // The visible text is the address itself.
    expect(link.textContent).toContain('appeals@hugmesh.systems');
  });

  it('describes the mailto link with visible help that the link references (aria-describedby)', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const link = testid('appeal-mailto') as HTMLAnchorElement;
    const describedBy = link.getAttribute('aria-describedby');
    expect(describedBy).withContext('mailto link has aria-describedby').toBeTruthy();
    // The referenced help element exists and carries genuinely useful guidance.
    const help = el().querySelector(`#${describedBy}`);
    expect(help).withContext('describedby target exists').toBeTruthy();
    expect(help!.textContent!.trim().length).toBeGreaterThan(0);
    expect(help!.textContent!.toLowerCase()).toContain('email app');
  });

  it('renders ordered appeal steps (real heading/list structure)', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const steps = testid('appeal-steps');
    expect(steps?.tagName.toLowerCase()).toBe('ol');
    expect(steps!.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
  });

  it('announces a blocked reason via role=alert + aria-live=assertive when given', async () => {
    queryParams = { reason: 'Your account was suspended for spam.' };
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    const alert = testid('appeal-reason')!;
    expect(alert).toBeTruthy();
    expect(alert.getAttribute('role')).toBe('alert');
    expect(alert.getAttribute('aria-live')).toBe('assertive');
    expect(alert.textContent).toContain('suspended for spam');
  });

  it('shows NO blocked-reason alert when no reason is passed', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testid('appeal-reason')).toBeNull();
  });

  // =====================================================================
  // DEGRADATION — gateway/resolver unreachable (the honest gateway gap)
  // =====================================================================

  it('still renders the appeal steps + an announced notice when the address fails to load', async () => {
    await setup(null);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    // No mailto when there is no address.
    expect(testid('appeal-mailto')).toBeNull();
    // But the steps are still present, and the unavailable notice is announced.
    expect(testid('appeal-steps')).toBeTruthy();
    const notice = testid('appeal-contact-unavailable')!;
    expect(notice).toBeTruthy();
    expect(notice.getAttribute('role')).toBe('alert');
  });

  it('does not flash the unavailable notice before the resolver answers', async () => {
    await setup(null);
    // Before detectChanges/whenStable, resolved() is false.
    expect(component.resolved()).toBeFalse();
    expect(component.contactUnavailable()).toBeFalse();
  });

  // =====================================================================
  // KEYBOARD OPERABILITY (WCAG 2.1.1) — the appeal page is all native
  // links: a real mailto <a> and a routerLink "back to sign in" <a>, both
  // Tab-reachable + Enter-activatable for free. These tests pin that.
  // =====================================================================

  it('renders the mailto as a native, keyboard-reachable <a href> (not a click-only element)', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const link = testid('appeal-mailto') as HTMLAnchorElement | null;
    expect(link).toBeTruthy();
    expect(link!.tagName).toBe('A');
    // A real href makes the anchor focusable + Enter-activatable in the browser.
    expect(link!.getAttribute('href')).toMatch(/^mailto:/);
    link!.focus();
    expect(document.activeElement).withContext('mailto link is focusable').toBe(link);
  });

  it('renders the back-to-sign-in control as a native, keyboard-reachable <a>', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const back = testid('appeal-back') as HTMLAnchorElement | null;
    expect(back).toBeTruthy();
    expect(back!.tagName).toBe('A');
    // routerLink resolves a real href, so the anchor is Tab-reachable.
    expect(back!.getAttribute('href')).toBeTruthy();
    back!.focus();
    expect(document.activeElement).toBe(back);
  });

  it('uses NO positive tabindex and NO custom interactive-role widget (natural focus order)', async () => {
    await setup('appeals@hugmesh.systems');
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    const focusable = Array.from(
      el().querySelectorAll<HTMLElement>('a, button, input, [tabindex], [role]'),
    );
    const interactiveRoles = ['button', 'menu', 'menuitem', 'tab', 'checkbox', 'switch', 'option', 'listbox'];
    for (const node of focusable) {
      const ti = node.getAttribute('tabindex');
      if (ti !== null) expect(Number(ti)).withContext(`${node.tagName} tabindex`).toBeLessThanOrEqual(0);
      const role = node.getAttribute('role');
      if (role !== null) {
        expect(interactiveRoles).withContext(`${node.tagName} role=${role}`).not.toContain(role);
      }
    }
  });

  // =====================================================================
  // STRUCTURED APPEAL SUBMISSION — the curtailed-but-still-authenticated
  // "ban -> appeal -> admin approve -> access restored" loop's SUBMISSION leg.
  // Honesty: submitted() is set ONLY on a genuine server-confirmed success; every
  // failure path (no session, validation, network) surfaces an honest, SPECIFIC
  // error and NEVER renders the confirmation.
  // =====================================================================

  it('shows NO structured-appeal form for a visitor with no session (mailto is their only path)', async () => {
    await setup('appeals@hugmesh.systems', false);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testid('appeal-form-section')).toBeNull();
    // The mailto fallback is still there regardless.
    expect(testid('appeal-mailto')).toBeTruthy();
  });

  it('shows the structured-appeal form for a still-authenticated (curtailed) session', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testid('appeal-form-section')).toBeTruthy();
    expect(testid('appeal-form')).toBeTruthy();
    // The mailto fallback stays visible alongside it (never replaced).
    expect(testid('appeal-mailto')).toBeTruthy();
  });

  it('a genuine server-confirmed success shows the recorded confirmation, not before', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    expect(testid('appeal-submitted')).toBeNull();

    let resolveSubmit!: (r: AppealSubmitResult) => void;
    bff.submitAppeal.and.returnValue(new Promise((res) => (resolveSubmit = res)));

    component.reasonInput.set('Let me back in, this was a mistake.');
    const p = component.submit();
    fixture.detectChanges();
    // While the request is in flight, no confirmation is shown yet.
    expect(testid('appeal-submitted')).toBeNull();
    expect(testid('appeal-submit')?.hasAttribute('disabled')).toBeTrue();

    resolveSubmit({ ok: true, status: 'PENDING', id: 'ap1' });
    await p;
    fixture.detectChanges();

    expect(bff.submitAppeal).toHaveBeenCalledWith('Let me back in, this was a mistake.', null);
    const confirmation = testid('appeal-submitted')!;
    expect(confirmation).toBeTruthy();
    expect(confirmation.getAttribute('role')).toBe('status');
  });

  it('passes a trimmed optional contact email through to the submission', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    bff.submitAppeal.and.resolveTo({ ok: true, status: 'PENDING', id: 'ap1' });
    component.reasonInput.set('reason');
    component.contactEmailInput.set('  me@else.example  ');
    await component.submit();

    expect(bff.submitAppeal).toHaveBeenCalledWith('reason', 'me@else.example');
  });

  it('an unauthenticated-session failure NEVER shows the confirmation, and announces the honest reason', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    bff.submitAppeal.and.resolveTo({ ok: false, error: 'unauthenticated' });
    component.reasonInput.set('please review');
    await component.submit();
    fixture.detectChanges();

    expect(testid('appeal-submitted')).toBeNull();
    const err = testid('appeal-submit-error')!;
    expect(err).toBeTruthy();
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.textContent).toContain('email address below');
    // The mailto fallback remains available.
    expect(testid('appeal-mailto')).toBeTruthy();
  });

  it('a network failure NEVER shows the confirmation, and announces an honest reason', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    bff.submitAppeal.and.resolveTo({ ok: false, error: 'network' });
    component.reasonInput.set('please review');
    await component.submit();
    fixture.detectChanges();

    expect(testid('appeal-submitted')).toBeNull();
    expect(testid('appeal-submit-error')).toBeTruthy();
  });

  it('does not submit an empty/whitespace-only reason', async () => {
    await setup('appeals@hugmesh.systems', true);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();

    component.reasonInput.set('   ');
    await component.submit();

    expect(bff.submitAppeal).not.toHaveBeenCalled();
    expect(testid('appeal-submitted')).toBeNull();
  });
});
