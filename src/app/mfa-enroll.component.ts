import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MfaService } from './mfa.service';
import { encodeQr } from './qr';
import { createPasskey, webauthnSupported } from './webauthn';
import { SessionService } from './session.service';

/** The wizard steps. `dark` is terminal: the feature is not yet launched.
 *  The TOTP QR and its 6-digit verify input live on the SAME `totp-show` step. */
type Step = 'choose' | 'totp-show' | 'recovery' | 'done' | 'dark';

/**
 * The MFA ENROLLMENT wizard (D6+D8). Reachable ONLY when the MFA surface is
 * live — the host gates the route on the session/feature signal AND the BFF
 * 503s every `/bff/mfa/*` call while dark, which this wizard maps to a terminal
 * "MFA not enabled" step (never an error).
 *
 * Two enrollment paths:
 *   • TOTP — start enrollment (`enroll/totp`), render the otpauthUri as a
 *     scannable QR + a copyable base32 secret (shown ONCE), then verify a
 *     6-digit code (`enroll/totp/verify`) which enables the factor and reveals
 *     the display-once recovery codes.
 *   • WebAuthn passkey — request options (`enroll/webauthn/options`), run
 *     navigator.credentials.create(), submit the attestation
 *     (`enroll/webauthn/verify`).
 *
 * a11y: real heading structure (h2 region label + per-step h3), the QR carries a
 * text alternative + the secret is also shown as copyable text (never QR-only),
 * inputs have visible labels + aria-describedby helptext, errors are
 * role="alert"/aria-live, and the display-once recovery codes are announced as a
 * region so a screen-reader user is told to save them now.
 */
@Component({
  selector: 'hug-mfa-enroll',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './mfa-enroll.component.html',
  styleUrl: './mfa.component.scss',
})
export class MfaEnrollComponent {
  private readonly mfa = inject(MfaService);
  private readonly session = inject(SessionService);
  private readonly router = inject(Router);

  readonly step = signal<Step>('choose');
  readonly error = signal('');
  readonly busy = signal(false);

  /** The display-once base32 secret + otpauthUri (cleared after the show step). */
  readonly secret = signal('');
  readonly otpauthUri = signal('');
  /** The display-once recovery codes (10) — shown once on the recovery step. */
  readonly recoveryCodes = signal<string[]>([]);

  /** The verification code the user keys from their authenticator app. */
  passcode = '';

  /** Whether passkeys are usable in this browser (else the option is disabled). */
  readonly webauthnAvailable = webauthnSupported();

  /** The QR module matrix for the otpauthUri (boolean[y][x], true === dark), or
   *  null when there is nothing to render / encoding failed (we still show the
   *  secret text, so a QR failure never blocks enrollment). */
  readonly qrMatrix = computed<boolean[][] | null>(() => {
    const uri = this.otpauthUri();
    if (!uri) return null;
    try {
      return encodeQr(uri);
    } catch {
      return null;
    }
  });

  /** A 6-digit numeric passcode is required before verify is allowed. A method
   *  (not a computed): `passcode` is a plain ngModel field, so this re-evaluates
   *  on each template tick rather than depending on a non-reactive read. */
  passcodeValid(): boolean {
    return /^\d{6}$/.test(this.passcode.trim());
  }

  // ---- TOTP ---------------------------------------------------------------

  async startTotp(): Promise<void> {
    this.error.set('');
    this.busy.set(true);
    const r = await this.mfa.enrollTotp();
    this.busy.set(false);
    if (r.dark) return this.goDark();
    if (!r.ok || !r.data)
      return this.fail(r.error || $localize`:Error when starting authenticator-app enrollment failed|@@mfaEnroll.error.startTotp:Could not start authenticator setup.`);
    this.secret.set(r.data.secret);
    this.otpauthUri.set(r.data.otpauthUri);
    this.step.set('totp-show');
  }

  async verifyTotp(): Promise<void> {
    if (!this.passcodeValid()) {
      this.error.set($localize`:Validation error when the enrollment passcode field is empty or malformed|@@mfaEnroll.error.passcodeRequired:Enter the 6-digit code from your authenticator app.`);
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const r = await this.mfa.verifyTotp(this.passcode.trim());
    this.busy.set(false);
    if (r.dark) return this.goDark();
    if (r.status === 401)
      return this.fail($localize`:Error when the TOTP code was wrong or expired|@@mfaEnroll.error.codeMismatch:That code did not match — try the current code.`);
    if (!r.ok || !r.data)
      return this.fail(r.error || $localize`:Error when the enrollment passcode did not verify|@@mfaEnroll.error.verify:Could not verify the code.`);
    // Stop holding the secret once the factor is enabled (display-once is over).
    this.secret.set('');
    this.otpauthUri.set('');
    this.passcode = '';
    this.recoveryCodes.set(r.data.recoveryCodes ?? []);
    this.step.set('recovery');
  }

  // ---- WebAuthn -----------------------------------------------------------

  async startWebauthn(): Promise<void> {
    if (!this.webauthnAvailable) {
      this.error.set($localize`:Error when passkey enrollment is attempted in a browser without WebAuthn|@@mfaEnroll.error.noWebauthn:This browser does not support passkeys. Use an authenticator app instead.`);
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const opts = await this.mfa.enrollWebauthnOptions();
    if (opts.dark) {
      this.busy.set(false);
      return this.goDark();
    }
    if (!opts.ok || !opts.data) {
      this.busy.set(false);
      return this.fail(opts.error || $localize`:Error when the server would not begin passkey registration|@@mfaEnroll.error.startWebauthn:Could not start passkey registration.`);
    }
    let attestation: string;
    try {
      attestation = await createPasskey(opts.data, this.session.session()?.label ?? '');
    } catch (e) {
      this.busy.set(false);
      return this.fail(this.passkeyError(e));
    }
    const verify = await this.mfa.verifyWebauthn(attestation);
    this.busy.set(false);
    if (verify.dark) return this.goDark();
    if (verify.status === 409)
      return this.fail($localize`:Error when the offered passkey is already enrolled|@@mfaEnroll.error.passkeyDuplicate:That passkey is already registered.`);
    if (!verify.ok)
      return this.fail(verify.error || $localize`:Error when the server rejected the new passkey|@@mfaEnroll.error.verifyWebauthn:Passkey registration could not be verified.`);
    this.step.set('done');
  }

  // ---- navigation / helpers ----------------------------------------------

  finish(): void {
    void this.router.navigateByUrl('/login/security');
  }

  reset(): void {
    this.error.set('');
    this.secret.set('');
    this.otpauthUri.set('');
    this.recoveryCodes.set([]);
    this.passcode = '';
    this.step.set('choose');
  }

  private goDark(): void {
    this.error.set('');
    this.step.set('dark');
  }

  private fail(message: string): void {
    this.error.set(message);
  }

  private passkeyError(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === 'NotAllowedError')
      return $localize`:Error when the user dismissed the browser's passkey prompt during enrollment|@@mfaEnroll.error.webauthnCancelled:Passkey registration was cancelled or timed out.`;
    return (
      (e as { message?: string })?.message ||
      $localize`:Fallback error when the browser could not create a passkey|@@mfaEnroll.error.webauthnUnknown:Could not create a passkey.`
    );
  }
}
