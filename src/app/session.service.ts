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
  // of the shape the host shell shares, and as a hydrate() fallback tag (see
  // hydrate() below). New sessions are 'password' or 'oidc'.
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
 * Nothing about the session is persisted to web storage — the hydrated session
 * lives ONLY in the in-memory signal — so there is no storage surface an e2e can
 * read the roles back from, and the roles→signal mapping's end-to-end
 * faithfulness (no drop, no up-case) would otherwise be unobservable outside the
 * unit tests.
 *
 * This probe mirrors the SAME non-secret metadata the signal already holds
 * (id/label/provider/roles/registrationComplete) onto a host-injected-style
 * `__HUG_*` global whenever the signal changes, so a black-box test can read
 * the exact roles the UI carries post-hydrate. It carries NO token (there is
 * none: auth rides in the httpOnly `bff_` cookie), so the persist-nothing/
 * no-token custody invariant is preserved (this is not web storage and holds no
 * credential).
 */
const SESSION_PROBE = '__HUG_SESSION__';

/** The double-submit CSRF header the admin-bff expects on a MUTATING, non-cookie-
 *  mint request (matches `SecurityConfig.CSRF_HEADER`). The token rides in the
 *  JS-readable `XSRF-TOKEN` cookie (CookieServerCsrfTokenRepository.withHttpOnlyFalse). */
const CSRF_HEADER = 'X-CSRF-TOKEN';
const CSRF_COOKIE = 'XSRF-TOKEN';

/**
 * The CANONICAL session-change seam, used for BOTH transports:
 *  • a same-document `window` event — the name every SessionService copy in the
 *    fleet (host shell + remotes) listens on, so a write in this remote reaches
 *    the host's nav/guards and vice versa;
 *  • a `BroadcastChannel` of the same name — how sibling TABS learn that this tab
 *    signed in or out (nothing is written to web storage, so there is no
 *    `storage` event to ride on).
 */
const SESSION_CHANNEL = 'hug-session-change';

/**
 * Holds the logged-in session and derives the Casdoor-style role flags + the
 * registration-complete gate the host uses to unlock the Matrix/Mastodon
 * micro-frontends.
 *
 * SESSION CUSTODY — httpOnly cookie ONLY (login-ui #3). Auth rides in the
 * httpOnly `bff_` cookie, which the gateway's BffCookieToBearerWebFilter turns
 * into the upstream bearer server-side; every `/bff/*` call sends
 * `credentials: 'include'` and NO `Authorization` header. The NON-SECRET session
 * metadata (id/label/provider/roles/registrationComplete) is held in memory only:
 *  • it is hydrated from `GET /bff/session` (credentials: include) — on every
 *    entry into this remote ({@link ensureHydrated}, via the route guard) and
 *    right after a sign-in;
 *  • it is NEVER persisted to web storage (the former localStorage `hug.session`
 *    mirror and its `__HUG_SESSION_COOKIE_MODE__` switch are gone — see
 *    hugmesh-login-ui issue #3). This service neither reads nor removes a legacy
 *    `hug.session` key that may still be in the browser: the host shell still
 *    owns and re-reads that key on its own, and a removal here would raise a
 *    `storage` event in every sibling tab's host instance — i.e. it would sign
 *    them out visually while their cookie is live;
 *  • mutations echo the double-submit `X-CSRF-TOKEN` header ({@link csrfHeader});
 *  • logout goes via `POST /bff/sessionOut` and AWAITS it before dropping local
 *    state ({@link clear}).
 *
 * CROSS-INSTANCE SYNC. The host shell and each federated remote hold their OWN
 * SessionService instance over the same cookie, and a user may have several tabs:
 *  • same document: a WRITE here dispatches {@link SESSION_CHANNEL} with the
 *    session in `detail`; a sibling in-page instance of THIS service adopts it
 *    without a re-read. A detail-LESS event on the same name (the host shell and
 *    the other remotes dispatch a plain `Event`) means "the session may have
 *    changed — ask the server", so it triggers an authoritative re-hydrate here
 *    rather than being mistaken for "logged out";
 *  • other tabs: only a WRITE of server state — a sign-in ({@link set}) or a
 *    sign-out ({@link clear}) — posts on the channel; the receiving tab
 *    re-hydrates from the cookie. A hydrate is a READ and never posts, otherwise
 *    two tabs would re-hydrate each other forever.
 */
@Injectable({ providedIn: 'root' })
export class SessionService implements OnDestroy {
  private readonly channel = SESSION_CHANNEL;
  /** Cross-tab channel (nothing is written to web storage, so `storage` events
   *  cannot fire; this is the only way another tab learns of a sign-in/out). */
  private readonly bc: BroadcastChannel | null;
  /** The generated, typed admin-bff client. `/bff/session` + `/bff/sessionOut` are
   *  CREDENTIALED calls, so both go out with {@link withBffCredentials} — the
   *  generated transport sends the httpOnly `bff_` cookie only when asked. */
  private readonly auth = inject(AuthControllerService);
  /** Starts EMPTY: the cookie is the source of truth and is read via
   *  {@link hydrate}, never from web storage. */
  readonly session = signal<SnapSession | null>(null);
  readonly loggedIn = computed(() => this.session() !== null);
  readonly isAdmin = computed(() => (this.session()?.roles ?? []).includes('admin'));
  /** Matrix/Mastodon are usable only after full registration completes. */
  readonly fullyRegistered = computed(() => this.session()?.registrationComplete === true);
  /** The bootstrap hydrate, memoised so every entry into the remote shares ONE
   *  `/bff/session` read (see {@link ensureHydrated}). */
  private bootstrapHydrate: Promise<SnapSession | null> | null = null;
  /** Set by {@link ngOnDestroy}: a torn-down instance must neither act on nor
   *  announce the result of a read that was still in flight. */
  private destroyed = false;

  /**
   * Same-document session-change handler. A sibling in-page instance of THIS
   * service carries the authoritative session in the event `detail` (a
   * `SnapSession`, or `null` for a sign-out) — adopt it as-is, no re-read. A
   * detail-LESS event is a foreign broadcaster (the host shell / the other
   * remotes dispatch a plain `Event` after their own writes): the session MAY
   * have changed, so ask the server rather than mistaking "no detail" for
   * "no session" — that misreading would sign this remote out visually every
   * time the host synced its account status.
   *
   * An arrow-function field (not a method) so the very same reference can be
   * detached again in {@link ngOnDestroy}.
   */
  private readonly onSameDocumentChange = (ev: Event): void => {
    const detail = (ev as CustomEvent<SnapSession | null | undefined>).detail;
    if (detail === undefined) { void this.hydrate(); return; }
    this.setSession(detail);
  };

  constructor() {
    // Pin the generated client to the host-provided BFF origin so the wire URL is
    // identical to the legacy `${__HUG_BFF_URL__}/bff/...` path (same pattern as
    // PublicAnnouncementsService / AppealContactService).
    this.auth.rootUrl = CFG.bff;
    // Keep the non-secret probe in lockstep with the (empty) initial signal state.
    this.publish(this.session());
    this.bc = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(this.channel) : null;
    if (typeof window !== 'undefined') {
      window.addEventListener(this.channel, this.onSameDocumentChange);
      // Another TAB signed in or out → re-hydrate from the BFF (the httpOnly
      // cookie is the source of truth; nothing crosses tabs via web storage).
      if (this.bc) this.bc.onmessage = () => { void this.hydrate(); };
    }
  }

  /**
   * Detach from both transports when this injector is torn down (an unmounted
   * federated remote, and every unit test's TestBed).
   *
   * Both handlers RE-HYDRATE from `/bff/session` (or adopt a sibling's write),
   * so a dead instance left listening would keep issuing credentialed requests
   * on an injector that no longer exists — and, worse, ANNOUNCE what it read to
   * the live instances (a dead copy's stale hydrate landing after a live sign-in
   * would overwrite the live session's identity). {@link destroyed} makes an
   * already in-flight read inert for the same reason.
   */
  ngOnDestroy(): void {
    this.destroyed = true;
    if (typeof window !== 'undefined') window.removeEventListener(this.channel, this.onSameDocumentChange);
    this.bc?.close();
  }

  /**
   * The ONE bootstrap hydrate for this instance: the session is not persisted,
   * so a fresh document (a reload, a deep link to `/login/appeal`, a lazily
   * mounted remote) learns whether the browser holds a live cookie only by
   * asking `GET /bff/session`. Memoised — repeated route activations share the
   * same read; later changes arrive through {@link set}/{@link clear} and the
   * broadcasts. Never blocks rendering: callers fire-and-forget it and the
   * signal-driven views update when it resolves.
   */
  ensureHydrated(): Promise<SnapSession | null> {
    this.bootstrapHydrate ??= this.hydrate();
    return this.bootstrapHydrate;
  }

  /** The SINGLE place the session signal is written. Also mirrors the non-secret
   *  metadata onto the {@link SESSION_PROBE} global so a black-box e2e can read
   *  the post-hydrate roles (nothing is persisted to web storage — the signal is
   *  the only source of truth). */
  private setSession(s: SnapSession | null): void {
    this.session.set(s);
    this.publish(s);
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

  /** Reflect a just-established session (a sign-in wrote the cookie). In-memory
   *  only; tells the in-page siblings AND the other tabs. */
  set(s: SnapSession): void {
    this.setSession(s);
    this.notifySiblings();
    this.notifyTabs();
  }
  patch(p: Partial<SnapSession>): void { const s = this.session(); if (s) this.set({ ...s, ...p }); }

  /**
   * Sign out. EXPIRES THE SERVER SESSION FIRST, and AWAITS it.
   *
   * Auth lives in the httpOnly `bff_` cookie, so logout must hit the real
   * endpoint (`POST /bff/sessionOut` deletes the server session + expires the
   * cookie); dropping local state alone would leave the browser authenticated.
   * The ORDER is the contract: every notification below makes a sibling tab (and
   * the host shell's in-page instance) re-read `/bff/session` — fired before the
   * cookie is dead, that re-read gets a 200 and puts the session straight back
   * (the "sign-out did not sign out" defect the host shell fixed in its own copy).
   * Best-effort on the RESULT only: an already-dead cookie 401s and an offline
   * browser throws — neither may strand the user signed-in locally.
   */
  async clear(): Promise<void> {
    try {
      // The CSRF token is exempt for /bff/sessionOut server-side (a cookie-mint
      // endpoint), but we still send the credentials. HttpClient ERRORS on a
      // non-2xx; the catch swallows it — the local sign-out happens regardless.
      await firstValueFrom(this.auth.authSessionOut({}, withBffCredentials(this.csrfHeader())));
    } catch {
      // Deliberately swallowed — local sign-out must still happen when the
      // network is down or the cookie was already gone.
    }
    if (this.destroyed) return;
    this.setSession(null);
    this.notifySiblings();
    this.notifyTabs();
  }

  /**
   * Hydrate the session from `GET /bff/session` (credentials: include) — the
   * httpOnly `bff_` cookie carries auth, so the UI cannot read the token from JS
   * and learns {roles, registrationComplete, mfaSatisfied} from this endpoint. A
   * non-OK response means "not logged in" → drop to null.
   *
   * Called right after a sign-in (bff.service.ts — the server's REAL roles must
   * replace the hardcoded `roles: ['user']` guess login() writes first, or a
   * mod/admin/superadmin looks like a plain user to every role-gated consumer;
   * operator report 2026-08-14), on every entry into the remote
   * ({@link ensureHydrated}), and whenever another tab or a foreign in-page
   * broadcaster reports a change.
   *
   * The hydrated session carries NO token (auth rides in the cookie); the
   * id/label/provider are not exposed by `/bff/session`, so whatever identity
   * the CALLER already established is kept (login() sets label=<username>,
   * which the shell renders in its nav) — only the server-owned fields are
   * authoritative here.
   *
   * A hydrate is a READ: it reflects the result in-page (siblings adopt the
   * detail) but NEVER posts on the cross-tab channel — the receiving tab's
   * handler is itself a hydrate, so posting here would ping-pong `/bff/session`
   * between tabs forever.
   */
  async hydrate(): Promise<SnapSession | null> {
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
      if (this.destroyed) return null; // torn down while the read was in flight
      const prior = this.session();
      const s: SnapSession = {
        id: prior?.id ?? '',
        label: prior?.label ?? '',
        // No caller-established identity (a bootstrap hydrate of a live cookie):
        // tag 'oidc' when the host says the OIDC login path is on, else the
        // vestigial 'google' placeholder — no UI logic reads this value (see the
        // SnapSession.provider comment), so the tag itself is not load-bearing.
        provider: prior?.provider ?? (oidcEnabled() ? 'oidc' : 'google'),
        roles: data.roles ?? ['user'],
        registrationComplete: !!data.registrationComplete,
      };
      this.setSession(s);
      this.notifySiblings();
      return s;
    } catch {
      // The cookie is gone/invalid server-side (401) or unreachable: drop to
      // logged-out locally. Deliberately NOT /bff/sessionOut (nothing to expire)
      // and NOT a cross-tab post (see above) — in-page siblings adopt the null.
      if (this.destroyed) return null;
      this.setSession(null);
      this.notifySiblings();
      return null;
    }
  }

  /** The double-submit CSRF header for MUTATING, non-cookie-mint requests. Reads
   *  the JS-readable `XSRF-TOKEN` cookie and echoes it as `X-CSRF-TOKEN`. Empty
   *  (no header) before a token cookie exists — the admin-bff require-matcher
   *  exempts the cookie-mint paths anyway. */
  csrfHeader(): Record<string, string> {
    if (typeof document === 'undefined') return {};
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

  /** Same-document: hand the just-written session (or null) to the other in-page
   *  SessionService instances — sibling copies of this service adopt the detail
   *  directly; the host shell's listener re-hydrates on any event on this name. */
  private notifySiblings(): void {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(this.channel, { detail: this.session() }));
  }

  /** Cross-tab: tell sibling tabs the server-side session changed (sign-in or
   *  sign-out) so they re-hydrate from the cookie. WRITES only — never a read. */
  private notifyTabs(): void {
    this.bc?.postMessage('changed');
  }
}
