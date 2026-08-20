import { Injectable, OnDestroy, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { oidcEnabled } from './oidc-config';
import { AuthControllerService } from './api/services/auth-controller.service';
import { withBffCredentials } from './http/bff-credentials';

export interface SnapSession {
  id: string;                 // always '' in the current native-login flow (not
                               // populated by login()/loginLocal()/hydrate());
                               // kept for the SnapSession shape's stability.
  label: string;              // display (the signed-in username)
  // 'google' | 'discord' are vestigial — no code path mints them anymore (the
  // Google/Discord register flow was removed); kept for backward-compat typing
  // of pre-existing persisted localStorage sessions and as a hydrate() fallback
  // tag (see hydrate() below). New sessions are 'password' or 'oidc'.
  provider: 'google' | 'discord' | 'oidc' | 'password';
  roles: string[];
  registrationComplete: boolean;
  // The Matrix/Mastodon homeserver access tokens are NEVER held in the browser:
  // the user-bff hsproxy (/bff/user/matrix|mastodon/**) injects the server-held
  // token (owner = the bff_ session subject) on every proxied call. The browser
  // only carries the non-secret session metadata above + the httpOnly bff_ cookie.
}

/** BFF base URL, provided by the host at runtime (same source as BffService). */
const CFG = {
  bff: (globalThis as any).__HUG_BFF_URL__ ?? '',
};

/**
 * Non-secret post-hydrate session PROBE (`globalThis.__HUG_SESSION__`).
 *
 * In LEGACY localStorage mode the session's non-secret metadata is readable off
 * `localStorage['hug.session']`, so an offline e2e can assert the persona's
 * roles[] round-tripped faithfully. In OIDC/cookie-custody mode NOTHING is
 * persisted — the hydrated session lives ONLY in the in-memory signal — so there
 * is no web-storage surface an e2e can read the roles back from, and the
 * roles→signal mapping's end-to-end faithfulness (no drop, no up-case) is
 * otherwise unobservable outside the unit tests.
 *
 * This probe mirrors the SAME non-secret metadata the signal already holds
 * (id/label/provider/roles/registrationComplete) onto a host-injected-style
 * `__HUG_*` global whenever the signal changes, so a black-box test can read
 * the exact roles the UI carries post-hydrate. It is a strict SUBSET of the
 * legacy `hug.session` payload — it carries NO token (there is none: auth rides
 * in the httpOnly `bff_` cookie), so the persist-nothing/no-token custody
 * invariant is preserved (this is not web storage and holds no credential).
 */
const SESSION_PROBE = '__HUG_SESSION__';

/**
 * D6 PER-UI COOKIE-MODE FLAG (ships DARK, default FALSE).
 *
 * The browser NEVER holds an admin-capable bearer: auth ALWAYS rides in the
 * httpOnly `bff_` cookie, which the gateway's BffCookieToBearerWebFilter turns
 * into the upstream bearer server-side. Every `/bff/*` call therefore sends
 * `credentials: 'include'` (the cookie) and NO `Authorization` header.
 *
 * This flag now only selects how the NON-SECRET session metadata
 * (id/label/provider/roles/registrationComplete) is held. When FALSE (the
 * default this remote SHIPS with) the metadata is persisted to `localStorage`
 * under `hug.session` and synced cross-tab via the `storage` event. When the
 * host flips `globalThis.__HUG_SESSION_COOKIE_MODE__ = true`, this remote runs
 * the MERGED httpOnly-cookie session (admin-bff D6 / #89): the metadata is NOT
 * persisted, the session is hydrated from `GET /bff/session` (credentials:
 * include), mutations echo the double-submit `X-CSRF-TOKEN` header, and logout
 * goes via `POST /bff/sessionOut`.
 */
export function cookieModeEnabled(): boolean {
  return (globalThis as any).__HUG_SESSION_COOKIE_MODE__ === true;
}

/** The double-submit CSRF header the cookie-mode admin-bff expects (matches
 *  `SecurityConfig.CSRF_HEADER`). The token rides in the JS-readable
 *  `XSRF-TOKEN` cookie (CookieServerCsrfTokenRepository.withHttpOnlyFalse). */
const CSRF_HEADER = 'X-CSRF-TOKEN';
const CSRF_COOKIE = 'XSRF-TOKEN';

/** Holds the logged-in session and derives the Casdoor-style role flags + the
 *  registration-complete gate the host uses to unlock the Matrix/Mastodon
 *  micro-frontends.
 *
 *  Auth ALWAYS rides in the httpOnly `bff_` cookie (no browser bearer). The
 *  {@link cookieModeEnabled} flag only selects how the non-secret metadata is
 *  held (per-UI, ships dark):
 *   • localStorage mode (DEFAULT): metadata persisted to `hug.session`;
 *     cross-tab sync via the `storage` event.
 *   • cookie mode (#89): metadata NOT persisted; hydrated from `GET /bff/session`;
 *     cross-tab sync via BroadcastChannel re-hydrate (there is no localStorage
 *     write to raise a `storage` event). */
@Injectable({ providedIn: 'root' })
export class SessionService implements OnDestroy {
  private readonly key = 'hug.session';
  private readonly channel = 'hug-session-change';
  /** Cross-tab channel used ONLY in cookie mode (localStorage `storage` events
   *  cannot fire when nothing is written to localStorage). */
  private readonly bc: BroadcastChannel | null;
  /** The generated, typed admin-bff client. `/bff/session` + `/bff/sessionOut` are
   *  CREDENTIALED calls, so both go out with {@link withBffCredentials} — the
   *  generated transport sends the httpOnly `bff_` cookie only when asked. */
  private readonly auth = inject(AuthControllerService);
  readonly session = signal<SnapSession | null>(this.load());
  readonly loggedIn = computed(() => this.session() !== null);
  readonly isAdmin = computed(() => (this.session()?.roles ?? []).includes('admin'));
  /** Matrix/Mastodon are usable only after full registration completes. */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);

  constructor() {
    // Pin the generated client to the host-provided BFF origin so the wire URL is
    // identical to the legacy `${__HUG_BFF_URL__}/bff/...` path (same pattern as
    // PublicAnnouncementsService / AppealContactService).
    this.auth.rootUrl = CFG.bff;
    // Keep the non-secret probe in lockstep with the initial signal state so a
    // black-box reader sees the roles even before any write (e.g. a legacy
    // localStorage session loaded on construction).
    this.publish(this.session());
    // The host shell and each federated remote each hold their OWN SessionService
    // instance over the same session state. Re-read on a same-document broadcast
    // (dispatched by whichever instance wrote) and on cross-tab storage events, so
    // every nav/guard reading this signal stays in sync — e.g. this login remote
    // completing registration must unlock the host shell's Matrix/Mastodon nav.
    this.bc = (cookieModeEnabled() && typeof BroadcastChannel !== 'undefined')
      ? new BroadcastChannel(this.channel)
      : null;
    if (typeof window !== 'undefined') {
      if (cookieModeEnabled()) {
        // Cookie mode: the writer carries the authoritative session in the
        // same-document event detail so sibling in-page instances adopt it
        // WITHOUT a re-read (load() is null in cookie mode — nothing persisted).
        window.addEventListener(this.channel, (e) => this.adopt((e as CustomEvent).detail));
        // Another TAB changed the session → re-hydrate from the BFF (the httpOnly
        // cookie is the source of truth; nothing crosses tabs via localStorage).
        if (this.bc) this.bc.onmessage = () => { void this.hydrate(); };
      } else {
        // localStorage mode (legacy, byte-identical): every in-page instance
        // re-reads on the same-document broadcast, and cross-tab via `storage`.
        window.addEventListener(this.channel, () => this.setSession(this.load()));
        window.addEventListener('storage', (e) => { if (e.key === this.key) this.setSession(this.load()); });
      }
    }
  }

  /**
   * Close the cross-tab channel when this injector is torn down (an unmounted
   * federated remote, and every unit test's TestBed).
   *
   * The channel's message handler RE-HYDRATES from `/bff/session`, so a dead
   * instance left listening keeps issuing credentialed requests on an injector
   * that no longer exists — and, because a failed re-hydrate calls clearLocal(),
   * which broadcasts again, two such instances feed each other indefinitely.
   * That was survivable while hydrate() used a raw `fetch` (each round-trip cost
   * a real 404); once it moved onto the generated HttpClient client the failure
   * became immediate and the loop tight enough to wedge the browser.
   */
  ngOnDestroy(): void {
    this.bc?.close();
  }

  /** Cookie-mode same-document adopt: take the session another in-page instance
   *  just wrote (carried in the broadcast detail) rather than re-reading nothing. */
  private adopt(s: SnapSession | null): void {
    this.setSession(s ?? null);
  }

  /** The SINGLE place the session signal is written. Also mirrors the non-secret
   *  metadata onto the {@link SESSION_PROBE} global so a black-box e2e can read
   *  the post-hydrate roles even in cookie/OIDC mode (nothing is persisted to web
   *  storage there — the signal is the only source of truth). */
  private setSession(s: SnapSession | null): void {
    this.session.set(s);
    this.publish(s);
  }

  /** Drop to logged-out, clearing any PERSISTED session too (unlike bare
   *  {@link setSession}(null), which only touches the in-memory signal) —
   *  hydrate()'s "no longer valid" paths (401 / network error). Deliberately
   *  does NOT hit {@code /bff/sessionOut} like {@link clear} does: a failed
   *  re-hydrate means the cookie is ALREADY gone/invalid server-side, not an
   *  active sign-out, so firing that request would be pointless. */
  private clearLocal(): void {
    if (!cookieModeEnabled()) localStorage.removeItem(this.key);
    this.setSession(null);
    this.broadcast();
  }

  /** Mirror the session's NON-SECRET metadata (never a token) onto the
   *  {@link SESSION_PROBE} global, or clear it when logged out. */
  private publish(s: SnapSession | null): void {
    if (typeof globalThis === 'undefined') return;
    (globalThis as any)[SESSION_PROBE] = s
      ? {
          id: s.id,
          label: s.label,
          provider: s.provider,
          roles: s.roles,
          registrationComplete: s.registrationComplete,
        }
      : null;
  }

  /** Initial in-memory state. localStorage mode reads the persisted session;
   *  cookie mode starts EMPTY (the caller hydrates from `GET /bff/session`). */
  private load(): SnapSession | null {
    if (cookieModeEnabled()) return null;
    try { const raw = localStorage.getItem(this.key); return raw ? JSON.parse(raw) : null; }
    catch { return null; }
  }

  set(s: SnapSession): void {
    if (!cookieModeEnabled()) localStorage.setItem(this.key, JSON.stringify(s));
    this.setSession(s);
    this.broadcast();
  }
  patch(p: Partial<SnapSession>): void { const s = this.session(); if (s) this.set({ ...s, ...p }); }

  /** Sign out. Auth lives in the httpOnly `bff_` cookie in EVERY mode, so logout
   *  must hit the real endpoint to delete the server session + expire the cookie
   *  (dropping local state alone would leave the browser still authenticated).
   *  In legacy mode it also removes the persisted metadata. Both broadcast so
   *  every in-page instance + sibling tab drops to logged-out. */
  clear(): void {
    // Best-effort: clear local state regardless of whether the call succeeds
    // (the cookie may already be gone). The CSRF token is exempt for
    // /bff/sessionOut server-side, but we still send credentials. Fire-and-forget,
    // so BOTH outcomes are swallowed — HttpClient errors on a non-2xx where the
    // former `fetch` merely resolved, and neither must block the local clear.
    this.auth.authSessionOut({}, withBffCredentials(this.csrfHeader()))
      .subscribe({ next: () => undefined, error: () => undefined });
    if (!cookieModeEnabled()) localStorage.removeItem(this.key);
    this.setSession(null);
    this.broadcast();
  }

  /**
   * COOKIE / OIDC MODE: hydrate the session from `GET /bff/session` (credentials:
   * include) — the httpOnly `bff_` cookie carries auth, so the UI cannot read the
   * token from JS and learns {roles, registrationComplete, mfaSatisfied} from
   * this endpoint. A non-OK response means "not logged in" → drop to null. In
   * localStorage mode (cookie mode AND OIDC both off) this is a NO-OP (the
   * persisted session is authoritative).
   *
   * The OIDC login path (PR-4) shares the same custody model — the browser holds
   * ONLY the opaque `bff_` cookie — so an OIDC sign-in hydrates here too, even if
   * the per-UI cookie-mode flag is off ({@link oidcSessionMode}).
   *
   * The hydrated session carries NO token (auth rides in the cookie); the
   * id/label/provider are not exposed by `/bff/session`, so they are left
   * blank — the cookie session is identified server-side, not by these fields.
   */
  async hydrate(): Promise<SnapSession | null> {
    // EVERY mode hydrates. localStorage mode used to return early here, which
    // stranded the hardcoded `roles: ['user']` guess that login() writes before
    // this call (bff.service.ts): the server's REAL roles never reached storage,
    // so a mod/admin/superadmin looked like a plain user to every consumer of
    // `hug.session`. Live consequence (operator report 2026-08-14): /mod's
    // canActivate guard read roles:['user'], denied its own moderator, and
    // redirected to a '/login' route that does not exist INSIDE the mounted
    // remote — NG04002, blank screen, "no clear way to administer matrix
    // mastodon". Auth custody is unchanged: /bff/session is cookie-authenticated
    // and returns NO token, only non-secret role/registration metadata.
    try {
      // A non-OK /bff/session used to be read off `r.ok`; the generated client
      // ERRORS on it instead, so both "not logged in" paths land in the catch.
      const data = await firstValueFrom(
        this.auth.authSession({}, withBffCredentials()).pipe(
          // The endpoint's OpenAPI response is an untyped Map<String,Object>;
          // bridge it to the two non-secret fields this service reads.
          map((body) => body as unknown as { roles?: string[]; registrationComplete?: boolean }),
        ),
      );
      const prior = this.session();
      const s: SnapSession = {
        // The cookie session is identified server-side, so there is no real
        // client-known id/label/provider to report here. Tag 'oidc' only for the
        // client-side-OIDC-without-cookie-mode case; the other branch (plain
        // cookie mode, i.e. every native /bff/login today) falls back to the
        // vestigial 'google' placeholder — no UI logic reads this value (see the
        // SnapSession.provider comment), so the tag itself is not load-bearing.
        // Keep whatever identity the CALLER already established (localStorage
        // mode's login() sets label=<username>, which the shell renders in its
        // nav). Only the server-owned fields below are authoritative here —
        // blanking the label would log the user out of their own name.
        id: prior?.id ?? '',
        label: prior?.label ?? '',
        provider: prior?.provider
          ?? (oidcEnabled() && !cookieModeEnabled() ? 'oidc' : 'google'),
        roles: data.roles ?? ['user'],
        registrationComplete: !!data.registrationComplete,
      };
      // Use the PUBLIC set() (not the private setSession()) so a real OIDC
      // role grant (admin/mod/superadmin/etc, synced server-side on every
      // native login) actually reaches localStorage — not just this page's
      // in-memory signal. Without this, the initial hardcoded roles:['user']
      // guess set at login time (before this fetch resolves) NEVER gets
      // corrected in storage. The host shell has its OWN separate
      // SessionService instance (a different Angular bundle) — its
      // same-document/storage-event listeners both just RE-READ localStorage
      // (this.session.set(this.load())), they don't receive this remote's
      // in-memory signal or this fetch's result directly — so without this
      // write it keeps showing the stale "plain user" nav forever, no matter
      // the account's real Casdoor roles. (Only genuine cookie-mode, where
      // cross-instance sync goes over BroadcastChannel instead of storage,
      // should skip the write — set() already gates that correctly.)
      this.set(s);
      return s;
    } catch {
      this.clearLocal();
      return null;
    }
  }

  /** Whether this remote is running in the merged httpOnly-cookie session mode. */
  get cookieMode(): boolean { return cookieModeEnabled(); }

  /**
   * Whether the OIDC login path is active. When OIDC ships (PR-4), the browser
   * holds ONLY the opaque `bff_` session cookie — exactly the cookie-mode custody
   * model — so the OIDC callback must use {@link hydrate} semantics EVEN IF
   * `__HUG_SESSION_COOKIE_MODE__` is false. Mirrors {@code cookieMode} so
   * callers can treat "OIDC on" as "cookie session, never persist metadata". */
  get oidcSessionMode(): boolean { return oidcEnabled(); }

  /** The double-submit CSRF header for cookie-mode MUTATING requests. Reads the
   *  JS-readable `XSRF-TOKEN` cookie and echoes it as `X-CSRF-TOKEN`. Empty (no
   *  header) in localStorage mode or before a token cookie exists — the
   *  admin-bff require-matcher exempts the Bearer/cookie-mint paths anyway. */
  csrfHeader(): Record<string, string> {
    if (!cookieModeEnabled() || typeof document === 'undefined') return {};
    const token = this.readCookie(CSRF_COOKIE);
    return token ? { [CSRF_HEADER]: token } : {};
  }

  private readCookie(name: string): string | null {
    const prefix = name + '=';
    for (const part of (document.cookie || '').split(';')) {
      const c = part.trim();
      if (c.startsWith(prefix)) return decodeURIComponent(c.slice(prefix.length));
    }
    return null;
  }

  /** Notify the other in-page SessionService instances (host + remotes) to
   *  re-read, AND in cookie mode notify sibling tabs to re-hydrate. */
  private broadcast(): void {
    if (typeof window !== 'undefined') {
      // Cookie mode carries the just-written session in the detail (so sibling
      // in-page instances adopt it directly); legacy mode uses a plain Event and
      // the listeners re-read localStorage.
      const ev = cookieModeEnabled()
        ? new CustomEvent(this.channel, { detail: this.session() })
        : new Event(this.channel);
      window.dispatchEvent(ev);
    }
    if (this.bc) this.bc.postMessage('changed');
  }
}
