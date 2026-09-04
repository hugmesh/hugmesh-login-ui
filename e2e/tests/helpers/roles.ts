import { Browser, BrowserContext, Page, expect } from '@playwright/test';

/** Mirror of the NON-SECRET session metadata the app's SessionService holds in
 *  memory and mirrors onto the `__HUG_SESSION__` probe (src/app/session.service.ts
 *  `SnapSession`). Deliberately has NO token field: the browser never holds a
 *  bearer — auth rides in the httpOnly `bff_` cookie. login-ui #3 retired the
 *  localStorage session MODE, not this projection: the same five non-secret
 *  fields are also published to the `hug.session` fleet mirror
 *  ({@link FLEET_SESSION_MIRROR_KEY}) as a compat transport for the remotes that
 *  have not migrated. The probe is the read surface for THIS app's own state;
 *  the mirror is what the rest of the fleet reads. */
export interface ProbedSnapSession {
  id: string;
  label: string;
  provider: 'google' | 'discord' | 'oidc' | 'password';
  roles: string[];
  registrationComplete: boolean;
}

/**
 * Catalogue of login fixtures for hugmesh-login-ui. THIS remote's OWN
 * username/password form is the only login surface — the browser is NEVER
 * redirected to Casdoor. The form POSTs `{ username, password }` to
 * `POST /bff/login`; the user-bff drives Casdoor's INTERNAL login + PKCE code
 * exchange SERVER-SIDE and mints the opaque `bff_` cookie (Set-Cookie).
 *
 * The `status` tag drives which outcome a scenario asserts:
 *  - `active`     a valid sign-in reaches the host landing (or the
 *                 complete-registration view, when `registered` is false).
 *  - `mfa`        the BFF answers `mfaRequired:true` — the view shows the MFA
 *                 challenge and the sign-in re-POSTs with `mfaPasscode`.
 *  - `invalid`    the BFF rejects sign-in (HTTP 401) → the error live region
 *                 announces "Sign-in failed".
 *  - `banned` /   the BFF refuses sign-in with an `account_banned` /
 *    `suspended`  `account_suspended` token (+ optional reason). The login view
 *                 auto-routes to `/login/appeal?reason=` (announced) rather than
 *                 showing the raw token — see login-blocked.feature.
 *
 * `registered=false` models the two-stage flow: a signed-in identity that has
 * NOT completed stage two, so the login view shows the complete-registration
 * ("pending") gate rather than navigating home.
 */
export interface LoginFixture {
  /** Fixture key + the persona's display label. */
  handle: string;
  /** The username typed into our native form (defaults to {@link handle}). */
  username?: string;
  /** The password typed into our native form. */
  password?: string;
  /** The provider tag a scenario expects on the in-memory session. Native
   *  sign-ins (the password form or a local role) mint a `password` session;
   *  the appeal-submit scenarios model a live cookie through a mocked
   *  `GET /bff/session` instead of a sign-in and never read this. */
  provider: 'google' | 'discord' | 'oidc' | 'password';
  /** Expected sign-in outcome the (mocked/live) BFF produces. */
  status: 'active' | 'mfa' | 'invalid' | 'banned' | 'suspended';
  /** Whether the account has completed the two-stage registration. */
  registered: boolean;
  /** The MFA factor types the BFF offers when `status==='mfa'`. */
  mfaType?: string[];
  /** The lowercase platform roles the BFF reports for this identity (RBAC
   *  superadmin > admin > mod > user, always lowercase). */
  roles?: string[];
}

export const LOGIN_FIXTURES: LoginFixture[] = [
  // Happy-path, fully-registered — signs in and reaches the host landing.
  { handle: 'alice@gmail.com', username: 'alice', password: 'correct-horse', provider: 'password', status: 'active', registered: true, roles: ['user'] },

  // Pending: signed in but has NOT completed stage two — the login view must
  // show the complete-registration gate, not navigate home.
  { handle: 'carol@gmail.com', username: 'carol', password: 'correct-horse', provider: 'password', status: 'active', registered: false },

  // MFA: the BFF answers mfaRequired → the view shows the passcode challenge and
  // the sign-in re-POSTs /bff/login with the passcode.
  { handle: 'mfa-user', username: 'mfa-user', password: 'correct-horse', provider: 'password', status: 'mfa', registered: true, mfaType: ['totp'] },

  // DENY: wrong credentials — the BFF rejects sign-in (401).
  { handle: 'nobody', username: 'nobody', password: 'wrong-password', provider: 'password', status: 'invalid', registered: true },

  // Persona for the appeal-submit feature: the "still holds a live bff_ cookie"
  // precondition is a mocked GET /bff/session (nothing is seeded into web
  // storage — there is no session storage to seed since login-ui #3).
  { handle: 'suspended@gmail.com', username: 'suspended', password: 'correct-horse', provider: 'password', status: 'active', registered: true },

  // BLOCKED persona — a banned/suspended account whose fresh sign-in is refused
  // with an account_banned/account_suspended token and auto-routed to the appeal
  // page (login-blocked.feature). Offline scenarios mock /bff/login to produce
  // the token; the @cluster twin drives a genuinely-blocked account on the live
  // integration host.
  { handle: 'bob_banned', username: 'bob', password: 'correct-horse', provider: 'password', status: 'banned', registered: true },

  // ── Role personas (RBAC superadmin > admin > mod > user) ──────────────────
  { handle: 'role-user@gmail.com',       username: 'role-user',       password: 'correct-horse', provider: 'password', status: 'active', registered: true, roles: ['user'] },
  { handle: 'role-mod@gmail.com',        username: 'role-mod',        password: 'correct-horse', provider: 'password', status: 'active', registered: true, roles: ['user', 'mod'] },
  { handle: 'role-admin@gmail.com',      username: 'role-admin',      password: 'correct-horse', provider: 'password', status: 'active', registered: true, roles: ['user', 'admin'] },
  { handle: 'role-superadmin@gmail.com', username: 'role-superadmin', password: 'correct-horse', provider: 'password', status: 'active', registered: true, roles: ['user', 'admin', 'superadmin'] },
];

/** The data-testid contract the login view exposes (login.component.html). The
 *  selectors are centralised so a template rename localises to one place. */
export const SELECTORS = {
  loginView: '[data-testid="login-view"]',
  completeView: '[data-testid="complete-view"]',
  error: '[data-testid="login-error"]',
  appealView: '[data-testid="appeal-view"]',
  appealReason: '[data-testid="appeal-reason"]',
  appealLink: '[data-testid="login-appeal-link"]',
  completeButton: '[data-testid="login-complete"]',
  // The complete-registration display-name/screen-reader-name fields
  // (login.component.html) — required-display-name contract coverage.
  displayNameInput: '[data-testid="register-display-name"]',
  screenReaderNameInput: '[data-testid="register-screen-reader-name"]',
  screenReaderHelp: '[data-testid="register-screen-reader-help"]',
  // OUR OWN native username/password login surface (the only login surface).
  usernameInput: '[data-testid="login-username"]',
  passwordInput: '[data-testid="login-password"]',
  submitButton: '[data-testid="login-submit"]',
  // The inline MFA challenge shown on an mfaRequired response.
  mfaCodeInput: '[data-testid="login-mfa-code"]',
  mfaSubmitButton: '[data-testid="login-mfa-submit"]',
  // The self-service security page (mfa-security.component.html).
  securityView: '[data-testid="mfa-security-view"]',
} as const;

/**
 * The `hug.session` localStorage FLEET MIRROR key — a non-secret projection of
 * the session, published by SessionService as a compat TRANSPORT (never
 * custody) for hugmesh-host-shell and the eleven sibling remotes that still
 * read their whole session from this key and never call `GET /bff/session`.
 *
 * What login-ui #3 retired is the localStorage session MODE: the app never
 * SEEDS itself from this key, takes no roles from it, and a forged value grants
 * nothing — only a 2xx `/bff/session` can produce a session. So the harness
 * asserts both halves: present and carrying the SERVER's roles while signed in
 * ({@link readFleetMirror}), and gone after a sign-out.
 */
export const FLEET_SESSION_MIRROR_KEY = 'hug.session';

/**
 * The NON-SECRET post-hydrate session probe the SessionService mirrors onto
 * `globalThis` (src/app/session.service.ts `SESSION_PROBE`). The hydrated
 * session lives in the in-memory signal; the fleet mirror is an OUTBOUND
 * transport for other apps and is never read back into it, so this global is
 * the black-box surface for THIS app's own hydrated state. */
export const SESSION_PROBE = '__HUG_SESSION__';

/** The username typed for a fixture (defaults to its handle). */
export function usernameFor(fixture: LoginFixture): string {
  return fixture.username ?? fixture.handle;
}

/**
 * Create a fresh browser context that trusts the integration-test self-signed
 * cert AND pins the same baseURL as the playwright config. `browser.newContext`
 * does NOT inherit project-level `use` options, so a manually-opened context
 * misses `ignoreHTTPSErrors` and every HTTPS request fails the cert check.
 */
export async function newE2eContext(browser: Browser): Promise<BrowserContext> {
  return await browser.newContext({
    ignoreHTTPSErrors: true,
    baseURL: process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8080',
  });
}

/**
 * Wait for the federated login form to be interactable. The host shell loads
 * this remote lazily; `domcontentloaded` fires before the federation runtime
 * finishes, so we poll for the login view and recover via the host's federation
 * retry button if the first manifest fetch flaked.
 */
export async function ensureLoginFormReady(page: Page): Promise<void> {
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      await page.locator(SELECTORS.loginView).waitFor({ state: 'visible', timeout: 8_000 });
      return;
    } catch {
      const retry = page.locator('button.federation-error-retry');
      if ((await retry.count()) > 0) {
        await retry.click();
      } else {
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
    }
  }
  await page.locator(SELECTORS.loginView).waitFor({ state: 'visible', timeout: 15_000 });
}

/**
 * Drive OUR OWN native username/password sign-in: type the credentials into the
 * login-ui form and submit it. The browser is never redirected to Casdoor — the
 * BFF brokers Casdoor server-side. Does NOT assert the outcome; the calling step
 * decides ALLOW (landing / complete-view / MFA challenge) vs DENY (error).
 */
export async function signIn(page: Page, fixture: LoginFixture): Promise<void> {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await ensureLoginFormReady(page);
  await page.fill(SELECTORS.usernameInput, usernameFor(fixture));
  await page.fill(SELECTORS.passwordInput, fixture.password ?? '');
  await page.click(SELECTORS.submitButton);
}

/** Submit a passcode into the inline MFA challenge (the mfaRequired re-POST). */
export async function completeMfaChallenge(page: Page, passcode: string): Promise<void> {
  await page.locator(SELECTORS.mfaCodeInput).waitFor({ state: 'visible', timeout: 15_000 });
  await page.fill(SELECTORS.mfaCodeInput, passcode);
  await page.click(SELECTORS.mfaSubmitButton);
}

/**
 * Read the `hug.session` fleet mirror as the not-yet-migrated remotes would:
 * parse it, or answer `null` when the key is absent or unparseable. This is the
 * value hugmesh-admin-ui/mod-ui/... load their entire session from, so it is
 * what a fleet-wide "signed in everywhere / signed out everywhere" assertion
 * must read — the `__HUG_SESSION__` probe only proves login-ui's own state.
 */
export async function readFleetMirror(page: Page): Promise<ProbedSnapSession | null> {
  return await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as ProbedSnapSession;
    } catch {
      return null;
    }
  }, FLEET_SESSION_MIRROR_KEY);
}

/** What a not-yet-migrated sibling remote decides about the current browser,
 *  computed by {@link evaluateFleetRemoteGuard}. */
export interface FleetRemoteVerdict {
  loggedIn: boolean;
  isAdmin: boolean;
  /** `true` = the route activates; `'/login'` = the guard returned a redirect. */
  guard: true | '/login';
}

/**
 * Run a not-yet-migrated sibling remote's OWN session reader and route guard,
 * verbatim, inside this page — against the real `hug.session` value login-ui
 * published.
 *
 * This is the fleet contract that login-ui's `__HUG_SESSION__` probe cannot
 * see. Every sibling remote holds its own SessionService whose sole source of
 * truth is this key and which never calls `GET /bff/session`
 * (hugmesh-admin-ui/mod-ui/forum-ui/user-ui/wiki-ui/tube-ui/owncast-ui/
 * mastodon-ui/api-docs + hugmesh-host-shell), and its guards bounce on the
 * signal that produces. The two lines below are hugmesh-admin-ui's
 * `SessionService.load()` (`raw ? JSON.parse(raw) : null`, null on any parse
 * error), its `isAdmin` computed (`(session?.roles ?? []).includes('admin')`)
 * and `admin.guard.ts` (`session.isAdmin() ? true : router.parseUrl('/login')`).
 *
 * Asserting on this is what would have caught the role-home lockout: login-ui
 * can be perfectly signed in on its own probe while every other role-home reads
 * "anonymous".
 */
export async function evaluateFleetRemoteGuard(page: Page): Promise<FleetRemoteVerdict> {
  return await page.evaluate((key) => {
    // hugmesh-admin-ui SessionService.load()
    let session: { roles?: string[] } | null = null;
    try {
      const raw = window.localStorage.getItem(key);
      session = raw ? JSON.parse(raw) : null;
    } catch {
      session = null;
    }
    // ...its loggedIn / isAdmin computeds, and adminGuard's decision.
    const isAdmin = (session?.roles ?? []).includes('admin');
    return { loggedIn: session !== null, isAdmin, guard: isAdmin ? (true as const) : ('/login' as const) };
  }, FLEET_SESSION_MIRROR_KEY);
}

/**
 * Read the non-secret post-hydrate session probe off `globalThis`
 * ({@link SESSION_PROBE}). Null when logged out or before hydrate.
 */
export async function readSessionProbe(page: Page): Promise<ProbedSnapSession | null> {
  return await page.evaluate(
    (key) => (globalThis as Record<string, unknown>)[key] ?? null,
    SESSION_PROBE,
  ) as ProbedSnapSession | null;
}

/**
 * Poll until the cookie-custody session has hydrated (the probe carries a
 * roles[] array) and return it. expect.poll-based — the platform's wait idiom.
 */
export async function waitForSessionProbeRoles(
  page: Page,
  timeoutMs = 10_000,
): Promise<ProbedSnapSession> {
  await expect
    .poll(async () => Array.isArray((await readSessionProbe(page))?.roles), {
      timeout: timeoutMs,
      message: `the in-memory session hydrates with a roles[] within ${timeoutMs}ms`,
    })
    .toBe(true);
  return (await readSessionProbe(page)) as ProbedSnapSession;
}
