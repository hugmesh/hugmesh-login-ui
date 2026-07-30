import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
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

describe('MfaChallengeComponent', () => {
  let fixture: ComponentFixture<MfaChallengeComponent>;
  let component: MfaChallengeComponent;
  let mfa: jasmine.SpyObj<MfaService>;

  async function setup(): Promise<void> {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', ['challenge', 'assertWebauthnOptions']);
    await TestBed.configureTestingModule({
      imports: [MfaChallengeComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }],
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

  it('submitCode posts a TOTP challenge and on success navigates to returnTo', async () => {
    const router = TestBed.inject(Router);
    spyOn(router, 'parseUrl').and.returnValue({ queryParams: { returnTo: '/login/security' } } as never);
    const nav = spyOn(router, 'navigateByUrl');
    component.code = '123456';
    mfa.challenge.and.resolveTo(ok({ mfaSatisfied: true }));
    await component.submitCode();
    expect(mfa.challenge).toHaveBeenCalledWith('totp', '123456');
    expect(component.satisfied()).toBeTrue();
    expect(nav).toHaveBeenCalledWith('/login/security');
  });

  it('shows an error (and does NOT navigate) when the challenge is not satisfied', async () => {
    const router = TestBed.inject(Router);
    const nav = spyOn(router, 'navigateByUrl');
    component.code = '000000';
    mfa.challenge.and.resolveTo(err(401));
    await component.submitCode();
    expect(component.satisfied()).toBeFalse();
    expect(component.error()).toContain('did not verify');
    expect(nav).not.toHaveBeenCalled();
  });

  it('maps a 503 challenge response to the DARK state', async () => {
    component.code = '123456';
    mfa.challenge.and.resolveTo(dark());
    await component.submitCode();
    fixture.detectChanges();
    expect(component.dark()).toBeTrue();
    expect(el().querySelector('[data-testid="mfa-challenge-dark"]')).toBeTruthy();
  });

  it('useWebauthn maps a 503 options response to DARK', async () => {
    (component as unknown as { webauthnAvailable: boolean }).webauthnAvailable = true;
    mfa.assertWebauthnOptions.and.resolveTo(dark());
    await component.useWebauthn();
    expect(component.dark()).toBeTrue();
  });
});
