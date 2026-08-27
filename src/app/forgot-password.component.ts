import { Component, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { BffService } from './bff.service';

/** Which of the two legs the page is showing. `request` asks for a code, `confirm`
 *  redeems it, `done` is the terminal success. A single signal rather than three
 *  booleans, so the three states cannot contradict each other. */
export type ResetStep = 'request' | 'confirm' | 'done';

/**
 * THE FORGOT-PASSWORD PAGE — the surface a user who cannot sign in actually reaches.
 *
 * <p>Before this existed there was no route to it anywhere in the platform: the only
 * credential-write surface was the AUTHENTICATED profile change, which needs a live
 * session and the CURRENT password. This page pairs with user-bff's anonymous
 * `/bff/password-reset/request` + `/bff/password-reset/confirm`.
 *
 * <h2>What this page must never do</h2>
 *
 * <ul>
 *   <li><b>Never confirm whether an account exists.</b> The BFF answers the request leg
 *       identically for a known and an unknown username, on purpose. That guarantee is
 *       only worth anything if the UI honours it, so {@link submitRequest} advances to the
 *       code form on ANY success and the confirmation copy says a code has been sent "if
 *       that account exists" — never "check alice@…", never "we found your account".</li>
 *   <li><b>Never report a success it did not observe.</b> {@link step} only reaches
 *       `'done'` on a genuine 2xx from the confirm leg. A user who is wrongly told their
 *       password was reset will try to sign in with a password that was never set and have
 *       no idea which of the two steps betrayed them.</li>
 *   <li><b>Never discard the server's reason.</b> A failed confirm renders the BFF's own
 *       (already flattened, non-revealing) message. The sibling profile page's
 *       `Could not save your profile. Please try again.` — which throws away the server's
 *       reason for every distinct failure — is exactly the habit that made this class of
 *       bug undiagnosable, and it is not repeated here.</li>
 * </ul>
 *
 * <h2>Dark is a THIRD outcome, not a failure</h2>
 *
 * <p>A 503 means this mesh has no reset at all (the surface ships dark, and Casdoor SMTP
 * is absent-by-default). Telling that user to "try again" would loop them forever, so
 * {@link dark} is its own terminal state that points at the appeal/contact page instead.
 *
 * <h2>a11y</h2>
 * <ul>
 *   <li>a real `h2` labelling the landmark, and a real `form` per step;</li>
 *   <li>every outcome — sent, reset, failed, dark — is announced: `role="status"` for
 *       progress, `role="alert"` + `aria-live="assertive"` for a failure;</li>
 *   <li>the code field is `inputmode="numeric"` + `autocomplete="one-time-code"` so a
 *       phone offers the mailed code directly;</li>
 *   <li>the new-password field is `autocomplete="new-password"`, so a password manager
 *       offers to generate and store rather than to autofill the old one;</li>
 *   <li>button labels flip via a computed (never a template ternary, which the i18n
 *       extractor cannot see — see appeal.component.ts's submitLabel).</li>
 * </ul>
 */
@Component({
  selector: 'hug-forgot-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './forgot-password.component.html',
  styleUrl: './forgot-password.component.scss',
})
export class ForgotPasswordComponent {
  private readonly bff = inject(BffService);

  /** Which leg is on screen. Never advanced except on a server-confirmed outcome. */
  readonly step = signal<ResetStep>('request');
  /** True while a request is in flight (disables the form and flips the button label). */
  readonly busy = signal(false);
  /** Terminal: this mesh has no password reset at all (a 503 from either leg). */
  readonly dark = signal(false);
  /** Non-empty when the LAST attempt failed — an honest reason, never rendered as success. */
  readonly error = signal('');

  /** The account name. Captured on leg 1 and REUSED on leg 2 (the confirm call needs it),
   *  so the user does not retype it and cannot accidentally redeem a code against a
   *  different account than the one they asked for. */
  readonly username = signal('');
  /** The mailed one-time code. */
  readonly code = signal('');
  /** The replacement password. */
  readonly newPassword = signal('');

  /** Leg 1 is submittable once a non-blank username is typed and nothing is in flight. */
  readonly canRequest = computed(() => !this.busy() && this.username().trim().length > 0);
  /** Leg 2 needs both the code and a new password. Length is left to the server: it owns
   *  the policy, and a client-side floor that disagreed would refuse valid passwords. */
  readonly canConfirm = computed(
    () => !this.busy() && this.code().trim().length > 0 && this.newPassword().length > 0,
  );

  /** Leg-1 button label. A computed, not a template ternary — a ternary inside the
   *  template is an expression the i18n extractor never sees, so both strings would ship
   *  English on a translated page (the documented hazard in appeal.component.ts). */
  readonly requestLabel = computed(() =>
    this.busy()
      ? $localize`:Forgot-password request button label while the request is in flight|@@forgot.request.submitting:Sending…`
      : $localize`:Forgot-password request button label|@@forgot.request.submit:Send reset code`,
  );

  /** Leg-2 button label; same reasoning as {@link requestLabel}. */
  readonly confirmLabel = computed(() =>
    this.busy()
      ? $localize`:Forgot-password confirm button label while the request is in flight|@@forgot.confirm.submitting:Resetting…`
      : $localize`:Forgot-password confirm button label|@@forgot.confirm.submit:Set new password`,
  );

  /**
   * Leg 1 — ask for a code. Advances to the confirm form on ANY success, because the
   * server deliberately does not tell us whether the account exists and this page must not
   * pretend to know better.
   */
  async submitRequest(): Promise<void> {
    if (!this.canRequest()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.bff.requestPasswordReset(this.username().trim());
      if (result.dark) {
        this.dark.set(true);
        return;
      }
      if (result.ok) {
        this.step.set('confirm');
      } else {
        this.error.set(this.describe(result.error, result.message));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Leg 2 — redeem the code. Reaches `'done'` ONLY on a server-confirmed reset; every
   * failure leaves the user on this form with the server's own reason and their code
   * intact, so a mistyped password does not cost them the code.
   */
  async submitConfirm(): Promise<void> {
    if (!this.canConfirm()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const result = await this.bff.confirmPasswordReset(
        this.username().trim(),
        this.code().trim(),
        this.newPassword(),
      );
      if (result.dark) {
        this.dark.set(true);
        return;
      }
      if (result.ok) {
        this.step.set('done');
        // The new password must not linger in a signal once it has served its purpose.
        this.newPassword.set('');
        this.code.set('');
      } else {
        this.error.set(this.describe(result.error, result.message));
      }
    } finally {
      this.busy.set(false);
    }
  }

  /** Back to leg 1 — for a user whose code never arrived. Clears the code so the next
   *  attempt cannot silently reuse a stale one. */
  startOver(): void {
    this.code.set('');
    this.newPassword.set('');
    this.error.set('');
    this.step.set('request');
  }

  /**
   * Turn a failure into copy. The SERVER'S OWN message wins whenever there is one: the BFF
   * has already flattened it to a single sentence that distinguishes neither the account
   * nor the code, so passing it through leaks nothing and is far more useful than a
   * generic retry prompt. The local strings below are only for failures the server never
   * got to answer.
   */
  private describe(code: string | undefined, message: string | undefined): string {
    if (message && message.trim() && message !== 'validation failed') {
      return message;
    }
    switch (code) {
      case 'network':
        return $localize`:Forgot-password error — the server was unreachable|@@forgot.error.network:We could not reach the server. Please check your connection and try again.`;
      case 'invalid':
        return $localize`:Forgot-password error — the submitted details were rejected|@@forgot.error.invalid:Please check the details you entered and try again.`;
      default:
        return $localize`:Forgot-password error — any other server-side failure|@@forgot.error.unknown:That did not work. Please try again in a moment.`;
    }
  }
}
