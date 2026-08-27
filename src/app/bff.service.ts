import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { SessionService, SnapSession } from './session.service';
import { LocalAgentService } from './local-agent.service';
import { AccountAppealUserControllerService } from './api/services/account-appeal-user-controller.service';
import { AuthControllerService } from './api/services/auth-controller.service';
import { bffFailure, withBffCredentials } from './http/bff-credentials';

/** The result of a native username/password sign-in ({@link BffService.login}).
 *
 *  The BFF mints the opaque `bff_` session cookie SERVER-SIDE (Set-Cookie); the
 *  browser never receives a JWT/access/refresh token, so this result carries only
 *  the non-secret routing hints the login view needs to navigate — never a token.
 */
export interface LoginResult {
  ok: boolean;
  /** The BFF answered "MFA required" (HTTP 200, `mfaRequired:true`) — NO session
   *  was minted. The caller renders the MFA challenge and re-POSTs with a passcode. */
  mfaRequired?: boolean;
  /** The MFA factor types the BFF offers (e.g. `['totp']`) — echoed back on the
   *  passcode re-POST as `mfaType`. */
  mfaType?: string[];
  /** Whether the account has completed the two-stage registration (drives the
   *  complete-registration gate). Set on a successful sign-in. */
  registrationComplete?: boolean;
  /** Account status the BFF reports on success (`active`). */
  status?: string;
  /** The SSO surface is dark (HTTP 503: `app.bff.oidc.enabled=false` / blank
   *  custody key) — sign-in is unavailable, not a credential failure. */
  dark?: boolean;
  /** The account is BLOCKED (banned or suspended): the BFF rejected sign-in with
   *  a `account_banned` / `account_suspended` token rather than a bad-credential
   *  failure. NO session is minted. The caller routes the visitor to the appeal
   *  page (with {@link reason}) instead of showing the raw token as an error. */
  blocked?: boolean;
  /** The human-readable block reason the BFF supplied alongside a {@link blocked}
   *  rejection (echoed into `/login/appeal?reason=` and announced there). Blank
   *  when the BFF gave no reason. Only meaningful when {@link blocked} is true. */
  reason?: string;
  /** Set on failure — a short, honest reason NEVER rendered as a success. On a
   *  {@link blocked} rejection this carries the status token (`account_banned` /
   *  `account_suspended`) for diagnostics; the user-facing route is the appeal
   *  page, not this token. */
  error?: string;
}

/** The account-status tokens the BFF returns when a sign-in is refused because
 *  the account is blocked (banned/suspended) rather than because the credentials
 *  were wrong — a blocked sign-in is auto-routed to the appeal page, a bad
 *  credential stays on the login form. Kept module-local so both {@link
 *  BffService.login} and {@link BffService.loginLocal} classify identically. */
const BLOCKED_STATUS_TOKENS = ['account_banned', 'account_suspended'] as const;

/** The result of either leg of the forgot-password flow ({@link BffService.requestPasswordReset} /
 *  {@link BffService.confirmPasswordReset}).
 *
 *  Deliberately CARRIES NO per-account information. The request leg answers the same
 *  `{ ok: true }` whether or not the username exists — the BFF flattens that on purpose so
 *  this permitAll endpoint is not a membership oracle — and this UI must not reintroduce the
 *  distinction by, say, remembering which usernames "worked". */
export interface PasswordResetResult {
  ok: boolean;
  /** The reset surface is DARK (HTTP 503: `casdoor.password-reset.enabled=false`, or no
   *  SMTP provisioned) — this mesh cannot reset a password at all. Distinct from a failure,
   *  because the user must be told to contact support rather than to try again. */
  dark?: boolean;
  /** Set on failure — a short, honest reason NEVER rendered as a success. */
  error?: string;
  /** The server's own message for a refused confirm, already flattened by the BFF to a
   *  single non-revealing sentence. Shown verbatim BECAUSE it is the server's reason: the
   *  sibling profile page's habit of discarding it and printing "please try again" is what
   *  made these failures undiagnosable. Blank when the server gave none. */
  message?: string;
}

/** The result of a structured appeal submission ({@link BffService.submitAppeal}). */
export interface AppealSubmitResult {
  ok: boolean;
  /** Set on success: the appeal's lifecycle status (`PENDING` for a fresh submit,
   *  or the status of an already-pending appeal on an idempotent re-submit). */
  status?: string;
  /** Set on success: the appeal row id. */
  id?: string;
  /** Set on failure — a short, honest reason NEVER rendered as a success. Distinct
   *  codes so the UI can tell "no session" (fall back to mailto) apart from a
   *  genuine validation/server failure. */
  error?: 'unauthenticated' | 'invalid' | 'network' | 'server';
}

/** Identity attributes captured at registration: the visible (UTF-8) display
 *  name plus the ASCII screen-reader name a screen reader announces. */
export interface RegistrationIdentity {
  displayName: string;
  screenReaderName: string | null;
}

const CFG = {
  bff: (globalThis as any).__HUG_BFF_URL__ ?? '',
  uptrace: (globalThis as any).__HUG_UPTRACE_URL__ ?? 'https://uptrace.hugmesh.net',
};

/**
 * Talks to the Spring admin BFF (backend namespace, behind the gateway), which
 * brokers to Casdoor through the hugmesh-pki gateway (server-side; see
 * {@link login}/{@link loginLocal} — the browser is never redirected there).
 * Registration is a TWO-STAGE flow: {@link completeRegistration} captures the
 * display name and only THEN triggers the Matrix/Mastodon service-token
 * provisioning.
 *
 * <p><b>ng-openapi-gen migration:</b> every CREDENTIALED call here delegates to
 * the generated, typed clients under {@code src/app/api} and is marked
 * credentialed with {@link withBffCredentials}, so the httpOnly `bff_` cookie
 * rides along exactly as the old {@code credentials: 'include'} did. The two
 * COOKIE-MINT sign-in calls ({@link login} / {@link loginLocal}) deliberately stay
 * on plain {@code fetch} — see {@link login} for why the committed contract
 * cannot describe them.
 */
@Injectable({ providedIn: 'root' })
export class BffService {
  private readonly session = inject(SessionService);
  private readonly localAgent = inject(LocalAgentService);
  private readonly auth = inject(AuthControllerService);
  private readonly appeals = inject(AccountAppealUserControllerService);

  constructor() {
    // Pin the generated clients to the host-provided BFF origin so the wire URLs
    // stay byte-identical to the legacy `${__HUG_BFF_URL__}/bff/...` paths (same
    // pattern as PublicAnnouncementsService / AppealContactService).
    this.auth.rootUrl = CFG.bff;
    this.appeals.rootUrl = CFG.bff;
  }

  /**
   * Build the auth headers for an admin-bff call. The browser NEVER holds a
   * bearer: auth rides in the httpOnly `bff_` cookie (sent via {@link creds}),
   * which the gateway turns into the upstream bearer server-side. So there is NO
   * `Authorization` header — only the double-submit `X-CSRF-TOKEN` on a MUTATING,
   * non-cookie-mint request (in cookie mode, where the require-matcher enforces it).
   */
  private authHeaders(mutating = false): Record<string, string> {
    if (this.session.cookieMode) {
      return mutating ? this.session.csrfHeader() : {};
    }
    return {};
  }

  /** Init for the two COOKIE-MINT sign-in fetches ({@link login} /
   *  {@link loginLocal}), the only calls left on plain `fetch`: send credentials
   *  so the browser accepts the `Set-Cookie` that mints the httpOnly `bff_`
   *  session (the browser holds no bearer). Every CREDENTIALED call goes through
   *  the generated client with {@link withBffCredentials} instead. */
  private creds(): RequestInit {
    return { credentials: 'include' };
  }

  /**
   * Classify a NON-OK, non-503 `/bff/login` (or `/bff/login/local`) rejection
   * body into a {@link LoginResult}. A blocked-account token
   * (`account_banned` / `account_suspended`) yields a `blocked` result carrying
   * the human-readable {@code reason} — the caller routes the visitor to the
   * appeal page instead of showing the raw token. Every other token is a plain
   * credential/handoff failure that keeps the visitor on the sign-in form.
   *
   * Shared by BOTH sign-in paths so a banned account is auto-routed to appeal
   * whether it tried the password form OR a passwordless local role. NEVER
   * throws (the body was already `.catch`-guarded into a plain object).
   */
  private classifyRejection(err: any, status: number): LoginResult {
    const token: string = err?.error || err?.message || `HTTP ${status}`;
    if ((BLOCKED_STATUS_TOKENS as readonly string[]).includes(err?.error)) {
      return {
        ok: false,
        blocked: true,
        error: err.error,
        reason: typeof err?.reason === 'string' ? err.reason.trim() : '',
      };
    }
    return { ok: false, error: token };
  }

  /** Maps the captured identity into the register/complete body (omits absent
   *  fields). Used by {@link completeRegistration} (Stage 2 of registration —
   *  the Casdoor account itself is created server-side by user-bff during
   *  {@link login}/{@link loginLocal}, not by a client-initiated register call). */
  private identityBody(identity?: RegistrationIdentity): Record<string, string> {
    if (!identity) return {};
    const body: Record<string, string> = { displayName: identity.displayName };
    if (identity.screenReaderName) body['screenReaderName'] = identity.screenReaderName;
    return body;
  }

  /**
   * Native username/password sign-in against `POST /bff/login` (user-bff, reached
   * via the gateway; permitAll at the BFF security layer). THIS remote's own form
   * is the only login surface — the browser is NEVER redirected to Casdoor.
   *
   * The BFF generates PKCE + state SERVER-SIDE, POSTs Casdoor's INTERNAL login,
   * exchanges the code SERVER-SIDE, and mints the opaque `bff_` session cookie via
   * Set-Cookie. The browser therefore never receives a JWT/access/refresh/id
   * token, the code_verifier, the state, or any Casdoor URL — only the non-secret
   * routing hints in {@link LoginResult}.
   *
   * Responses:
   *   • 200 `{ mfaRequired:false, status:'active', registrationComplete }` + the
   *     Set-Cookie → success: reflect the session and (when fully registered)
   *     kick off server-side Matrix/Mastodon token provisioning.
   *   • 200 `{ mfaRequired:true, mfaType:[…] }` → NO cookie / NO session minted;
   *     the caller renders the MFA challenge and re-POSTs with a passcode.
   *   • 401 `{ error:'invalid_credentials', message }` → bad credentials.
   *   • 503 → the SSO surface is dark (unavailable).
   *
   * <p><b>Why this call is still a plain `fetch`</b> (the one endpoint the
   * ng-openapi-gen migration cannot take): the committed {@code openapi.json} is
   * the ADMIN-bff contract, and admin-bff publishes its OWN, different
   * {@code POST /bff/login} — the legacy google/discord one, whose
   * {@code LoginRequest} is {@code {provider,email,username}} with NO
   * {@code password}. The native username/password login THIS form drives is
   * user-bff's ({@code SsoAuthController}, {@code {username,password,mfaPasscode,
   * mfaType}}), and this repo does not generate a client from the user-bff spec.
   * Generating against the admin-bff operation would type-check away the password
   * and enshrine the wrong contract, so the raw call stays until a user-bff client
   * exists. Its sibling {@link loginLocal} stays alongside it for the same reason
   * the two were written to mirror each other.
   *
   * @param mfa when re-submitting after an `mfaRequired` challenge, the passcode
   *   (and the offered factor type) to include as `mfaPasscode` / `mfaType`.
   */
  async login(
    username: string,
    password: string,
    mfa?: { passcode: string; mfaType?: string },
  ): Promise<LoginResult> {
    const body: Record<string, string> = { username, password };
    if (mfa) {
      body['mfaPasscode'] = mfa.passcode;
      if (mfa.mfaType) body['mfaType'] = mfa.mfaType;
    }
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}/bff/login`, {
        ...this.creds(),
        // login IS a cookie-mint endpoint (CSRF-exempt server-side), so no CSRF header here.
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    // 503 — the SSO surface is dark (oidc disabled / blank custody key). This is
    // "unavailable", NOT a credential failure, so the view says so rather than
    // "invalid credentials".
    if (r.status === 503) return { ok: false, dark: true, error: 'unavailable' };
    if (!r.ok) {
      // 401 bad credentials: { error:'invalid_credentials', message:<casdoor msg> };
      // or a blocked account: { error:'account_banned'|'account_suspended', reason }
      // — classifyRejection routes the latter to the appeal page.
      const err = (await r.json().catch(() => ({} as any))) as any;
      return this.classifyRejection(err, r.status);
    }
    const data = (await r.json().catch(() => ({} as any))) as any;
    // MFA required: no cookie, no session minted — hand the challenge back to the
    // caller, which re-POSTs this same call with the passcode.
    if (data.mfaRequired) {
      return { ok: false, mfaRequired: true, mfaType: Array.isArray(data.mfaType) ? data.mfaType : [] };
    }
    // Success: the opaque bff_ cookie is set server-side (Set-Cookie). Reflect the
    // logged-in session from the NON-SECRET body (registrationComplete drives the
    // two-stage gate); the session token appears ONLY in the cookie, never here.
    const s: SnapSession = {
      id: '', label: username, provider: 'password', roles: ['user'],
      registrationComplete: !!data.registrationComplete,
    };
    this.session.set(s);
    // Enrich roles from the server session where the cookie-custody model exposes
    // them (GET /bff/session). A no-op in legacy localStorage mode.
    await this.session.hydrate();
    if (this.session.fullyRegistered()) await this.provisionServiceTokens();
    return { ok: true, registrationComplete: !!data.registrationComplete, status: data.status };
  }

  /**
   * PASSWORDLESS LOCAL-SECRETS sign-in — the sibling of {@link login}, used when
   * the local Studio agent (127.0.0.1:27621) advertises pre-provisioned roles.
   * This is login-ui's half of the passwordless-local-secrets contract.
   *
   * Two steps, no bypass of the normal auth path:
   *   1. Ask the loopback agent for a SINGLE-USE, short-TTL credential for
   *      {@code roleId} ({@link LocalAgentService.handoff}, `POST /v1/handoff`).
   *      The returned {@code secret} lives ONLY in this local `handoff` variable
   *      for the duration of the call — it is NEVER persisted (no localStorage,
   *      no session, never logged) and is submitted immediately below.
   *   2. POST `{ roleId, username, secret }` to the admin-bff sibling endpoint
   *      `POST /bff/login/local` with `credentials: 'include'`. The BFF validates
   *      username+secret through Casdoor EXACTLY as `/bff/login` does and mints
   *      the SAME opaque httpOnly `bff_` cookie via Set-Cookie. `roleId` is
   *      telemetry only; there is NO alternate token path — only the credential
   *      SOURCE differs. The browser still never receives a JWT/access/refresh
   *      token — only the cookie.
   *
   * On success it reflects the NON-SECRET session and runs the SAME
   * hydrate()/provision path as {@link login}. Failure mirrors {@link login}:
   *   • agent absent / handoff failed → `{ ok:false, error:'handoff' }` so the
   *     caller can surface it (or fall back);
   *   • 401 (bad secret) → `{ ok:false }`, identical to a bad password;
   *   • 200 `{ mfaRequired:true }` → returned as-is (the single-use handoff cannot
   *     carry a passcode, so the caller falls back to the password form);
   *   • 503 → `{ ok:false, dark:true }`.
   * Never throws.
   */
  async loginLocal(roleId: string): Promise<LoginResult> {
    // 1. Single-use credential from the loopback agent. The secret stays local.
    const handoff = await this.localAgent.handoff(roleId);
    if (!handoff) return { ok: false, error: 'handoff' };

    // 2. Exchange it at the admin-bff sibling endpoint (credentials: include).
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}/bff/login/local`, {
        ...this.creds(),
        // /bff/login/local is a cookie-mint endpoint (CSRF-exempt server-side),
        // so NO CSRF header — exactly like /bff/login.
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ roleId, username: handoff.username, secret: handoff.secret }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    // 503 — the SSO surface is dark (oidc disabled / blank custody key).
    if (r.status === 503) return { ok: false, dark: true, error: 'unavailable' };
    if (!r.ok) {
      // 401 bad secret — identical shape/handling to a bad password; a blocked
      // account (account_banned/suspended) routes to appeal, same as /bff/login.
      const err = (await r.json().catch(() => ({} as any))) as any;
      return this.classifyRejection(err, r.status);
    }
    const data = (await r.json().catch(() => ({} as any))) as any;
    // MFA required: the single-use local handoff can't carry a passcode. Hand the
    // challenge back so the caller can fall back to the password form (no session
    // is minted here).
    if (data.mfaRequired) {
      return { ok: false, mfaRequired: true, mfaType: Array.isArray(data.mfaType) ? data.mfaType : [] };
    }
    // Success: the opaque bff_ cookie is set server-side (Set-Cookie). Reflect the
    // logged-in session from the NON-SECRET body and run the SAME hydrate/provision
    // path as login() — the session token appears ONLY in the cookie, never here.
    const s: SnapSession = {
      id: '', label: handoff.username, provider: 'password', roles: ['user'],
      registrationComplete: !!data.registrationComplete,
    };
    this.session.set(s);
    await this.session.hydrate();
    if (this.session.fullyRegistered()) await this.provisionServiceTokens();
    return { ok: true, registrationComplete: !!data.registrationComplete, status: data.status };
  }

  /** Stage 2: complete registration — ONLY THEN are service tokens issued.
   *
   *  {@code identity} carries the visible displayName (UTF-8) + the ASCII
   *  screenReaderName captured at the complete-registration prompt. They ride
   *  in the complete body so the user-bff profile (and Casdoor displayName) are
   *  set in one round-trip. The admin-bff AuthController register/complete DTO
   *  accepts + forwards these to the user-bff profile (`screen_reader_name`
   *  column exists — user-bff changeset 008). */
  async completeRegistration(identity?: RegistrationIdentity): Promise<void> {
    // /bff/register/** is a cookie-mint endpoint (CSRF-exempt); auth is the bff_ cookie.
    // The response was already ignored here, and `fetch` resolved for a non-OK one;
    // the generated client ERRORS on it instead, so swallow it to keep provisioning
    // and the registration flip running exactly as before.
    await firstValueFrom(
      this.auth.authComplete(
        { body: this.identityBody(identity) },
        withBffCredentials(this.authHeaders()),
      ),
    ).catch(() => undefined);
    // Provision the brokered Matrix/Mastodon tokens server-side FIRST (the
    // broker can be slow against the real tuwunel), THEN flip
    // registrationComplete — so the Matrix/Mastodon modules only unlock once the
    // server-held tokens actually exist (avoids a race where the UI navigates
    // before the hsproxy can inject a token).
    await this.provisionServiceTokens();
    this.session.patch({ registrationComplete: true });
  }

  /** Trigger server-side provisioning of the Matrix + Mastodon access tokens —
   *  the BFF mints them against the real tuwunel/Mastodon and HOLDS them
   *  server-side (owner = the bff_ session subject). The browser NEVER reads or
   *  stores the returned token: every Matrix/Mastodon call goes through the
   *  user-bff hsproxy (/bff/user/matrix|mastodon/**), which injects the
   *  server-held token. So this only POSTs to kick off provisioning. */
  private async provisionServiceTokens(): Promise<void> {
    // Auth rides in the httpOnly `bff_` cookie (no JS-readable token), so only
    // guard on a logged-in session.
    if (!this.session.session()) return;
    // mutating, non-mint → CSRF header in cookie mode. Best-effort: the outcome was
    // never read, so a failure is swallowed rather than aborting the caller (the
    // generated client errors on a non-OK where the former `fetch` resolved).
    const provision = (svc: 'matrix' | 'mastodon') =>
      firstValueFrom(
        svc === 'matrix'
          ? this.auth.authProvisionMatrix({}, withBffCredentials(this.authHeaders(true)))
          : this.auth.authProvisionMastodon({}, withBffCredentials(this.authHeaders(true))),
      ).catch(() => undefined);
    // Fire both provisioning POSTs; the returned access_token is intentionally
    // discarded — it lives server-side for the hsproxy, never in the browser.
    await provision('matrix');
    await provision('mastodon');
  }

  /**
   * Submit a STRUCTURED account-ban appeal to `POST /bff/me/appeal` (admin-bff).
   * Reachable ONLY from a session that still holds a usable `bff_` cookie — a
   * PROFILE ban/suspension does not revoke the Casdoor role or the JWT (see
   * admin-bff's {@code AccountAppealUserController} javadoc), so a principal who
   * was ALREADY signed in when curtailed can file a real, recorded appeal here.
   * A principal with NO session at all (denied at login; never authenticated)
   * gets a 401, mapped to {@code error:'unauthenticated'} — the caller (the
   * appeal page) falls back to the mailto path in that case; it must NEVER
   * render this as a submitted appeal. Never throws.
   */
  async submitAppeal(reason: string, contactEmail: string | null): Promise<AppealSubmitResult> {
    try {
      const body = await firstValueFrom(
        this.appeals.accountAppealSubmit(
          { body: { reason, contactEmail: contactEmail || null } },
          withBffCredentials(this.authHeaders(true)),
        ),
      );
      return { ok: true, status: body.status, id: body.id };
    } catch (err) {
      // `fetch` resolved for every status and this mapping read `r.status`; the
      // generated client errors instead, and a transport failure (the old
      // try/catch around `fetch`) arrives as status 0.
      const { status } = bffFailure(err);
      if (status === 401) return { ok: false, error: 'unauthenticated' };
      if (status === 400 || status === 422) return { ok: false, error: 'invalid' };
      if (status === 0) return { ok: false, error: 'network' };
      return { ok: false, error: 'server' };
    }
  }

  /**
   * FORGOT-PASSWORD leg 1 — ask the BFF to have the IdP mail a one-time code to the
   * address it holds for `username`. `POST /bff/password-reset/request` (user-bff, the
   * service that already owns the anonymous `/bff/login` leg).
   *
   * Plain `fetch`, like {@link login} and {@link loginLocal} and for the same reason: the
   * generated clients under `src/app/api` are generated from the ADMIN-bff contract, and
   * these are user-bff endpoints that contract does not describe.
   *
   * NO credentials and NO CSRF header: the caller is anonymous by construction (that is
   * the entire point), the endpoint mints no cookie, and CSRF is disabled at both the
   * gateway and the BFF. Sending `credentials: 'include'` here would attach whatever stale
   * `bff_` cookie the browser still held to a request that must not depend on one.
   *
   * ANTI-ENUMERATION IS A UI RESPONSIBILITY TOO. A well-formed request answers 202 whether
   * or not the account exists, and this method maps that to a single `{ ok: true }`. The
   * caller MUST show the same confirmation either way — never "we found your account".
   *
   * Never throws.
   */
  async requestPasswordReset(username: string): Promise<PasswordResetResult> {
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}/bff/password-reset/request`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    // 503 — the reset surface is dark. A fact about the MESH, identical for every visitor,
    // so it is safe (and necessary) to state plainly.
    if (r.status === 503) return { ok: false, dark: true, error: 'unavailable' };
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}) as any)) as any;
      // 400 is a malformed request (blank username) — the ONLY non-503 rejection this leg
      // can produce, because the server refuses to distinguish accounts.
      return { ok: false, error: r.status === 400 ? 'invalid' : 'server', message: err?.error };
    }
    return { ok: true };
  }

  /**
   * FORGOT-PASSWORD leg 2 — redeem the mailed code and set the new password.
   * `POST /bff/password-reset/confirm`.
   *
   * `ok` is true ONLY on a genuine 2xx, i.e. only when the IdP actually wrote the
   * credential. A refused reset returns `ok:false` WITH the server's own (already
   * flattened) message, so the page can say why instead of guessing — the failure mode
   * that makes a broken reset indistinguishable from a mistyped code.
   *
   * Never throws.
   */
  async confirmPasswordReset(
    username: string,
    code: string,
    newPassword: string,
  ): Promise<PasswordResetResult> {
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}/bff/password-reset/confirm`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, code, newPassword }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    if (r.status === 503) return { ok: false, dark: true, error: 'unavailable' };
    if (!r.ok) {
      const err = (await r.json().catch(() => ({}) as any)) as any;
      // The BFF answers { error: "<one flattened sentence>" } for a refusal and
      // { error: "validation failed", fields: {...} } for a malformed body.
      const message = typeof err?.error === 'string' ? err.error : undefined;
      return { ok: false, error: r.status === 400 ? 'invalid' : 'server', message };
    }
    return { ok: true };
  }

}
