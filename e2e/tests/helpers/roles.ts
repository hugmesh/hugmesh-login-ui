import { Browser, BrowserContext, Page, expect } from '@playwright/test';

/** Mirror of the persisted session shape the app's SessionService writes to
 *  localStorage `hug.session` (src/app/session.service.ts `SnapSession`).
 *  Deliberately has NO token field: the browser never holds a bearer — auth
 *  rides in the httpOnly `bff_` cookie, and only this non-secret metadata is
 *  persisted (localStorage mode only; the cookie custody persists nothing). */
export interface StoredSnapSession {
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
  /** Fixture key + the persona's display label (also the seeded-session label). */
  handle: string;
  /** The username typed into our native form (defaults to {@link handle}). */
  username?: string;
  /** The password typed into our native form. */
  password?: string;
  /** The provider tag stamped on a directly-SEEDED session (protected-route /
   *  appeal-submit seed localStorage without a live sign-in). Native sign-ins
   *  mint a `password` session. */
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

  // Directly-seeded personas for the appeal / protected-route features (no live
  // sign-in — the session is written straight to localStorage).
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

/** The localStorage key the SessionService persists the SnapSession under. */
export const SESSION_KEY = 'hug.session';

/**
 * The NON-SECRET post-hydrate session probe the SessionService mirrors onto
 * `globalThis` (src/app/session.service.ts `SESSION_PROBE`). In cookie custody
 * mode NOTHING is persisted to web storage — the hydrated session lives only in
 * the in-memory signal — so this global is the ONLY black-box surface an offline
 * e2e can read the persona's roles back from. */
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

/** Read the persisted SnapSession off localStorage (null when not signed in). */
export async function readSession(page: Page): Promise<unknown | null> {
  return await page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }, SESSION_KEY);
}

/**
 * Poll until a persisted `hug.session` appears in the page's localStorage
 * (the write lands asynchronously, after the /bff/login fetch resolves) and
 * return it. expect.poll-based — the platform's wait idiom.
 */
export async function waitForStoredSession(
  page: Page,
  timeoutMs = 10_000,
): Promise<StoredSnapSession> {
  await expect
    .poll(async () => (await readSession(page)) !== null, {
      timeout: timeoutMs,
      message: `a hug.session is persisted to localStorage within ${timeoutMs}ms`,
    })
    .toBe(true);
  return (await readSession(page)) as StoredSnapSession;
}

/**
 * Read the non-secret post-hydrate session probe off `globalThis`
 * ({@link SESSION_PROBE}). Null when logged out or before hydrate.
 */
export async function readSessionProbe(page: Page): Promise<StoredSnapSession | null> {
  return await page.evaluate(
    (key) => (globalThis as Record<string, unknown>)[key] ?? null,
    SESSION_PROBE,
  ) as StoredSnapSession | null;
}

/**
 * Poll until the cookie-custody session has hydrated (the probe carries a
 * roles[] array) and return it. expect.poll-based.
 */
export async function waitForSessionProbeRoles(
  page: Page,
  timeoutMs = 10_000,
): Promise<StoredSnapSession> {
  await expect
    .poll(async () => Array.isArray((await readSessionProbe(page))?.roles), {
      timeout: timeoutMs,
      message: `the in-memory session hydrates with a roles[] within ${timeoutMs}ms`,
    })
    .toBe(true);
  return (await readSessionProbe(page)) as StoredSnapSession;
}
