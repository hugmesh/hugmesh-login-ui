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
  const link = page.locator(SECURITY_ADD);
  await expect(link).toBeVisible();
  const href = await link.getAttribute('href');
  expect(href ?? '').toContain('/login/mfa/enroll');
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
