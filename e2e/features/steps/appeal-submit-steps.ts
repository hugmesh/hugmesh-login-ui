// Step definitions backing features/auth/appeal-submit.feature — the
// structured appeal-submit form (src/app/appeal.component.ts, POST
// /bff/me/appeal). Offline, NOT @cluster — mocks ONLY the network boundary
// (page.route), same idiom as appeal-contact-steps.ts. The "signed-in"
// precondition is a mocked `GET /bff/session` answering 200: since login-ui #3
// the session is the httpOnly `bff_` cookie and nothing else, and the app
// hydrates its in-memory session from that endpoint on every entry
// (sessionHydrateGuard) — so "the BFF still recognises this browser's cookie"
// IS the precondition, modelled at the boundary rather than seeded into web
// storage. AppealComponent's showAppealForm reads SessionService.loggedIn()
// (session !== null) off that hydrate.
//
// "the appeal page is shown" / "I open the appeal page directly" / the mailto
// assertions are already defined in auth-steps.ts / appeal-contact-steps.ts and
// reused verbatim here (playwright-bdd binds steps globally across features).

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

const FORM_SECTION = '[data-testid="appeal-form-section"]';
const FORM = '[data-testid="appeal-form"]';
const REASON_INPUT = '[data-testid="appeal-reason-input"]';
const SUBMIT_BUTTON = '[data-testid="appeal-submit"]';
const SUBMITTED = '[data-testid="appeal-submitted"]';
const SUBMIT_ERROR = '[data-testid="appeal-submit-error"]';

// ─── Givens — the curtailed-but-still-authenticated session ────────────────

Given(
  'the browser holds a live session cookie for the {string} persona',
  async ({ page, fixture }, handle: string) => {
    const f = fixture(handle);
    // The cookie itself is httpOnly and minted server-side, so this offline
    // harness models it where the app observes it: GET /bff/session answers 200
    // with the persona's NON-SECRET metadata (the same {roles,registrationComplete}
    // the admin-bff returns — no token, no id). A PROFILE suspension/ban is not a
    // Casdoor-role flip, so such a principal's cookie still authenticates (the
    // component's own javadoc), which is exactly what this 200 asserts.
    await page.route('**/bff/session', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          roles: f.roles ?? ['user'],
          registrationComplete: f.registered,
          mfaSatisfied: false,
        }),
      });
    });
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
