import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { ActivatedRoute } from '@angular/router';
import { AppealContactService } from './appeal-contact.service';
import { BffService } from './bff.service';
import { SessionService } from './session.service';

/**
 * The mailto subject line — a stable, scannable prefix for the support inbox.
 *
 * A FUNCTION, not a `const`, and that is load-bearing. A module-scope
 * `const APPEAL_SUBJECT = $localize\`...\`` would evaluate at module IMPORT —
 * which happens when the host imports the exposed `./routes`, BEFORE the
 * localeGuard has loaded any catalog — and would be permanently, silently
 * English on an otherwise translated page. Called lazily from a computed (i.e.
 * at render), it translates correctly. `npm run i18n:check` fails the build if a
 * `$localize` ever reappears at module scope here. See src/app/i18n/locale.ts.
 */
function appealSubject(): string {
  return $localize`:Subject line pre-filled into the appeal email|@@appeal.mailto.subject:Account appeal — hugmesh.systems`;
}

/**
 * ACCESSIBLE appeal / contact page for a BANNED or SUSPENDED user.
 *
 * <p>Two distinct visitors land here, with two distinct capabilities:
 * <ul>
 *   <li>a principal with NO session at all (rejected at login; a `PROFILE` ban/
 *       suspension DOES stop a fresh sign-in from ever minting a session — see
 *       login.component's DENY handling) is hard-stopped at the gateway with no
 *       usable JWT, so there is NO authenticated endpoint to POST into for them —
 *       the canonical pattern (per hugmesh.games) is the permitAll GET
 *       appeal-contact RESOLVER + a CLIENT-SIDE `mailto:` link, which this page
 *       always renders regardless of session state;</li>
 *   <li>a principal who was ALREADY signed in when curtailed keeps a fully valid
 *       session — a `PROFILE` suspension is NOT a Casdoor-role flip, so their
 *       `bff_` session cookie still authenticates (see admin-bff's
 *       {@code AccountAppealUserController} javadoc). For THAT visitor this page
 *       ALSO shows a real structured-appeal FORM that POSTs to
 *       {@code /bff/me/appeal} and shows a genuine confirmation once the server
 *       actually recorded the row — never a fake "sent" the moment the button is
 *       clicked. The mailto stays visible as an honest fallback either way.</li>
 * </ul>
 *
 * a11y:
 *   • a proper heading (h2, labelling the landmark region) and an ordered list of
 *     steps — real heading structure, not styled text;
 *   • the email is a REAL `<a href="mailto:…">` with an explicit accessibleName
 *     (aria-label) so a screen reader announces "Email <address> to appeal",
 *     not a bare address;
 *   • an optional blocked-reason (passed as `?reason=`) is announced via
 *     role="alert" + aria-live="assertive" so it is read immediately on landing;
 *   • when the contact resolver is unreachable the page still renders the steps
 *     and tells the user the address could not be loaded (degrades, never blank);
 *   • the structured-appeal outcome (success OR failure) is announced via
 *     role="status"/"alert" — a failed submit NEVER renders as recorded.
 */
@Component({
  selector: 'hug-appeal',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  templateUrl: './appeal.component.html',
  styleUrl: './appeal.component.scss',
})
export class AppealComponent implements OnInit {
  private readonly service = inject(AppealContactService);
  private readonly bff = inject(BffService);
  private readonly session = inject(SessionService);
  private readonly route = inject(ActivatedRoute);

  /** The resolved support address, or null when the resolver was unreachable. */
  readonly email = signal<string | null>(null);
  /** False until the resolver has answered (so we don't flash "unavailable"). */
  readonly resolved = signal(false);

  /** An OPTIONAL human reason the account is blocked, deep-linked as `?reason=`
   *  by the host's banned landing. Trimmed; blank => no alert shown. */
  readonly reason = signal('');

  /** Whether a real contact address is available to mail. */
  readonly hasEmail = computed(() => !!this.email());
  /** Whether to show the "address could not be loaded" fallback (resolved + none). */
  readonly contactUnavailable = computed(() => this.resolved() && !this.email());

  /** The full `mailto:` href with a pre-filled subject (only when we have an
   *  address). encodeURIComponent keeps the subject safe in the URL. */
  readonly mailtoHref = computed(() => {
    const to = this.email();
    return to ? `mailto:${to}?subject=${encodeURIComponent(appealSubject())}` : null;
  });

  /** The accessible name for the mailto link — announces intent + address, so a
   *  screen reader says the whole action, not just a bare email string. */
  readonly mailtoAccessibleName = computed(() => {
    const to = this.email();
    return to
      ? $localize`:Accessible name of the support email link. {{PLACEHOLDER}} is the support address@@appeal.mailto.label:Email ${to}:address: to appeal your account block`
      : '';
  });

  /** Only a browser that currently holds a session can plausibly reach the
   *  authenticated POST /bff/me/appeal — a fully signed-out visitor is not shown
   *  a form that would just 401 on submit (the mailto path is their real route).
   *  A genuinely revoked session still degrades honestly via the 'unauthenticated'
   *  submit error below, this is only a UX heuristic to avoid confusing prompt. */
  readonly showAppealForm = computed(() => this.session.loggedIn());

  /** The appellant's own free-text appeal message. */
  readonly reasonInput = signal('');
  /** OPTIONAL alternate contact (the appellant may lose sign-in ability entirely
   *  before the appeal is reviewed). */
  readonly contactEmailInput = signal('');
  /** True while the submit request is in flight (disables the form / button). */
  readonly submitting = signal(false);
  /** Set once a submit resolves — true/false/null (not yet attempted). NEVER set
   *  true except on a genuine 2xx from the server (see {@link submit}). */
  readonly submitted = signal(false);
  /** Non-empty when the LAST submit attempt failed — an honest, specific reason,
   *  never a generic "something went wrong" that could be mistaken for success. */
  readonly submitError = signal('');

  async ngOnInit(): Promise<void> {
    const raw = this.route.snapshot.queryParamMap.get('reason') ?? '';
    this.reason.set(raw.trim());
    const { email } = await this.service.contact();
    this.email.set(email);
    this.resolved.set(true);
  }

  /** Submit the structured appeal. Sets {@link submitted} ONLY on a genuine
   *  server-confirmed success; any failure (no session, validation, network,
   *  server error) sets {@link submitError} instead and leaves {@link submitted}
   *  false — the mailto fallback remains the honest path in every failure case. */
  async submit(): Promise<void> {
    const reason = this.reasonInput().trim();
    if (!reason || this.submitting()) return;
    this.submitting.set(true);
    this.submitError.set('');
    try {
      const contactEmail = this.contactEmailInput().trim();
      const result = await this.bff.submitAppeal(reason, contactEmail || null);
      if (result.ok) {
        this.submitted.set(true);
      } else {
        this.submitError.set(this.describeError(result.error));
      }
    } finally {
      this.submitting.set(false);
    }
  }

  /** The submit button's label, which flips while a submit is in flight. Both
   *  strings used to be a ternary INSIDE the template — a template expression,
   *  which `i18n` cannot mark up and the extractor never sees, so they would have
   *  shipped as English on a translated page. */
  readonly submitLabel = computed(() =>
    this.submitting()
      ? $localize`:Appeal submit button label while the request is in flight|@@appeal.form.submitting:Submitting…`
      : $localize`:Appeal submit button label|@@appeal.form.submit:Submit appeal`,
  );

  private describeError(code: string | undefined): string {
    switch (code) {
      case 'unauthenticated':
        return $localize`:Appeal submit error — the browser had no usable session|@@appeal.error.unauthenticated:We could not verify a signed-in session from this browser, so the structured appeal was not recorded. Please use the email address below instead.`;
      case 'invalid':
        return $localize`:Appeal submit error — the appeal text was empty|@@appeal.error.invalid:Please describe your appeal before submitting.`;
      case 'network':
        return $localize`:Appeal submit error — the server was unreachable|@@appeal.error.network:We could not reach the server. Please try again, or use the email address below.`;
      default:
        return $localize`:Appeal submit error — any other server-side failure|@@appeal.error.unknown:Your appeal could not be recorded right now. Please try again, or use the email address below.`;
    }
  }
}
