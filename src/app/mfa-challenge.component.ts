import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { MfaService } from './mfa.service';
import { getAssertion, webauthnSupported } from './webauthn';
import { ChallengeFactor } from './mfa.types';

type Method = 'totp' | 'recovery' | 'webauthn';

/**
 * The MFA STEP-UP challenge screen. A sensitive action (removing a factor,
 * regenerating recovery codes, or any gateway-gated route) requires a FRESH
 * MFA stamp; this screen collects one of: a 6-digit TOTP code, a passkey
 * assertion (navigator.credentials.get() against `assert/webauthn/options`), or
 * a recovery code — then submits the EXISTING `POST /bff/mfa/challenge`. On
 * success the BFF stamps `mfa_satisfied` on the opaque session.
 *
 * SHIPS DARK: the BFF 503s every `/bff/mfa/*` call while the feature is dark,
 * which this screen maps to a terminal "MFA not enabled" state (never an error).
 *
 * On success it navigates to {@code ?returnTo=} (default the security page) so
 * the caller can retry the gated action with the now-fresh stamp.
 *
 * a11y: a fieldset/legend chooses the method, each input has a visible label +
 * aria-describedby helptext, and the verdict (success / failure) is announced
 * via role="alert"/aria-live.
 */
@Component({
  selector: 'hug-mfa-challenge',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './mfa-challenge.component.html',
  styleUrl: './mfa.component.scss',
})
export class MfaChallengeComponent {
  private readonly mfa = inject(MfaService);
  private readonly router = inject(Router);

  readonly method = signal<Method>('totp');
  readonly error = signal('');
  readonly busy = signal(false);
  readonly satisfied = signal(false);
  /** Set true when the BFF answered 503 — the surface is not yet launched. */
  readonly dark = signal(false);

  /** The TOTP or recovery code typed by the user. */
  code = '';

  readonly webauthnAvailable = webauthnSupported();

  /** A TOTP code must be 6 digits; a recovery code must be non-blank. A method
   *  (not a computed): `code` is a plain ngModel field, so this is re-evaluated
   *  on each template tick rather than depending on a non-reactive read. */
  codeValid(): boolean {
    const v = this.code.trim();
    if (this.method() === 'totp') return /^\d{6}$/.test(v);
    return v.length > 0;
  }

  /** The label of the code field, which depends on the chosen method. Lives here
   *  rather than as a ternary in the template: a template EXPRESSION cannot carry
   *  an `i18n` attribute and the extractor never sees it, so both strings would
   *  have shipped English on a translated page. */
  readonly codeLabel = computed(() =>
    this.method() === 'totp'
      ? $localize`:Label of the code field when verifying with an authenticator app|@@mfaChallenge.code.label.totp:6-digit code`
      : $localize`:Label of the code field when verifying with a recovery code|@@mfaChallenge.code.label.recovery:Recovery code`,
  );

  setMethod(m: Method): void {
    this.method.set(m);
    this.code = '';
    this.error.set('');
  }

  /** Submit a TOTP or recovery-code challenge. */
  async submitCode(): Promise<void> {
    if (!this.codeValid()) {
      this.error.set(
        this.method() === 'totp'
          ? $localize`:Validation error when the authenticator code is empty or malformed|@@mfaChallenge.error.totpRequired:Enter the 6-digit code from your authenticator app.`
          : $localize`:Validation error when the recovery code is empty|@@mfaChallenge.error.recoveryRequired:Enter one of your recovery codes.`,
      );
      return;
    }
    await this.send(this.method() as ChallengeFactor, this.code.trim());
  }

  /** Run a passkey assertion and submit it as a webauthn challenge. */
  async useWebauthn(): Promise<void> {
    if (!this.webauthnAvailable) {
      this.error.set($localize`:Error when passkey verification is attempted in a browser without WebAuthn|@@mfaChallenge.error.noWebauthn:This browser does not support passkeys. Use a code instead.`);
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const opts = await this.mfa.assertWebauthnOptions();
    if (opts.dark) {
      this.busy.set(false);
      this.dark.set(true);
      return;
    }
    if (!opts.ok || !opts.data) {
      this.busy.set(false);
      this.error.set(opts.error || $localize`:Error when the server would not begin passkey verification|@@mfaChallenge.error.startWebauthn:Could not start passkey verification.`);
      return;
    }
    let assertion: string;
    try {
      assertion = await getAssertion(opts.data);
    } catch (e) {
      this.busy.set(false);
      this.error.set(this.passkeyError(e));
      return;
    }
    await this.send('webauthn', assertion, true);
  }

  private async send(factor: ChallengeFactor, credential: string, alreadyBusy = false): Promise<void> {
    this.error.set('');
    if (!alreadyBusy) this.busy.set(true);
    const r = await this.mfa.challenge(factor, credential);
    this.busy.set(false);
    if (r.dark) {
      this.dark.set(true);
      return;
    }
    if (r.status === 401 || !r.ok || !r.data?.mfaSatisfied) {
      this.error.set($localize`:Error when the step-up challenge was rejected|@@mfaChallenge.error.rejected:That did not verify. Try again with a current code or your passkey.`);
      return;
    }
    this.satisfied.set(true);
    this.code = '';
    const returnTo = this.router.parseUrl(this.router.url).queryParams['returnTo'] || '/login/security';
    void this.router.navigateByUrl(returnTo);
  }

  private passkeyError(e: unknown): string {
    const name = (e as { name?: string })?.name;
    if (name === 'NotAllowedError')
      return $localize`:Error when the user dismissed the browser's passkey prompt during verification|@@mfaChallenge.error.webauthnCancelled:Passkey verification was cancelled or timed out.`;
    return (
      (e as { message?: string })?.message ||
      $localize`:Fallback error when the browser could not verify with a passkey|@@mfaChallenge.error.webauthnUnknown:Could not verify with a passkey.`
    );
  }
}
