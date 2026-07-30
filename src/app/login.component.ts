import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { BffService, RegistrationIdentity } from './bff.service';
import { SessionService } from './session.service';
import { HardNavigationService } from './hard-navigation.service';
import { LocalAgentService, LocalRole } from './local-agent.service';
import { RolePickerComponent } from './role-picker.component';
import { LoginBannerComponent } from './login-banner.component';
import { accessibleName, defaultScreenReaderName, isPrintableAscii } from './accessible-name';

/**
 * Inline prompt shown when the chosen display name cannot be announced cleanly.
 *
 * A FUNCTION, not a module-level `const`, and that is load-bearing. A module-scope
 * `const SCREEN_READER_PROMPT = $localize\`...\`` evaluates at module IMPORT — which
 * happens when the host imports the exposed `./routes`, BEFORE the localeGuard has
 * loaded a catalog — so it would be permanently, silently English on an otherwise
 * translated page. Called lazily (from a getter and from complete()), it translates
 * correctly. `npm run i18n:check` fails the build if a `$localize` reappears at
 * module scope here. See src/app/i18n/locale.ts for the full timing argument.
 */
function screenReaderPrompt(): string {
  return $localize`:Prompt shown when a display name contains characters a screen reader cannot announce|@@login.complete.screenReaderName.prompt:Your display name contains characters a screen reader cannot announce cleanly; enter an ASCII version.`;
}

/**
 * Login / register micro-frontend (own repo: hugmesh-login-ui).
 *
 * THIS remote's OWN username/password form is the ONLY login surface — the
 * browser is NEVER redirected to Casdoor. The form POSTs `{ username, password }`
 * to `POST /bff/login` (user-bff, via the gateway) with `credentials: 'include'`;
 * the BFF drives Casdoor's INTERNAL login + PKCE code exchange SERVER-SIDE and
 * mints the opaque `bff_` session cookie (Set-Cookie). The browser therefore
 * never holds a JWT/access/refresh token — only the httpOnly cookie.
 *
 * When the BFF answers `{ mfaRequired:true }` the view renders an MFA challenge
 * (a passcode field) and RE-POSTs the same `/bff/login` call with the passcode.
 *
 * Registration is a TWO-STAGE flow: after a successful sign-in that has NOT yet
 * completed registration ({@link SessionService.fullyRegistered} false), the view
 * switches to the "Complete registration" card. That step captures a visible
 * {@link displayName} (UTF-8) and, when that name is NOT pure printable-ASCII,
 * REQUIRES an ASCII {@link screenReaderName} so a screen reader has something
 * clean to announce (mirrors the server `ScreenReaderNames` rule).
 */
@Component({
  selector: 'hug-login',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink, LoginBannerComponent, RolePickerComponent],
  templateUrl: './login.component.html',
  styleUrl: './login.component.scss',
})
export class LoginComponent implements OnInit {
  private readonly bff = inject(BffService);
  private readonly hardNav = inject(HardNavigationService);
  private readonly localAgent = inject(LocalAgentService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  readonly session = inject(SessionService);

  /** The native sign-in credentials typed into our own form. */
  username = '';
  password = '';
  /** The MFA passcode typed on the `mfaRequired` challenge (re-POSTed to /bff/login). */
  mfaCode = '';

  readonly error = signal('');
  /** True while a /bff/login round-trip is in flight (disables the submit). */
  readonly busy = signal(false);
  /** Set once the BFF answered `mfaRequired:true` — the view swaps to the MFA
   *  challenge and the next submit re-POSTs with the passcode. */
  readonly mfaRequired = signal(false);
  /** The MFA factor types the BFF offered (echoed back on the passcode re-POST). */
  readonly mfaTypes = signal<string[]>([]);

  /** PASSWORDLESS local-login state (login-ui's half of the local-secrets flow).
   *  The local Studio agent (127.0.0.1:27621) is probed once on init; when it
   *  advertises one or more roles the sign-in slot renders the {@link
   *  RolePickerComponent} INSTEAD of the password form. An absent/empty agent
   *  leaves this empty and the normal password form renders unchanged. */
  readonly localRoles = signal<LocalRole[]>([]);
  /** The role id whose local sign-in is currently in flight (drives the picker's
   *  disabled/aria-busy state), or null when idle. */
  readonly localBusyRole = signal<string | null>(null);
  /** Set true to force the password form even when the agent advertised roles —
   *  the escape hatch when a local sign-in needs the password path (e.g. the
   *  account requires an MFA passcode the single-use handoff cannot carry). */
  readonly forcePasswordForm = signal(false);

  /** Whether to render the role picker (agent advertised roles AND we have not
   *  fallen back to the password form). When false, the password form renders. */
  readonly showRolePicker = computed(
    () => this.localRoles().length > 0 && !this.forcePasswordForm(),
  );

  /** Probe the local agent ONCE on load. Never throws (LocalAgentService degrades
   *  to `[]` on any failure), so a missing/broken agent simply leaves the normal
   *  password form in place — passwordless login is purely additive and MUST
   *  never break normal sign-in. */
  async ngOnInit(): Promise<void> {
    try {
      this.localRoles.set(await this.localAgent.roles());
    } catch {
      // Defense-in-depth: LocalAgentService already degrades to [] on any failure,
      // but the probe MUST NEVER break the normal password form under any error.
      this.localRoles.set([]);
    }
  }

  /** Logged in but registration not yet completed. */
  pending = () => this.session.loggedIn() && !this.session.fullyRegistered();

  /** The visible display name captured at the complete-registration step. */
  readonly displayName = signal('');
  /** The ASCII screen-reader name; auto-defaulted from an ASCII display name,
   *  otherwise typed by the user when prompted. */
  readonly screenReaderName = signal('');

  /** The screen-reader prompt copy (also surfaced as the field's helptext). A
   *  GETTER so the string is produced at render, after the catalog has loaded —
   *  a field initialiser would run at construction, which is also after the
   *  guard, but the getter keeps the lazy contract explicit and uniform. */
  get screenReaderPrompt(): string {
    return screenReaderPrompt();
  }

  /** True once a non-blank display name has been entered. */
  private readonly hasDisplayName = computed(() => this.displayName().trim().length > 0);

  /** Whether the display name needs an explicit ASCII screen-reader name — i.e.
   *  it is non-blank but NOT pure printable-ASCII (defaultScreenReaderName=null).
   *  Reveals + requires the screenReaderName field. */
  readonly needsScreenReaderName = computed(
    () => this.hasDisplayName() && defaultScreenReaderName(this.displayName()) === null,
  );

  /** Whether the typed screen-reader name is valid printable-ASCII (the field is
   *  only shown when required, and a required field must be non-blank ASCII). */
  readonly screenReaderNameValid = computed(
    () => this.screenReaderName().trim().length > 0 && isPrintableAscii(this.screenReaderName()),
  );

  /** The complete-registration submit is blocked until the identity is valid:
   *  a non-blank display name, and — when non-ASCII — a valid ASCII screen-reader
   *  name. Defense-in-depth: mirrors the server requiresScreenReaderName/422. */
  readonly completeBlocked = computed(
    () => !this.hasDisplayName() || (this.needsScreenReaderName() && !this.screenReaderNameValid()),
  );

  /** The `aria-describedby` tokens for the Complete-registration button: ALWAYS
   *  the always-present action help; PLUS the screen-reader prompt while the
   *  submit is blocked on a missing ASCII name. Space-joined id list. */
  readonly completeDescribedBy = computed(() =>
    this.completeBlocked() && this.needsScreenReaderName()
      ? 'hug-register-complete-help hug-register-screen-reader-help'
      : 'hug-register-complete-help',
  );

  /** The accessible (announced) name for the complete-view greeting: the ASCII
   *  screen-reader name when the visible label is non-ASCII, else the label. */
  readonly greetingAccessibleName = computed(() => {
    const label = this.session.session()?.label ?? '';
    return accessibleName(label, this.needsScreenReaderName() ? this.screenReaderName() : null);
  });

  /** True when the greeting label is non-ASCII, so the view exposes aria-label. */
  readonly greetingNeedsAriaLabel = computed(() => !isPrintableAscii(this.session.session()?.label ?? ''));

  /** The sign-in submit is blocked until both credentials are present. */
  canSubmit(): boolean {
    return this.username.trim().length > 0 && this.password.length > 0;
  }

  /**
   * Hand off to the host root after a fully-registered sign-in/registration.
   *
   * login-ui is deployed as a STANDALONE Angular app — its own index.html, no
   * module-federation remoteEntry in this stack (see the fe-gateway route
   * table's own comment on the login-ui route) — so THIS remote's Router only
   * ever has its own login routes to resolve. `router.navigateByUrl('/')`
   * silently re-resolves those SAME routes (app.routes.ts mounts LOGIN_ROUTES
   * at both '' and 'login') instead of ever reaching the host shell, leaving a
   * fully-registered user stuck on this view with no visible error. A hard
   * navigation is the only way to actually leave this SPA.
   */
  private goToHost(): void {
    this.hardNav.navigate('/');
  }

  /**
   * Route a BLOCKED (banned/suspended) sign-in to the client-side appeal page.
   *
   * Unlike {@link goToHost} — which must HARD-navigate to leave this standalone
   * SPA and reach the host shell — the appeal page (`/login/appeal`) is one of
   * THIS remote's OWN routes ({@link LOGIN_ROUTES}), so an in-SPA Router
   * navigation is correct and sufficient (no host destination is involved). The
   * navigation is RELATIVE to this component's route, exactly like the static
   * `routerLink="appeal"` footer link, so it resolves to `/login/appeal` under
   * the host (and the standalone `/login` shell) identically.
   *
   * The `reason` (the BFF's human-readable block reason) rides in `?reason=`;
   * {@link AppealComponent} announces it in an assertive live region. A blank
   * reason is omitted so no empty alert is rendered. The `error` signal is
   * cleared so the raw status token never flashes before the navigation.
   */
  private routeToAppeal(reason: string): void {
    this.error.set('');
    const trimmed = reason.trim();
    void this.router.navigate(['appeal'], {
      relativeTo: this.route,
      queryParams: trimmed ? { reason: trimmed } : {},
    });
  }

  /**
   * Submit our native sign-in form to `POST /bff/login`. On the first pass this
   * sends `{ username, password }`; when the BFF answered `mfaRequired`, the view
   * has swapped to the MFA challenge and this re-POSTs the SAME credentials plus
   * the passcode (`mfaPasscode` / `mfaType`). Navigation is driven by the login
   * result's `registrationComplete` — a fully-registered sign-in lands on the
   * host root, an incomplete one falls through to the complete-registration gate.
   */
  async submit(): Promise<void> {
    if (this.mfaRequired()) {
      if (!this.mfaCode.trim()) {
        this.error.set($localize`:Validation error when the two-factor passcode field is empty|@@login.error.mfaCodeRequired:Enter the verification code to continue.`);
        return;
      }
    } else if (!this.canSubmit()) {
      this.error.set($localize`:Validation error when username or password is missing|@@login.error.credentialsRequired:Enter your username and password.`);
      return;
    }
    this.error.set('');
    this.busy.set(true);
    const mfa = this.mfaRequired()
      ? { passcode: this.mfaCode.trim(), mfaType: this.mfaTypes()[0] }
      : undefined;
    const r = await this.bff.login(this.username.trim(), this.password, mfa);
    this.busy.set(false);

    if (r.dark) {
      this.error.set(this.signInUnavailable());
      return;
    }
    if (r.mfaRequired) {
      // Swap to the MFA challenge; keep the credentials for the passcode re-POST.
      this.mfaRequired.set(true);
      this.mfaTypes.set(r.mfaType ?? []);
      this.mfaCode = '';
      return;
    }
    if (r.blocked) {
      // Banned/suspended: no session was minted. Auto-route to the appeal page
      // with the announced reason instead of surfacing the raw status token.
      this.routeToAppeal(r.reason ?? '');
      return;
    }
    if (!r.ok) {
      this.error.set(this.signInFailed(r.error));
      return;
    }
    // Success — the opaque bff_ cookie is set. Clear the transient MFA state and
    // navigate by registration status. A not-fully-registered session falls
    // through to the pending() complete-registration card (no navigation).
    this.mfaRequired.set(false);
    this.password = '';
    this.mfaCode = '';
    if (this.session.fullyRegistered()) this.goToHost();
  }

  /**
   * PASSWORDLESS local sign-in for a picked role. Mirrors {@link submit}: it drives
   * the SAME shared error region and, on a fully-registered success, the SAME
   * navigation. The single-use secret is fetched + submitted entirely inside
   * {@link BffService.loginLocal} — it never touches this component and is never
   * persisted.
   *
   * Failure handling mirrors the password path, plus one escape hatch: if the
   * account requires an MFA passcode (which the single-use handoff cannot carry),
   * fall back to the password form so the normal MFA challenge can run.
   */
  async pickRole(roleId: string): Promise<void> {
    if (this.localBusyRole()) return; // one local sign-in at a time
    this.error.set('');
    this.localBusyRole.set(roleId);
    const r = await this.bff.loginLocal(roleId);
    this.localBusyRole.set(null);

    if (r.dark) {
      this.error.set(this.signInUnavailable());
      return;
    }
    if (r.mfaRequired) {
      // The single-use local handoff can't carry an MFA passcode — reveal the
      // password form (which supports the MFA challenge) for this account.
      this.forcePasswordForm.set(true);
      this.error.set($localize`:Shown when a passwordless local role needs a two-factor code the handoff cannot carry|@@login.error.localRoleNeedsMfa:This role needs a verification code. Sign in with your password to continue.`);
      return;
    }
    if (r.blocked) {
      // Banned/suspended account picked a local role: same auto-route to appeal
      // as the password path — the block is on the account, not the credential.
      this.routeToAppeal(r.reason ?? '');
      return;
    }
    if (!r.ok) {
      this.error.set(this.signInFailed(r.error));
      return;
    }
    // Success — the opaque bff_ cookie is set. A not-fully-registered session
    // falls through to the pending() complete-registration card (no navigation),
    // exactly like the password path.
    if (this.session.fullyRegistered()) this.goToHost();
  }

  /** Shared error copy for the two sign-in paths (password + passwordless local
   *  role), which report failures identically. `${reason}` is the BFF's own error
   *  token and is NOT translated — it is a diagnostic, not prose. */
  private signInFailed(reason: string | undefined): string {
    return $localize`:Sign-in failure. {{PLACEHOLDER}} is the server's error token, not translated@@login.error.signInFailed:Sign-in failed: ${reason}:reason:`;
  }

  /** Shown when the sign-in surface is dark (the BFF answered "unavailable"). */
  private signInUnavailable(): string {
    return $localize`:Shown when the sign-in backend is switched off or unreachable|@@login.error.unavailable:Sign-in is temporarily unavailable. Please try again later.`;
  }

  /** The identity to send: the display name plus the EFFECTIVE screen-reader
   *  name — the explicit ASCII value when one was required/typed, otherwise the
   *  default derived from an ASCII display name (mirrors defaultFor). */
  private identity(): RegistrationIdentity | undefined {
    if (!this.hasDisplayName()) return undefined;
    const display = this.displayName().trim();
    const explicit = this.screenReaderName().trim();
    const screenReaderName = explicit.length > 0 ? explicit : defaultScreenReaderName(display);
    return { displayName: display, screenReaderName };
  }

  async complete(): Promise<void> {
    // Defense-in-depth: never submit while the screen-reader prompt is unmet.
    if (this.completeBlocked()) {
      this.error.set(
        this.needsScreenReaderName()
          ? screenReaderPrompt()
          : $localize`:Validation error when the display name is blank|@@login.error.displayNameRequired:Enter a display name to continue.`,
      );
      return;
    }
    this.error.set('');
    await this.bff.completeRegistration(this.identity());
    this.goToHost();
  }
}
