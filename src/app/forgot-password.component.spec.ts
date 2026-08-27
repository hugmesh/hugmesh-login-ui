import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { ForgotPasswordComponent } from './forgot-password.component';
import { BffService, PasswordResetResult } from './bff.service';

/**
 * The forgot-password page's contract, weighted toward what it must REFUSE to say.
 *
 * Three properties are load-bearing and each is asserted from both sides:
 *   1. the page never confirms whether an account exists (the BFF flattens that on
 *      purpose; a UI that leaked it would hand the oracle straight back);
 *   2. the page never claims a reset it did not observe — `done` requires a genuine 2xx;
 *   3. the page never discards the server's reason for a failure, which is exactly the
 *      habit (`Could not save your profile. Please try again.`) that made this class of
 *      bug undiagnosable on the sibling profile page.
 */
describe('ForgotPasswordComponent', () => {
  let fixture: ComponentFixture<ForgotPasswordComponent>;
  let component: ForgotPasswordComponent;
  let bff: jasmine.SpyObj<BffService>;

  async function setup(): Promise<void> {
    bff = jasmine.createSpyObj<BffService>('BffService', [
      'requestPasswordReset',
      'confirmPasswordReset',
    ]);

    await TestBed.configureTestingModule({
      imports: [ForgotPasswordComponent],
      providers: [provideRouter([]), { provide: BffService, useValue: bff }],
    }).compileComponents();

    fixture = TestBed.createComponent(ForgotPasswordComponent);
    component = fixture.componentInstance;
    fixture.detectChanges();
  }

  beforeEach(setup);

  function el(): HTMLElement {
    return fixture.nativeElement as HTMLElement;
  }
  function byTestId(id: string): HTMLElement | null {
    return el().querySelector(`[data-testid="${id}"]`);
  }
  function text(): string {
    return el().textContent ?? '';
  }

  /** Drive leg 1 to completion with a given server answer. */
  async function request(answer: PasswordResetResult, username = 'alice'): Promise<void> {
    bff.requestPasswordReset.and.resolveTo(answer);
    component.username.set(username);
    await component.submitRequest();
    fixture.detectChanges();
  }

  /** Get to the confirm form, then drive leg 2 with a given server answer. */
  async function confirm(answer: PasswordResetResult): Promise<void> {
    await request({ ok: true });
    bff.confirmPasswordReset.and.resolveTo(answer);
    component.code.set('123456');
    component.newPassword.set('s3cret-enough');
    await component.submitConfirm();
    fixture.detectChanges();
  }

  // ══ initial state ════════════════════════════════════════════════════════

  it('starts on the request step with the username form rendered', () => {
    expect(component.step()).toBe('request');
    expect(byTestId('forgot-username')).toBeTruthy();
    expect(byTestId('forgot-code')).toBeNull();
  });

  it('links back to sign-in so a user who arrived by mistake is not trapped', () => {
    expect(byTestId('forgot-cancel')).toBeTruthy();
  });

  it('cannot submit an empty or whitespace-only username', () => {
    expect(component.canRequest()).toBe(false);
    component.username.set('   ');
    expect(component.canRequest()).toBe(false);
    component.username.set('alice');
    expect(component.canRequest()).toBe(true);
  });

  it('does not call the server for a blank username', async () => {
    component.username.set('  ');
    await component.submitRequest();
    expect(bff.requestPasswordReset).not.toHaveBeenCalled();
  });

  it('trims the username before sending it', async () => {
    await request({ ok: true }, '  alice  ');
    expect(bff.requestPasswordReset).toHaveBeenCalledWith('alice');
  });

  // ══ 1. THE PAGE NEVER CONFIRMS WHETHER AN ACCOUNT EXISTS ═════════════════

  it('advances to the code form on success', async () => {
    await request({ ok: true });
    expect(component.step()).toBe('confirm');
    expect(byTestId('forgot-code')).toBeTruthy();
  });

  /**
   * THE HEADLINE. The BFF answers a real and a non-existent account identically, so this
   * page cannot tell them apart — and must not appear to. The confirmation copy is
   * conditional ("if that account exists") precisely so it stays true in both cases.
   */
  it('phrases the sent-confirmation conditionally, never asserting the account exists', async () => {
    await request({ ok: true }, 'definitely-not-a-user');
    const sent = byTestId('forgot-sent');
    expect(sent).toBeTruthy();
    expect(sent!.textContent).toContain('If that account exists');
    // No echo of the username or any address — either would be the oracle.
    expect(sent!.textContent).not.toContain('definitely-not-a-user');
    expect(sent!.textContent).not.toContain('@');
  });

  it('renders the SAME sent-confirmation for two different usernames', async () => {
    // Driven through startOver() rather than a second TestBed setup, so BOTH renders come
    // from one fixture and the comparison is of the rendered DOM, not of two components.
    await request({ ok: true }, 'alice');
    const first = byTestId('forgot-sent')!.textContent;

    component.startOver();
    fixture.detectChanges();
    await request({ ok: true }, 'nobody-at-all');

    expect(byTestId('forgot-sent')!.textContent).toBe(first);
  });

  // ══ 2. NEVER CLAIM A RESET THAT WAS NOT OBSERVED ═════════════════════════

  it('reaches done ONLY on a server-confirmed reset', async () => {
    await confirm({ ok: true });
    expect(component.step()).toBe('done');
    expect(byTestId('forgot-done')).toBeTruthy();
  });

  it('stays on the confirm form when the reset was REFUSED', async () => {
    await confirm({ ok: false, error: 'invalid', message: 'that code is not valid' });
    expect(component.step()).toBe('confirm');
    expect(byTestId('forgot-done')).toBeNull();
    // The code field is still there, so the user can correct and retry.
    expect(byTestId('forgot-code')).toBeTruthy();
  });

  it('never renders the success notice alongside an error', async () => {
    await confirm({ ok: false, error: 'server', message: 'refused' });
    expect(byTestId('forgot-error')).toBeTruthy();
    expect(byTestId('forgot-done')).toBeNull();
  });

  it('clears the new password and code from memory after a successful reset', async () => {
    await confirm({ ok: true });
    expect(component.newPassword()).toBe('');
    expect(component.code()).toBe('');
  });

  it('does NOT clear the typed password after a FAILED reset (the user retries)', async () => {
    await confirm({ ok: false, error: 'invalid', message: 'nope' });
    expect(component.newPassword()).toBe('s3cret-enough');
  });

  // ══ 3. NEVER DISCARD THE SERVER'S REASON ═════════════════════════════════

  it("renders the server's own message verbatim for a refused reset", async () => {
    await confirm({
      ok: false,
      error: 'invalid',
      message: 'we could not complete that reset — the code may have expired',
    });
    expect(byTestId('forgot-error')!.textContent).toContain('the code may have expired');
  });

  it('falls back to an honest local message ONLY when the server gave none', async () => {
    await confirm({ ok: false, error: 'network' });
    const shown = byTestId('forgot-error')!.textContent ?? '';
    expect(shown).toContain('could not reach the server');
  });

  it('ignores the bare "validation failed" envelope in favour of a useful message', async () => {
    // The BFF's field-validation shape is { error: "validation failed", fields: {...} } —
    // passing that string through verbatim would tell the user nothing at all.
    await confirm({ ok: false, error: 'invalid', message: 'validation failed' });
    expect(byTestId('forgot-error')!.textContent).not.toContain('validation failed');
    expect(byTestId('forgot-error')!.textContent).toContain('check the details');
  });

  it('announces failures assertively so a screen reader hears them immediately', async () => {
    await confirm({ ok: false, error: 'server', message: 'refused' });
    const err = byTestId('forgot-error')!;
    expect(err.getAttribute('role')).toBe('alert');
    expect(err.getAttribute('aria-live')).toBe('assertive');
  });

  it('announces the success notice politely', async () => {
    await confirm({ ok: true });
    expect(byTestId('forgot-done')!.getAttribute('role')).toBe('status');
  });

  // ══ DARK IS A THIRD OUTCOME, NOT A FAILURE ═══════════════════════════════

  it('treats a dark request leg as terminal and points at support, not at "try again"', async () => {
    await request({ ok: false, dark: true, error: 'unavailable' });
    expect(component.dark()).toBe(true);
    expect(byTestId('forgot-dark')).toBeTruthy();
    expect(byTestId('forgot-appeal-link')).toBeTruthy();
    // The form is gone: retrying could never work on this mesh.
    expect(byTestId('forgot-username')).toBeNull();
    expect(text()).toContain('contact an administrator');
  });

  it('treats a dark confirm leg as terminal too', async () => {
    await confirm({ ok: false, dark: true, error: 'unavailable' });
    expect(component.dark()).toBe(true);
    expect(byTestId('forgot-dark')).toBeTruthy();
    expect(byTestId('forgot-code')).toBeNull();
    // and NEVER as a success
    expect(component.step()).not.toBe('done');
  });

  it('does not render a dark notice on an ordinary failure', async () => {
    await request({ ok: false, error: 'server' });
    expect(component.dark()).toBe(false);
    expect(byTestId('forgot-dark')).toBeNull();
    expect(byTestId('forgot-username')).toBeTruthy();
  });

  // ══ leg-2 guards ═════════════════════════════════════════════════════════

  it('cannot confirm without BOTH a code and a new password', async () => {
    await request({ ok: true });
    expect(component.canConfirm()).toBe(false);
    component.code.set('123456');
    expect(component.canConfirm()).toBe(false);
    component.newPassword.set('s3cret-enough');
    expect(component.canConfirm()).toBe(true);
  });

  it('does not call the server when the confirm form is incomplete', async () => {
    await request({ ok: true });
    component.code.set('123456');
    await component.submitConfirm();
    expect(bff.confirmPasswordReset).not.toHaveBeenCalled();
  });

  /**
   * CROSS-ACCOUNT GUARD. The username is captured on leg 1 and REUSED on leg 2 — it is
   * never re-read from a second input. A user therefore cannot redeem a code against an
   * account other than the one they requested it for, even by editing the page.
   */
  it('redeems the code against the SAME username the code was requested for', async () => {
    await confirm({ ok: true });
    expect(bff.confirmPasswordReset).toHaveBeenCalledWith('alice', '123456', 's3cret-enough');
  });

  it('renders no second username input on the confirm step', async () => {
    await request({ ok: true });
    expect(el().querySelectorAll('input[name="username"]').length).toBe(0);
  });

  // ══ start over ═══════════════════════════════════════════════════════════

  /**
   * MUTATION-DRIVEN. Deleting the start-over BUTTON from the template survived the first
   * battery: startOver() was tested as a method but nothing asserted it was reachable. A
   * user whose code never arrives (mistyped username, mail delayed, no SMTP) would then be
   * stranded on a confirm form with no way back — the same "flow nobody can find" failure
   * as a missing link, one screen further in.
   */
  it('renders the start-over button on the confirm step (the escape hatch is reachable)', async () => {
    await request({ ok: true });
    const button = byTestId('forgot-start-over');
    expect(button).toBeTruthy();
    expect(button!.tagName).toBe('BUTTON');
  });

  it('start over is clickable and returns to the request form', async () => {
    await request({ ok: true });
    component.code.set('123456');
    (byTestId('forgot-start-over') as HTMLButtonElement).click();
    fixture.detectChanges();

    expect(component.step()).toBe('request');
    expect(component.code()).toBe('');
    expect(byTestId('forgot-username')).toBeTruthy();
  });

  it('start over returns to the request form and drops the stale code', async () => {
    await request({ ok: true });
    component.code.set('123456');
    component.newPassword.set('s3cret-enough');
    component.startOver();
    fixture.detectChanges();

    expect(component.step()).toBe('request');
    expect(component.code()).toBe('');
    expect(component.newPassword()).toBe('');
    expect(byTestId('forgot-username')).toBeTruthy();
  });

  it('start over clears a previous error', async () => {
    await confirm({ ok: false, error: 'invalid', message: 'nope' });
    component.startOver();
    fixture.detectChanges();
    expect(component.error()).toBe('');
    expect(byTestId('forgot-error')).toBeNull();
  });

  // ══ in-flight ════════════════════════════════════════════════════════════

  it('blocks a second submit while one is in flight', async () => {
    let release!: (r: PasswordResetResult) => void;
    bff.requestPasswordReset.and.returnValue(
      new Promise<PasswordResetResult>((resolve) => (release = resolve)),
    );
    component.username.set('alice');
    const inFlight = component.submitRequest();

    expect(component.busy()).toBe(true);
    expect(component.canRequest()).toBe(false);
    await component.submitRequest(); // must be a no-op
    expect(bff.requestPasswordReset).toHaveBeenCalledTimes(1);

    release({ ok: true });
    await inFlight;
    expect(component.busy()).toBe(false);
  });

  it('clears busy even when the call rejects, so the form is never wedged', async () => {
    bff.requestPasswordReset.and.rejectWith(new Error('boom'));
    component.username.set('alice');
    await expectAsync(component.submitRequest()).toBeRejected();
    expect(component.busy()).toBe(false);
  });

  it('flips the button label while in flight (a computed, not a template ternary)', () => {
    const idle = component.requestLabel();
    component.busy.set(true);
    expect(component.requestLabel()).not.toBe(idle);
    expect(component.requestLabel()).toContain('Sending');
  });
});
