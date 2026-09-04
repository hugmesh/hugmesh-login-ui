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
 * The session's AUTHORITY lives in the httpOnly cookie and its in-memory
 * projection lives in the signal; the only web-storage surface is the fleet
 * mirror ({@link FLEET_MIRROR_KEY}), which is a compat TRANSPORT for the
 * not-yet-migrated remotes and deliberately not the read surface a test of THIS
 * service's roles→signal mapping should assert on. Without this probe that
 * mapping's end-to-end faithfulness (no drop, no up-case) would be unobservable
 * outside the unit tests.
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
 *    signed in or out. It is the PRIMARY cross-tab transport: the fleet mirror's
 *    `storage` event carries the same news to a sibling login-ui tab, but only
 *    when the stored bytes actually change, and a migrated fleet will stop
 *    writing that key altogether.
 */
const SESSION_CHANNEL = 'hug-session-change';

/**
 * The `hug.session` NON-SECRET session mirror in localStorage.
 *
 * A COMPAT TRANSPORT, never custody. Auth is the httpOnly `bff_` cookie and
 * nothing else; this key has never held a token and does not hold one now (the
 * projection written here is the same non-secret metadata as the
 * {@link SESSION_PROBE} global: id/label/provider/roles/registrationComplete).
 *
 * WHY IT IS STILL WRITTEN. login-ui is the fleet's only sign-in surface and the
 * only remote that reads the server's real roles, and the rest of the fleet has
 * NOT migrated: hugmesh-host-shell plus eleven sibling remotes (admin, mod,
 * forum, user, user-mesh, wiki, tube, owncast, mastodon, api-docs,
 * superadmin-service-catalog) each hold their OWN SessionService whose sole
 * source of session truth is `localStorage['hug.session']` — not one of them
 * calls `GET /bff/session` — and their route guards bounce on the signal they
 * load from it (hugmesh-admin-ui `adminGuard`: `session.isAdmin() ? true :
 * router.parseUrl('/login')`; the same shape in mod/superadmin/fleet/
 * workload-console/games-services). Retiring the WRITE while those READERS
 * remain therefore locks every role-home out immediately after a successful
 * sign-in: the session reaches login-ui and the host-shell chrome and nobody
 * else. So the write stays as an explicitly-scoped shim, removable in one
 * commit ({@link SessionService.publishMirror}) once the readers hydrate from
 * `/bff/session` themselves.
 *
 * WHAT #3 ACTUALLY RETIRED, and still is retired: the localStorage session
 * MODE. This service never seeds itself from the key (a forged mirror grants
 * nothing — {@link SessionService.session} starts null and only a 2xx
 * `/bff/session` can make it non-null), never takes roles or
 * registrationComplete from it, and the `__HUG_SESSION_COOKIE_MODE__` /
 * `SNAP_SESSION_COOKIE_MODE` switch is gone for good.
 *
 * It is also the only sign-out signal that crosses tabs from a not-yet-migrated
 * host shell, which posts on no BroadcastChannel — see
 * {@link SessionService.onMirrorStorage}.
 */
const FLEET_MIRROR_KEY = 'hug.session';

/** The provider tags a mirror value may legitimately carry (see SnapSession). */
const PROVIDERS: readonly SnapSession['provider'][] = ['google', 'discord', 'oidc', 'password'];

/**
 * Did this failure carry an ANSWER about the session, as opposed to no answer at
 * all?
 *
 * Only an answer may sign the user out, and that distinction is load-bearing in
 * {@link SessionService.hydrate} now that a sign-out here removes the fleet
 * mirror and therefore signs the user out of every not-yet-migrated remote too.
 * Two failure classes carry no answer:
 *
 *  • **status 0** — Angular's `HttpErrorResponse` reports it for a request that
 *    never reached a server at all: DNS failure, connection refused, offline, a
 *    blocked or aborted request.
 *  • **5xx** — something in the path (the gateway, or admin-bff itself while it
 *    is dark or restarting) failed to produce a verdict. A 502/503/504 says the
 *    BFF could not be asked, NOT that the cookie is dead; treating a rolling
 *    restart as a fleet-wide sign-out is exactly the blast radius this guard
 *    exists to avoid.
 *
 * Everything else IS an answer and still signs out: 401/403 (the cookie is
 * expired or rejected), a 404 (this remote is pointed at the wrong BFF), and —
 * conservatively — any rejection with no numeric status at all, e.g. an
 * unusable body from the generated client. Duck-typed rather than `instanceof`
 * so a rejection from anywhere in that pipeline is judged on the same rule.
 */
function isInconclusive(err: unknown): boolean {
  const status = (err as { status?: unknown } | null)?.status;
  return typeof status === 'number' && (status === 0 || status >= 500);
}

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
 *  • it is never AUTHORITATIVE in web storage: the signal starts null, only a
 *    2xx `/bff/session` can make it non-null, and the localStorage session MODE
 *    (`__HUG_SESSION_COOKIE_MODE__` / `SNAP_SESSION_COOKIE_MODE`) is gone — see
 *    hugmesh-login-ui issue #3. The non-secret projection IS still published to
 *    the `hug.session` fleet mirror ({@link FLEET_MIRROR_KEY}) as a transport
 *    shim, because eleven sibling remotes still read their whole session from
 *    that key and none of them hydrates; a sign-out removes it, which is how a
 *    not-yet-migrated remote learns to drop its own session;
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
 *    two tabs would re-hydrate each other forever. A sibling tab's `storage`
 *    event for the legacy `hug.session` mirror (a host-shell sign-out there) is
 *    treated as the same signal — re-hydrate, never read the value.
 */
@Injectable({ providedIn: 'root' })
export class SessionService implements OnDestroy {
  private readonly channel = SESSION_CHANNEL;
  /** Cross-tab channel — the primary way another tab learns of a sign-in/out
   *  (the fleet mirror's `storage` event is the secondary, legacy one). */
  private readonly bc: BroadcastChannel | null;
  /** The generated, typed admin-bff client. `/bff/session` + `/bff/sessionOut` are
   *  CREDENTIALED calls, so both go out with {@link withBffCredentials} — the
   *  generated transport sends the httpOnly `bff_` cookie only when asked. */
  private readonly auth = inject(AuthControllerService);
  /** Starts EMPTY and is only ever filled by a 2xx `GET /bff/session`: the
   *  cookie is the source of truth. The fleet mirror is WRITTEN from this
   *  signal, never read back into it, so a forged mirror grants nothing. */
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

  /**
   * Compat bridge for the not-yet-migrated fleet (transport only, never
   * custody). The host shell's `clear()` removes the `hug.session` mirror and
   * its status sync re-writes it; neither posts on the BroadcastChannel, so the
   * `storage` event that write raises in every OTHER tab is the only way a
   * host-shell sign-out over there reaches this tab. It is treated exactly like
   * a channel message — "the server-side session may have changed, ask the
   * cookie": the value is never adopted, only `GET /bff/session` decides.
   *
   * The one thing the value IS used for is a cheap identity check. This service
   * publishes the mirror itself now ({@link publishMirror}), so an incoming
   * event can be a sibling login-ui tab merely re-confirming the session this
   * tab already holds. When the incoming bytes are exactly what this tab would
   * write, there is nothing to learn — and re-reading would answer with the
   * same value, write it back, and wake the other tab again, which is how two
   * open tabs would hydrate each other forever. A removal (`newValue === null`)
   * or any different value always re-reads.
   *
   * It cannot self-trigger: `storage` never fires in the writing document.
   */
  private readonly onMirrorStorage = (e: StorageEvent): void => {
    if (e.key !== FLEET_MIRROR_KEY) return;
    if (e.newValue !== null && e.newValue === this.mirrorValue(this.session())) return;
    void this.hydrate();
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
      window.addEventListener('storage', this.onMirrorStorage);
    }
  }

  /**
   * Detach from every transport (same-document event, BroadcastChannel, the
   * fleet-mirror `storage` bridge) when this injector is torn down (an
   * unmounted federated remote, and every unit test's TestBed).
   *
   * The handlers RE-HYDRATE from `/bff/session` (or adopt a sibling's write),
   * so a dead instance left listening would keep issuing credentialed requests
   * on an injector that no longer exists — and, worse, ANNOUNCE what it read to
   * the live instances (a dead copy's stale hydrate landing after a live sign-in
   * would overwrite the live session's identity). {@link destroyed} makes an
   * already in-flight read inert for the same reason.
   */
  ngOnDestroy(): void {
    this.destroyed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener(this.channel, this.onSameDocumentChange);
      window.removeEventListener('storage', this.onMirrorStorage);
    }
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
   *
   * A read that ANSWERED stays memoised, 401 included — an anonymous visitor
   * clicking around the login views must not re-ask on every route activation.
   * A read that answered nothing ({@link isInconclusive}: unreachable, or a 5xx
   * from a dark BFF) does NOT: {@link hydrate} clears the memo so the next entry
   * retries (see its catch).
   */
  ensureHydrated(): Promise<SnapSession | null> {
    this.bootstrapHydrate ??= this.hydrate();
    return this.bootstrapHydrate;
  }

  /** The SINGLE place the session signal is written — and therefore the single
   *  place both non-secret projections are kept in lockstep with it: the
   *  {@link SESSION_PROBE} global (a black-box read surface for e2e) and the
   *  {@link FLEET_MIRROR_KEY} localStorage mirror (the transport the
   *  not-yet-migrated remotes read their whole session from). The mirror is
   *  written BEFORE any caller notifies anyone, so a listener that re-reads
   *  storage on the notification sees the new value, never the old one. */
  private setSession(s: SnapSession | null): void {
    this.session.set(s);
    this.publish(s);
    this.publishMirror(s);
  }

  /** The exact bytes this service would store in the fleet mirror for `s`, or
   *  `null` for "no session, the key must not exist". The projection is the
   *  same non-secret metadata as {@link publish} — never a token, never the
   *  cookie. */
  private mirrorValue(s: SnapSession | null): string | null {
    return s
      ? JSON.stringify({
          id: s.id,
          label: s.label,
          provider: s.provider,
          roles: s.roles,
          registrationComplete: s.registrationComplete,
        })
      : null;
  }

  /**
   * Publish the session to the {@link FLEET_MIRROR_KEY} mirror, or remove the
   * key on a sign-out. The write is what keeps the eleven not-yet-migrated
   * remotes seeing the signed-in user (and the correct ROLES — a mod/admin
   * whose mirror still said `['user']` was the 2026-08-14 role-home lockout);
   * the removal is what signs them out.
   *
   * IDEMPOTENT ON PURPOSE: it compares the stored bytes first and writes only on
   * a real change, so a tab that merely re-confirms what is already there raises
   * no `storage` event in its siblings. Together with {@link onMirrorStorage}'s
   * equality check that is what makes two open tabs CONVERGE rather than
   * re-hydrate each other forever.
   *
   * Web storage can be unavailable or full (a private-mode browser, a
   * quota-exceeded profile) and both `getItem` and `setItem` THROW there. The
   * mirror is a convenience for other apps, never this one's source of truth,
   * so a failure is swallowed: this session stays valid on its cookie.
   */
  private publishMirror(s: SnapSession | null): void {
    try {
      if (typeof localStorage === 'undefined') return;
      const next = this.mirrorValue(s);
      if (localStorage.getItem(FLEET_MIRROR_KEY) === next) return;
      if (next === null) localStorage.removeItem(FLEET_MIRROR_KEY);
      else localStorage.setItem(FLEET_MIRROR_KEY, next);
    } catch {
      // Storage unavailable/full — the httpOnly cookie still holds the session.
    }
  }

  /**
   * The IDENTITY fields (id/label/provider) the fleet mirror currently carries,
   * or null when there is no usable mirror. Display metadata ONLY: roles and
   * registrationComplete are never taken from here — they come from
   * `/bff/session` on every hydrate — and a session is never created from this
   * value, so a forged or stale mirror can spoof a name in this browser and
   * grant nothing.
   *
   * {@link hydrate} prefers it over its own in-memory prior so that every tab
   * and every remote resolves the SAME identity for one cookie: two tabs that
   * each kept a different label would otherwise write the mirror back and forth
   * forever. It is also what restores the signed-in name across the hard
   * navigation out of this remote, which `/bff/session` cannot report.
   */
  private mirrorIdentity(): Partial<Pick<SnapSession, 'id' | 'label' | 'provider'>> | null {
    try {
      if (typeof localStorage === 'undefined') return null;
      const raw = localStorage.getItem(FLEET_MIRROR_KEY);
      if (!raw) return null;
      const m = JSON.parse(raw) as Record<string, unknown> | null;
      if (!m || typeof m !== 'object') return null;
      const provider = m['provider'] as SnapSession['provider'];
      return {
        id: typeof m['id'] === 'string' ? (m['id'] as string) : undefined,
        label: typeof m['label'] === 'string' ? (m['label'] as string) : undefined,
        provider: PROVIDERS.includes(provider) ? provider : undefined,
      };
    } catch {
      return null;
    }
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

  /** Reflect a just-established session (a sign-in wrote the cookie). Updates
   *  the signal, republishes the non-secret probe + fleet mirror, then tells the
   *  in-page siblings AND the other tabs. */
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
   * browser throws — neither may strand the user signed-in locally. Dropping
   * local state also REMOVES the fleet mirror, which is how the not-yet-migrated
   * remotes (whose only session source it is) learn to sign out too.
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
      // IDENTITY is not reported by /bff/session (the cookie session is
      // identified server-side), so it is carried over rather than invented:
      // the fleet mirror FIRST — that is the one value every tab and every
      // remote agrees on for this cookie, which is what makes repeated
      // cross-tab hydrates converge instead of two tabs writing their own
      // labels back and forth, and it is what restores the signed-in name
      // across the hard navigation out of this remote — then whatever this
      // instance already established, then the blank bootstrap identity.
      // ROLES and registrationComplete are NEVER carried over: they are read
      // from the server on every hydrate, so a stale mirror cannot grant a tier.
      const mirror = this.mirrorIdentity();
      const prior = this.session();
      const s: SnapSession = {
        id: mirror?.id ?? prior?.id ?? '',
        label: mirror?.label ?? prior?.label ?? '',
        // No known identity at all (a bootstrap hydrate of a live cookie in a
        // fresh browser): tag 'oidc' when the host says the OIDC login path is
        // on, else the vestigial 'google' placeholder — no UI logic reads this
        // value (see the SnapSession.provider comment), so the tag itself is
        // not load-bearing.
        provider: mirror?.provider ?? prior?.provider ?? (oidcEnabled() ? 'oidc' : 'google'),
        roles: data.roles ?? ['user'],
        registrationComplete: !!data.registrationComplete,
      };
      this.setSession(s);
      this.notifySiblings();
      return s;
    } catch (err) {
      if (this.destroyed) return null;
      // A read that produced no ANSWER about the session (unreachable, or a 5xx
      // from a dark/restarting BFF) proves nothing, and acting on it is
      // destructive twice over now that this service owns the fleet mirror: it
      // would sign the user out of every not-yet-migrated remote (the mirror is
      // removed) on a transient blip, and — because the bootstrap read is
      // memoised — leave them anonymous until a re-login even after the BFF came
      // back. So leave the session, the mirror and the siblings exactly as they
      // are, and let the bootstrap be retried on the next entry into the remote.
      if (isInconclusive(err)) {
        this.bootstrapHydrate = null;
        return this.session();
      }
      // The answer is "not authenticated" (401/403, or any other answering
      // status/unusable body): drop to logged-out locally and remove the
      // mirror. Deliberately NOT /bff/sessionOut (nothing to expire) and NOT a
      // cross-tab post (see above) — in-page siblings adopt the null.
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
