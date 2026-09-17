import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MfaChallengeComponent } from './mfa-challenge.component';
import { MfaService } from './mfa.service';
import { MfaResult } from './mfa.types';

function ok<T>(data: T): MfaResult<T> {
  return { ok: true, dark: false, status: 200, data };
}
function dark<T>(): MfaResult<T> {
  return { ok: false, dark: true, status: 503 };
}
function err<T>(status: number): MfaResult<T> {
  return { ok: false, dark: false, status, error: 'no' };
}

/**
 * The shared step-up challenge — the ONE implementation behind both the routed
 * `/login/mfa/challenge` page and the federated `./mfa-step-up` module that
 * forum, mod and wiki embed (generator#347 decision 21).
 *
 * NOTE WHAT THIS TestBed DOES NOT PROVIDE: there is no `provideRouter`. That is
 * the point, and it is an assertion, not an omission — an embedded copy runs
 * inside a consumer's own view where the injected Router would be the HOST
 * SHELL's, rooted at '/'. If this component ever re-acquires a Router, every
 * spec in this file fails with NullInjectorError rather than silently shipping a
 * dialog that navigates the consumer's page out from under it.
 */
describe('MfaChallengeComponent (the shared, embeddable step-up challenge)', () => {
  let fixture: ComponentFixture<MfaChallengeComponent>;
  let component: MfaChallengeComponent;
  let mfa: jasmine.SpyObj<MfaService>;

  async function setup(): Promise<void> {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['challenge', 'assertWebauthnOptions']);
    await TestBed.configureTestingModule({
      imports: [MfaChallengeComponent],
      providers: [{ provide: MfaService, useValue: mfa }],
    }).compileComponents();
    fixture = TestBed.createComponent(MfaChallengeComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(setup);

  it('defaults to the TOTP method and validates a 6-digit code', () => {
    expect(component.method()).toBe('totp');
    component.code = '12';
    expect(component.codeValid()).toBeFalse();
    component.code = '123456';
    expect(component.codeValid()).toBeTrue();
  });

  it('a recovery-method code only needs to be non-blank', () => {
    component.setMethod('recovery');
    component.code = 'AAAA-BBBB-CCCC-DDDD';
    expect(component.codeValid()).toBeTrue();
    component.code = '   ';
    expect(component.codeValid()).toBeFalse();
  });

  it('constructs with NO router in the injector (the embedded contract)', () => {
    // Belt and braces next to the file-level note: a Router dependency would have
    // thrown during createComponent above.
    expect(component).toBeTruthy();
  });

  it('renders no routerLink anywhere (an absolute link would move the host page)', () => {
    expect(el().querySelector('a[routerlink], a[ng-reflect-router-link]')).toBeNull();
    expect(el().querySelectorAll('a').length).toBe(0);
  });

  it('submitCode posts a TOTP challenge and EMITS satisfied instead of navigating', async () => {
    const seen: number[] = [];
    component.satisfied.subscribe(() => seen.push(1));
    component.code = '123456';
    mfa.challenge.and.resolveTo(ok({ mfaSatisfied: true }));
    await component.submitCode();
    expect(mfa.challenge).toHaveBeenCalledWith('totp', '123456');
    expect(component.verified()).toBeTrue();
    expect(seen.length).toBe(1);
    // The credential is dropped the moment it is spent.
    expect(component.code).toBe('');
  });

  it('shows an error and emits NOTHING when the challenge is not satisfied', async () => {
    const seen: string[] = [];
    component.satisfied.subscribe(() => seen.push('satisfied'));
    component.unavailable.subscribe(() => seen.push('unavailable'));
    component.code = '000000';
    mfa.challenge.and.resolveTo(err(401));
    await component.submitCode();
    expect(component.verified()).toBeFalse();
    expect(component.error()).toContain('did not verify');
    expect(seen).toEqual([]);
  });

  it('treats a 200 with mfaSatisfied:false as a rejection, not a success', async () => {
    const seen: string[] = [];
    component.satisfied.subscribe(() => seen.push('satisfied'));
    component.code = '123456';
    mfa.challenge.and.resolveTo(ok({ mfaSatisfied: false }));
    await component.submitCode();
    expect(component.verified()).toBeFalse();
    expect(seen).toEqual([]);
  });

  it('maps a 503 challenge response to the DARK state and announces it ONCE', async () => {
    let unavailable = 0;
    component.unavailable.subscribe(() => (unavailable += 1));
    component.code = '123456';
    mfa.challenge.and.resolveTo(dark());
    await component.submitCode();
    fixture.detectChanges();
    expect(component.dark()).toBeTrue();
    expect(el().querySelector('[data-testid="mfa-challenge-dark"]')).toBeTruthy();
    expect(unavailable).toBe(1);

    // A caller that has already swapped in its own fallback must not be told again.
    await component.submitCode();
    expect(unavailable).toBe(1);
  });

  it('renders no escape affordance in the dark state (that belongs to the caller)', async () => {
    component.code = '123456';
    mfa.challenge.and.resolveTo(dark());
    await component.submitCode();
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="mfa-challenge-cancel"]')).toBeNull();
    expect(el().querySelectorAll('a').length).toBe(0);
  });

  it('useWebauthn maps a 503 options response to DARK and announces it', async () => {
    let unavailable = 0;
    component.unavailable.subscribe(() => (unavailable += 1));
    (component as unknown as { webauthnAvailable: boolean }).webauthnAvailable = true;
    mfa.assertWebauthnOptions.and.resolveTo(dark());
    await component.useWebauthn();
    expect(component.dark()).toBeTrue();
    expect(unavailable).toBe(1);
  });

  it('offers a cancel button by default and emits dismissed, clearing the code', () => {
    let dismissed = 0;
    component.dismissed.subscribe(() => (dismissed += 1));
    const btn = el().querySelector<HTMLButtonElement>('[data-testid="mfa-challenge-cancel"]');
    expect(btn).withContext('cancellable defaults to TRUE for the embedded use').toBeTruthy();
    component.code = '123456';
    component.error.set('something');
    btn!.click();
    expect(dismissed).toBe(1);
    expect(component.code).toBe('');
    expect(component.error()).toBe('');
  });

  it('hides the cancel button when the host opts out (the routed page does)', () => {
    fixture.componentRef.setInput('cancellable', false);
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="mfa-challenge-cancel"]')).toBeNull();
  });

  it('offers the cancel button on the passkey method too', () => {
    component.setMethod('webauthn');
    fixture.detectChanges();
    expect(el().querySelector('[data-testid="mfa-challenge-cancel"]')).toBeTruthy();
  });

  it('names the pending action only when the caller supplies one', () => {
    expect(el().querySelector('[data-testid="mfa-challenge-action"]')).toBeNull();
    fixture.componentRef.setInput('action', 'lock this topic');
    fixture.detectChanges();
    const p = el().querySelector('[data-testid="mfa-challenge-action"]');
    expect(p?.textContent).toContain('lock this topic');
  });
});
