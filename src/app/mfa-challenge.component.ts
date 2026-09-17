import { Component, computed, inject, input, output, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { MfaService } from './mfa.service';
import { getAssertion, webauthnSupported } from './webauthn';
import { ChallengeFactor } from './mfa.types';

type Method = 'totp' | 'recovery' | 'webauthn';

/**
 * THE MFA STEP-UP CHALLENGE — the platform's ONE implementation.
 *
 * A sensitive action (removing a factor, regenerating recovery codes, locking a
 * forum topic, any gateway- or BFF-gated route) requires a FRESH MFA stamp. This
 * component collects one of: a 6-digit TOTP code, a passkey assertion
 * (`navigator.credentials.get()` against `assert/webauthn/options`), or a
 * recovery code — then submits the EXISTING `POST /bff/mfa/challenge`. On success
 * the BFF stamps `mfa_satisfied` on the caller's own opaque session, and this
 * component emits {@link satisfied}. Nothing is handed back to the caller and
 * nothing needs to be: the caller simply RETRIES the same gated action, which
 * now passes because the server reads a fresh stamp off the session.
 *
 * IT IS USED IN TWO PLACES AND HAS TWO PLACES ONLY:
 *  1. {@link MfaChallengePageComponent} — the routed `/login/mfa/challenge` page,
 *     which owns the `?returnTo=` navigation and the back-to-sign-in link.
 *  2. The federated `./mfa-step-up` module (see `mfa-step-up.ts`), which forum,
 *     mod and wiki `loadRemoteModule` and render INLINE, so a refused action is
 *     retried in place with no navigation. hugmesh-generator#347 decision 21
 *     ("B: login-ui federates one dialog") is exactly this: one implementation,
 *     three consumers, no copies.
 *
 * IT NAVIGATES NOWHERE, BY CONSTRUCTION. It injects no `Router` and its template
 * carries no `routerLink`. That is load-bearing for the federated use: under the
 * host shell the injected Router is the SHELL'S, rooted at `/`, so an absolute
 * in-component link or navigate() would move the whole page out from under the
 * consumer that embedded this (the second of the four federated-remote URL traps
 * this fleet has already paid for). Navigation is the CALLER's decision and lives
 * in the caller. `tools/federation/check-exposes.mjs` fails the build if any
 * module reachable from the exposed entry re-acquires `@angular/router`.
 *
 * SHIPS DARK: the BFF 503s every `/bff/mfa/*` call while `app.casdoor.mfa.enabled
 * =false`. That is mapped to a terminal "MFA not enabled" state — never an error
 * — and announced to the caller once via {@link unavailable}, so the caller can
 * fall back to whatever non-MFA path it already has (forum-ui's `?returnTo=`
 * link, admin's manual token field). No escape affordance is rendered here in
 * that state: what "back" means belongs to the surface that embedded this.
 *
 * a11y: a fieldset/legend chooses the method, each input has a visible label +
 * aria-describedby helptext, and the verdict (success / failure) is announced via
 * role="alert"/aria-live. This is a plain in-flow `<section>`, not a native
 * `<dialog>` or modal overlay, so it composes with each console's own layout and
 * testing conventions — the caller decides where to render it (typically right
 * above the control it gates).
 */
@Component({
  selector: 'hug-mfa-challenge',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './mfa-challenge.component.html',
  styleUrl: './mfa.component.scss',
})
export class MfaChallengeComponent {
  private readonly mfa = inject(MfaService);

  /**
   * Optional short description of the action being gated, spliced into a second
   * intro sentence ("…to lock this topic."). Empty (the default) renders no
   * extra sentence, which is what the routed page wants — it has no single
   * action to name.
   */
  readonly action = input<string>('');

  /**
   * Whether to offer a "Not now" cancel button. TRUE by default because the
   * EMBEDDED use is the one that needs it — a dialog a consumer opened in place
   * must be closable, and a consumer that forgot to ask for the button would
   * otherwise strand the user. The routed page opts OUT (`[cancellable]="false"`)
   * and keeps its own back link, so that surface is unchanged.
   */
  readonly cancellable = input<boolean>(true);

  /**
   * The challenge succeeded: the caller's session now carries a FRESH
   * `mfa_satisfied` stamp. The caller should retry the SAME gated action —
   * blindly, with no extra header or token — and then dismiss this component.
   */
  readonly satisfied = output<void>();

  /** The user backed out ("Not now"). The caller should dismiss this component
   *  and NOT retry. */
  readonly dismissed = output<void>();

  /**
   * The MFA surface answered 503 — the feature ships dark platform-wide. Emitted
   * ONCE, on the first 503 seen. The caller should fall back to its own non-MFA
   * path; this component renders the terminal "not enabled yet" message and
   * offers no affordance of its own.
   */
  readonly unavailable = output<void>();

  readonly method = signal<Method>('totp');
  readonly error = signal('');
  readonly busy = signal(false);
  /** The challenge was accepted (renders the terminal "Verified" notice). Named
   *  apart from the {@link satisfied} OUTPUT so the two cannot be confused. */
  readonly verified = signal(false);
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

  /** Back out without verifying. Clears any typed credential first — a cancelled
   *  dialog that is re-opened must not still hold the last code. */
  cancel(): void {
    this.error.set('');
    this.code = '';
    this.dismissed.emit();
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
      this.goDark();
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
      this.goDark();
      return;
    }
    if (r.status === 401 || !r.ok || !r.data?.mfaSatisfied) {
      this.error.set($localize`:Error when the step-up challenge was rejected|@@mfaChallenge.error.rejected:That did not verify. Try again with a current code or your passkey.`);
      return;
    }
    this.verified.set(true);
    this.code = '';
    this.satisfied.emit();
  }

  /** Enter the terminal dark state and tell the caller ONCE. Both 503 paths (the
   *  challenge POST and the webauthn options GET) land here, and a second 503
   *  must not emit again — a caller that swapped in its own fallback should not
   *  be re-notified by a component it has stopped looking at. */
  private goDark(): void {
    if (this.dark()) return;
    this.dark.set(true);
    this.unavailable.emit();
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
