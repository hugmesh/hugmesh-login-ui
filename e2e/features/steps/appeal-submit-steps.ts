// Step definitions backing features/auth/appeal-submit.feature — the
// structured appeal-submit form (src/app/appeal.component.ts, POST
// /bff/me/appeal). Offline, NOT @cluster — mocks ONLY the network boundary
// (page.route), same idiom as appeal-contact-steps.ts. The "signed-in"
// precondition is seeded directly into localStorage `hug.session` via
// addInitScript (the protected-route.feature idiom) rather than a live sign-in,
// since AppealComponent's showAppealForm only reads SessionService.loggedIn()
// (session !== null) — it does not itself re-verify the cookie client-side.
//
// "the appeal page is shown" / "I open the appeal page directly" / the mailto
// assertions are already defined in auth-steps.ts / appeal-contact-steps.ts and
// reused verbatim here (playwright-bdd binds steps globally across features).

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { SESSION_KEY } from '../../tests/helpers/roles';

const FORM_SECTION = '[data-testid="appeal-form-section"]';
const FORM = '[data-testid="appeal-form"]';
const REASON_INPUT = '[data-testid="appeal-reason-input"]';
const SUBMIT_BUTTON = '[data-testid="appeal-submit"]';
const SUBMITTED = '[data-testid="appeal-submitted"]';
const SUBMIT_ERROR = '[data-testid="appeal-submit-error"]';

// ─── Givens — seed the curtailed-but-still-authenticated session ──────────

Given(
  'a signed-in session is seeded for the {string} persona',
  async ({ page, fixture }, handle: string) => {
    const f = fixture(handle);
    // Mirrors the persisted SnapSession shape (session.service.ts) — non-secret
    // metadata only, no token field (auth rides in the httpOnly bff_ cookie
    // this offline harness cannot mint; showAppealForm only checks that a
    // session object exists, per the component's own javadoc on suspended/
    // banned principals whose cookie still authenticates server-side).
    const session = JSON.stringify({
      id: `${f.provider}:${f.handle}`,
      label: f.handle,
      provider: f.provider,
      roles: f.roles ?? ['user'],
      registrationComplete: f.registered,
    });
    await page.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: SESSION_KEY, value: session },
    );
  },
);

// ─── Givens — boundary mocks for POST /bff/me/appeal ───────────────────────

Given(
  'submitting a structured appeal succeeds with status {string} and id {string}',
  async ({ page }, status: string, id: string) => {
    await page.route('**/bff/me/appeal', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status, id }),
      });
    });
  },
);

Given('submitting a structured appeal is rejected as unauthenticated', async ({ page }) => {
  // A REAL 401 over the mocked boundary — exercises BffService.submitAppeal's
  // r.status === 401 branch for real, not merely asserted never to throw.
  await page.route('**/bff/me/appeal', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({}) });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I submit the structured appeal with reason {string}', async ({ page }, reason: string) => {
  const form = page.locator(FORM);
  await expect(form).toBeVisible();
  await page.locator(REASON_INPUT).fill(reason);
  await expect(page.locator(SUBMIT_BUTTON)).toBeEnabled();
  await page.locator(SUBMIT_BUTTON).click();
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the structured appeal form is shown', async ({ page }) => {
  await expect(page.locator(FORM_SECTION)).toBeVisible();
  await expect(page.locator(FORM)).toBeVisible();
  // Honest starting state: nothing recorded, no stale error, before any submit.
  await expect(page.locator(SUBMITTED)).toHaveCount(0);
  await expect(page.locator(SUBMIT_ERROR)).toHaveCount(0);
});

Then('the structured appeal form is not shown', async ({ page }) => {
  await expect(page.locator(FORM_SECTION)).toHaveCount(0);
});

Then('the structured appeal form is no longer shown', async ({ page }) => {
  await expect(page.locator(FORM)).toHaveCount(0);
});

Then('the appeal is shown as recorded', async ({ page }) => {
  const confirmation = page.locator(SUBMITTED);
  await expect(confirmation).toBeVisible();
  await expect(confirmation).toHaveAttribute('role', 'status');
  await expect(confirmation).toHaveAttribute('aria-live', 'polite');
  await expect(confirmation).toHaveText('Your appeal has been recorded. We will review it and follow up.');
});

Then('the appeal is not shown as recorded', async ({ page }) => {
  await expect(page.locator(SUBMITTED)).toHaveCount(0);
});

Then('the appeal submit error says {string}', async ({ page }, message: string) => {
  const error = page.locator(SUBMIT_ERROR);
  await expect(error).toBeVisible();
  await expect(error).toHaveAttribute('role', 'alert');
  await expect(error).toHaveAttribute('aria-live', 'assertive');
  await expect(error).toHaveText(message);
});
