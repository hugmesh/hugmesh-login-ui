import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
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
