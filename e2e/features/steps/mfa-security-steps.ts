// Step definitions backing features/auth/mfa-security.feature — the self-service
// Security section (src/app/mfa-security.component.ts).
//
// This component FETCHES on mount (GET /bff/mfa/factors in its constructor), so
// every scenario mocks that boundary via page.route (the appeal-contact idiom);
// the REAL component -> MfaService -> fetch pipeline runs against the mocked
// reply. Both mutations are step-up gated server-side (403); the remove-403 path
// proves the UI routes to the challenge with a returnTo. NOT @cluster — offline.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

const SECURITY_VIEW = '[data-testid="mfa-security-view"]';
const SECURITY_DARK = '[data-testid="mfa-security-dark"]';
const SECURITY_EMPTY = '[data-testid="mfa-security-empty"]';
const FACTOR_LIST = '[data-testid="mfa-factor-list"]';
const FACTOR = '[data-testid="mfa-factor"]';
const FACTOR_REMOVE = '[data-testid="mfa-factor-remove"]';
const SECURITY_ADD = '[data-testid="mfa-security-add"]';
const REGENERATE = '[data-testid="mfa-security-regenerate"]';
const NEW_RECOVERY = '[data-testid="mfa-new-recovery"]';
const NEW_RECOVERY_CODES = '[data-testid="mfa-new-recovery-codes"]';
const CHALLENGE_VIEW = '[data-testid="mfa-challenge-view"]';
const ENROLL_VIEW = '[data-testid="mfa-enroll-view"]';
const SECURITY_ERROR = '[data-testid="mfa-security-error"]';
const SIGNED_OUT = '[data-testid="mfa-security-signed-out"]';
const SIGNIN_LINK = '[data-testid="mfa-security-signin-link"]';
const LOGIN_USERNAME = '[data-testid="login-username"]';

/**
 * The path a link's href actually resolves to in THIS document — against
 * document.baseURI, exactly as the browser resolves it on click. A substring
 * check on the raw attribute is what let `/login/login/mfa/enroll` through
 * (GUI-32): it contains `/login/mfa/enroll`.
 */
async function resolvedPath(page: import('@playwright/test').Page, selector: string): Promise<string> {
  const link = page.locator(selector);
  await expect(link).toBeVisible();
  const href = (await link.getAttribute('href')) ?? '';
  const base = await page.evaluate(() => document.baseURI);
  return new URL(href, base).pathname;
}

function csv(list: string): string[] {
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

/** Mock GET /bff/mfa/factors with the given payload; other methods continue. */
async function mockFactors(page: import('@playwright/test').Page, factors: unknown[]): Promise<void> {
  await page.route('**/bff/mfa/factors', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ factors }),
    });
  });
}

// ─── Givens — boundary mocks ────────────────────────────────────────────────

Given('the security page lists a TOTP factor and a passkey factor', async ({ page }) => {
  await mockFactors(page, [
    { id: 'factor-totp', type: 'TOTP', enabled: true, createdAt: '2026-01-15' },
    { id: 'factor-passkey', type: 'WEBAUTHN', enabled: true, createdAt: '2026-02-20' },
  ]);
});

Given('the security page reports no factors', async ({ page }) => {
  await mockFactors(page, []);
});

Given('the security endpoints answer dark', async ({ page }) => {
  await page.route('**/bff/mfa/**', async (route) => {
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'dark' });
  });
});

Given('removing a factor requires a fresh step-up', async ({ page }) => {
  // 403 = needs a fresh MFA stamp; the component must route to the step-up
  // challenge rather than swallow it.
  await page.route('**/bff/mfa/factors/**', async (route) => {
    if (route.request().method() !== 'DELETE') return route.continue();
    await route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'step-up required' }),
    });
  });
});

Given('the security page answers that I am not signed in', async ({ page }) => {
  // No bff_ cookie: a 401 with no JSON error body, as measured on the local
  // stack (GUI-32) — the shape that used to render as a bare "HTTP 401".
  await page.route('**/bff/mfa/**', async (route) => {
    await route.fulfill({ status: 401, contentType: 'text/plain', body: '' });
  });
});

Given('regenerating recovery codes returns {string}', async ({ page }, codes: string) => {
  await page.route('**/bff/mfa/recovery/regenerate', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ recoveryCodes: csv(codes) }),
    });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I open the security page', async ({ page }) => {
  await page.goto('/login/security', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(SECURITY_VIEW)).toBeVisible();
});

When('I remove the first factor', async ({ page }) => {
  await page.locator(FACTOR_REMOVE).first().click();
});

When('I regenerate the recovery codes', async ({ page }) => {
  await page.locator(REGENERATE).click();
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the factor list shows {int} factors', async ({ page }, count: number) => {
  await expect(page.locator(FACTOR)).toHaveCount(count);
});

Then('the first factor has an accessible remove control', async ({ page }) => {
  const remove = page.locator(FACTOR_REMOVE).first();
  await expect(remove).toBeVisible();
  // The per-factor accessible name is `Remove <type label> added <date>`.
  await expect(remove).toHaveAttribute('aria-label', /^Remove .+ added /);
});

Then('the "add a method" link points to the enrollment wizard', async ({ page }) => {
  expect(await resolvedPath(page, SECURITY_ADD)).toBe('/login/mfa/enroll');
});

When('I follow the "add a method" link', async ({ page }) => {
  await page.locator(SECURITY_ADD).click();
});

Then('I land on the enrollment wizard at {string}', async ({ page }, path: string) => {
  await expect(page.locator(ENROLL_VIEW)).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname).toBe(path);
});

Then('the sign-in invitation is shown', async ({ page }) => {
  const notice = page.locator(SIGNED_OUT);
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/sign in to manage your security methods/i);
});

Then('no raw HTTP status is shown', async ({ page }) => {
  await expect(page.locator(SECURITY_ERROR)).toHaveCount(0);
  await expect(page.locator(SECURITY_VIEW)).not.toContainText(/HTTP \d{3}/);
});

Then('none of the security controls are offered', async ({ page }) => {
  await expect(page.locator(SECURITY_ADD)).toHaveCount(0);
  await expect(page.locator(REGENERATE)).toHaveCount(0);
  await expect(page.locator(SECURITY_EMPTY)).toHaveCount(0);
  await expect(page.locator(FACTOR_LIST)).toHaveCount(0);
});

Then('following the sign-in link opens the sign-in form', async ({ page }) => {
  // The sign-in form is this remote's own mount root: /login/ when the page is
  // served standalone with base href /login/, /login under `ng serve` (base /).
  expect((await resolvedPath(page, SIGNIN_LINK)).replace(/\/$/, '')).toBe('/login');
  await page.locator(SIGNIN_LINK).click();
  await expect(page.locator(LOGIN_USERNAME)).toBeVisible({ timeout: 15_000 });
  expect(new URL(page.url()).pathname.replace(/\/$/, '')).toBe('/login');
});

Then('the no-factors notice is shown', async ({ page }) => {
  await expect(page.locator(SECURITY_EMPTY)).toBeVisible();
});

Then('the factor list is not shown', async ({ page }) => {
  await expect(page.locator(FACTOR_LIST)).toHaveCount(0);
});

Then('the security not-enabled notice is shown', async ({ page }) => {
  const dark = page.locator(SECURITY_DARK);
  await expect(dark).toBeVisible();
  await expect(dark).toContainText(/not enabled/i);
});

Then('I am routed to the step-up challenge returning to the security page', async ({ page }) => {
  await expect(page).toHaveURL(/\/login\/mfa\/challenge\?returnTo=/, { timeout: 15_000 });
  const returnTo = new URL(page.url()).searchParams.get('returnTo');
  expect(returnTo).toBe('/login/security');
  await expect(page.locator(CHALLENGE_VIEW)).toBeVisible();
});

Then('a fresh display-once recovery set {string} is shown', async ({ page }, codes: string) => {
  const region = page.locator(NEW_RECOVERY);
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('role', 'region');
  const items = page.locator(`${NEW_RECOVERY_CODES} li`);
  const expected = csv(codes);
  await expect(items).toHaveCount(expected.length);
  for (let i = 0; i < expected.length; i++) {
    await expect(items.nth(i)).toHaveText(expected[i]);
  }
});
