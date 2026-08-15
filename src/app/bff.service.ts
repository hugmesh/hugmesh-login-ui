import { Injectable, inject } from '@angular/core';
import { SessionService, SnapSession } from './session.service';
import { LocalAgentService } from './local-agent.service';

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
 */
@Injectable({ providedIn: 'root' })
export class BffService {
  private readonly session = inject(SessionService);
  private readonly localAgent = inject(LocalAgentService);

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

  /** Init shared by every admin-bff call: always send credentials so the
   *  httpOnly `bff_` session cookie rides along (the browser holds no bearer). */
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
    await fetch(`${CFG.bff}/bff/register/complete`, {
      ...this.creds(),
      method: 'POST',
      // /bff/register/** is a cookie-mint endpoint (CSRF-exempt); auth is the bff_ cookie.
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify(this.identityBody(identity)),
    });
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
    const provision = (svc: 'matrix' | 'mastodon') =>
      fetch(`${CFG.bff}/bff/provision/${svc}`, {
        ...this.creds(),
        method: 'POST',
        headers: this.authHeaders(true), // mutating, non-mint → CSRF header in cookie mode
      });
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
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}/bff/me/appeal`, {
        ...this.creds(),
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders(true) },
        body: JSON.stringify({ reason, contactEmail: contactEmail || null }),
      });
    } catch {
      return { ok: false, error: 'network' };
    }
    if (r.ok) {
      const body = await r.json().catch(() => ({}));
      return { ok: true, status: body.status, id: body.id };
    }
    if (r.status === 401) return { ok: false, error: 'unauthenticated' };
    if (r.status === 400 || r.status === 422) return { ok: false, error: 'invalid' };
    return { ok: false, error: 'server' };
  }
}
