import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { MfaService } from './mfa.service';
import { MfaResult } from './mfa.types';

function ok<T>(data: T): MfaResult<T> {
  return { ok: true, dark: false, status: 200, data };
}
function dark<T>(): MfaResult<T> {
  return { ok: false, dark: true, status: 503 };
}
function err<T>(status: number, error = 'boom'): MfaResult<T> {
  return { ok: false, dark: false, status, error };
}

describe('MfaEnrollComponent', () => {
  let fixture: ComponentFixture<MfaEnrollComponent>;
  let component: MfaEnrollComponent;
  let mfa: jasmine.SpyObj<MfaService>;

  async function setup(): Promise<void> {
    mfa = jasmine.createSpyObj<MfaService>('MfaService', [
      'enrollTotp',
      'verifyTotp',
      'enrollWebauthnOptions',
      'verifyWebauthn',
    ]);
    await TestBed.configureTestingModule({
      imports: [MfaEnrollComponent],
      providers: [provideRouter([]), { provide: MfaService, useValue: mfa }],
    }).compileComponents();
    fixture = TestBed.createComponent(MfaEnrollComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(setup);

  it('starts on the choose step with both enrollment options', () => {
    expect(component.step()).toBe('choose');
    expect(el().querySelector('[data-testid="mfa-choose-totp"]')).toBeTruthy();
    expect(el().querySelector('[data-testid="mfa-choose-webauthn"]')).toBeTruthy();
  });

  it('startTotp shows the QR + display-once secret on success', async () => {
    mfa.enrollTotp.and.resolveTo(
      ok({ factorId: 'f1', otpauthUri: 'otpauth://totp/x?secret=ABCDEFGH', secret: 'ABCDEFGH' }),
    );
    await component.startTotp();
    fixture.detectChanges();
    expect(component.step()).toBe('totp-show');
    expect(component.secret()).toBe('ABCDEFGH');
    expect(el().querySelector('[data-testid="mfa-secret"]')?.textContent).toContain('ABCDEFGH');
    // The QR is rendered (matrix non-null) with a text alternative.
    expect(component.qrMatrix()).not.toBeNull();
    expect(el().querySelector('[data-testid="mfa-qr"]')?.getAttribute('aria-label')).toBeTruthy();
  });

  it('blocks verify until a 6-digit passcode is entered', async () => {
    mfa.enrollTotp.and.resolveTo(ok({ factorId: 'f1', otpauthUri: 'otpauth://totp/x?secret=AB', secret: 'AB' }));
    await component.startTotp();
    component.passcode = '12';
    expect(component.passcodeValid()).toBeFalse();
    component.passcode = '123456';
    expect(component.passcodeValid()).toBeTrue();
  });

  it('verifyTotp on success reveals display-once recovery codes and drops the secret', async () => {
    mfa.enrollTotp.and.resolveTo(ok({ factorId: 'f1', otpauthUri: 'otpauth://totp/x?secret=AB', secret: 'AB' }));
    await component.startTotp();
    component.passcode = '123456';
    mfa.verifyTotp.and.resolveTo(ok({ enabled: true, recoveryCodes: ['AAAA-BBBB-CCCC-DDDD'] }));
    await component.verifyTotp();
    fixture.detectChanges();
    expect(component.step()).toBe('recovery');
    expect(component.recoveryCodes()).toEqual(['AAAA-BBBB-CCCC-DDDD']);
    // Secret is no longer held client-side.
    expect(component.secret()).toBe('');
    expect(el().querySelector('[data-testid="mfa-recovery-codes"]')?.textContent).toContain('AAAA-BBBB-CCCC-DDDD');
  });

  it('verifyTotp shows a code-mismatch error on 401 (stays on the show step)', async () => {
    mfa.enrollTotp.and.resolveTo(ok({ factorId: 'f1', otpauthUri: 'otpauth://totp/x?secret=AB', secret: 'AB' }));
    await component.startTotp();
    component.passcode = '000000';
    mfa.verifyTotp.and.resolveTo(err(401));
    await component.verifyTotp();
    expect(component.step()).toBe('totp-show');
    expect(component.error()).toContain('did not match');
  });

  it('maps a 503 on enroll to the terminal DARK step (MFA not enabled)', async () => {
    mfa.enrollTotp.and.resolveTo(dark());
    await component.startTotp();
    fixture.detectChanges();
    expect(component.step()).toBe('dark');
    expect(el().querySelector('[data-testid="mfa-dark"]')).toBeTruthy();
    expect(component.error()).toBe('');
  });

  it('startWebauthn maps a 503 options response to DARK', async () => {
    mfa.enrollWebauthnOptions.and.resolveTo(dark());
    // Force the webauthn-available branch regardless of the test browser.
    (component as unknown as { webauthnAvailable: boolean }).webauthnAvailable = true;
    await component.startWebauthn();
    expect(component.step()).toBe('dark');
  });

  it('finish navigates to the security page', async () => {
    const router = TestBed.inject(Router);
    const spy = spyOn(router, 'navigateByUrl');
    component.finish();
    expect(spy).toHaveBeenCalledWith('/login/security');
  });
});
