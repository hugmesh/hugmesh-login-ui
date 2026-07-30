// Step definitions backing features/auth/mfa-challenge.feature — the MFA
// step-up challenge (src/app/mfa-challenge.component.ts).
//
// The initial surface (method radios, code field, submit gating) renders with
// NO network call, so those steps drive pure client-side state and need no mock.
// The two outcome scenarios mock ONLY `POST /bff/mfa/challenge` via page.route
// (the role-session idiom) so the REAL component -> MfaService -> fetch pipeline
// runs against the mocked verdict. NOT @cluster — fully offline.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

const CHALLENGE_VIEW = '[data-testid="mfa-challenge-view"]';
const CHALLENGE_INTRO = '[data-testid="mfa-challenge-intro"]';
const METHOD_TOTP = '[data-testid="mfa-method-totp"]';
const METHOD_WEBAUTHN = '[data-testid="mfa-method-webauthn"]';
const METHOD_RECOVERY = '[data-testid="mfa-method-recovery"]';
const WEBAUTHN_GO = '[data-testid="mfa-webauthn-go"]';
const CODE = '[data-testid="mfa-challenge-code"]';
const SUBMIT = '[data-testid="mfa-challenge-submit"]';
const CHALLENGE_ERROR = '[data-testid="mfa-challenge-error"]';
const ENROLL_VIEW = '[data-testid="mfa-enroll-view"]';
const CODE_LABEL = 'label[for="hug-mfa-challenge-code"]';

// ─── Givens — boundary mocks ────────────────────────────────────────────────

Given('the MFA challenge is satisfied by the BFF', async ({ page }) => {
  await page.route('**/bff/mfa/challenge', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mfaSatisfied: true }),
    });
  });
});

Given('the MFA challenge is rejected by the BFF', async ({ page }) => {
  await page.route('**/bff/mfa/challenge', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid' }),
    });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I open the MFA step-up challenge', async ({ page }) => {
  await page.goto('/login/mfa/challenge', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(CHALLENGE_VIEW)).toBeVisible();
});

When('I open the MFA step-up challenge returning to {string}', async ({ page }, returnTo: string) => {
  await page.goto(`/login/mfa/challenge?returnTo=${encodeURIComponent(returnTo)}`, {
    waitUntil: 'domcontentloaded',
  });
  await expect(page.locator(CHALLENGE_VIEW)).toBeVisible();
});

When('I enter the challenge code {string}', async ({ page }, code: string) => {
  await page.locator(CODE).fill(code);
});

When('I clear the challenge code', async ({ page }) => {
  await page.locator(CODE).fill('');
});

When('I choose the recovery-code method', async ({ page }) => {
  await page.locator(METHOD_RECOVERY).click();
});

When('I choose the passkey method', async ({ page }) => {
  await page.locator(METHOD_WEBAUTHN).click();
});

When('I submit the challenge', async ({ page }) => {
  await page.locator(SUBMIT).click();
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the step-up challenge is shown', async ({ page }) => {
  await expect(page.locator(CHALLENGE_VIEW)).toBeVisible();
  await expect(page.getByRole('heading', { name: "Confirm it's you" })).toBeVisible();
  await expect(page.locator(CHALLENGE_INTRO)).toContainText(/fresh security check/i);
});

Then('the authenticator, passkey and recovery-code methods are offered', async ({ page }) => {
  await expect(page.locator(METHOD_TOTP)).toBeVisible();
  await expect(page.locator(METHOD_WEBAUTHN)).toBeVisible();
  await expect(page.locator(METHOD_RECOVERY)).toBeVisible();
  // TOTP is the default method, so its code form (not the passkey action) shows.
  await expect(page.locator(METHOD_TOTP)).toBeChecked();
  await expect(page.locator(CODE)).toBeVisible();
});

Then('the verify button is disabled until a code is entered', async ({ page }) => {
  await expect(page.locator(CODE)).toHaveValue('');
  await expect(page.locator(SUBMIT)).toBeDisabled();
});

Then('the verify button is enabled', async ({ page }) => {
  await expect(page.locator(SUBMIT)).toBeEnabled();
});

Then('the verify button is disabled', async ({ page }) => {
  await expect(page.locator(SUBMIT)).toBeDisabled();
});

Then('the challenge code field is labelled for a recovery code', async ({ page }) => {
  // Proves the method actually switched: the label is bound to
  // method()==='totp' ? '6-digit code' : 'Recovery code'.
  await expect(page.locator(CODE_LABEL)).toHaveText(/recovery code/i);
});

Then('the passkey verification action is shown', async ({ page }) => {
  await expect(page.locator(WEBAUTHN_GO)).toBeVisible();
  await expect(page.locator(WEBAUTHN_GO)).toHaveText(/verify with a passkey/i);
});

Then('the code entry form is not shown', async ({ page }) => {
  await expect(page.locator(CODE)).toHaveCount(0);
});

Then('I am returned to the MFA enrollment wizard', async ({ page }) => {
  await expect(page).toHaveURL(/\/login\/mfa\/enroll/, { timeout: 15_000 });
  await expect(page.locator(ENROLL_VIEW)).toBeVisible();
});

Then('the challenge error announces the code did not verify', async ({ page }) => {
  const err = page.locator(CHALLENGE_ERROR);
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toHaveAttribute('aria-live', 'assertive');
  await expect(err).toContainText(/did not verify/i);
});

Then('the step-up challenge is still shown', async ({ page }) => {
  await expect(page.locator(CHALLENGE_VIEW)).toBeVisible();
});
