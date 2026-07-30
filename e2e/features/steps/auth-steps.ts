// Step definitions backing features/auth/*.feature. Each step wraps the plain
// helpers in tests/helpers/roles.ts — the BDD surface stays a thin presentation
// layer over the same selectors/flows so behaviour stays in one place.
//
// THIS remote's OWN username/password form is the only login surface — every
// sign-in step drives that native form (login-username / login-password /
// login-submit), never a Casdoor hosted page or a provider fieldset.
//
// The live sign-in scenarios are @cluster (need a real BFF /bff/login +
// federation host) and runtime-skipped unless E2E_LIVE=1, so these steps don't
// execute in the offline gate; they exist so `bddgen` + `playwright test --list`
// bind every Gherkin line to a real definition.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import {
  SELECTORS,
  completeMfaChallenge,
  ensureLoginFormReady,
  readSession,
  signIn,
} from '../../tests/helpers/roles';
import { pageRegistry } from './_registry';

// ─── Givens ────────────────────────────────────────────────────────

/** Ensure a clean browser slate before each scenario. The Playwright
 *  fixture already gives a per-scenario context, but clearing cookies
 *  defensively prevents a leaked session from a prior CI run masking a
 *  regression (e.g. a sign-in test passing because a stale cookie bypasses
 *  the login form). */
Given('a fresh browser context', async ({ context }) => {
  await context.clearCookies();
});

/** Navigate to /login and wait for the login form to be interactive.
 *  `ensureLoginFormReady` polls for the form root to settle so subsequent
 *  steps can immediately interact with inputs without additional waits. */
Given('the login view is shown', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await ensureLoginFormReady(page);
  await expect(page.locator(SELECTORS.loginView)).toBeVisible();
});

// ─── Whens — native username/password sign-in ───────────────────────

When('{string} signs in with their username and password', async ({ page, fixture }, handle: string) => {
  await signIn(page, fixture(handle));
  pageRegistry.set(handle, page);
});

When('{string} completes the MFA challenge with code {string}', async ({ page }, _handle: string, code: string) => {
  await completeMfaChallenge(page, code);
});

// ─── Whens — complete-registration display-name / screen-reader-name ────────

When('I enter the display name {string}', async ({ page }, name: string) => {
  await page.locator(SELECTORS.displayNameInput).fill(name);
});

When('I enter the screen-reader name {string}', async ({ page }, name: string) => {
  await page.locator(SELECTORS.screenReaderNameInput).fill(name);
});

// ─── Thens — the native login surface ───────────────────────────────

Then('the native username and password fields are shown', async ({ page }) => {
  await expect(page.locator(SELECTORS.usernameInput)).toBeVisible();
  await expect(page.locator(SELECTORS.passwordInput)).toBeVisible();
  await expect(page.locator(SELECTORS.submitButton)).toBeVisible();
});

Then('the browser is not redirected to Casdoor', async ({ page }) => {
  // The only login surface is our own form on this origin — no Casdoor
  // authorize/hosted-login URL is ever navigated to.
  expect(page.url()).not.toMatch(/casdoor|\/login\/oauth\/authorize/i);
  await expect(page.locator(SELECTORS.usernameInput)).toBeVisible();
});

Then('the MFA challenge is shown', async ({ page }) => {
  await expect(page.locator(SELECTORS.mfaCodeInput)).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(SELECTORS.mfaSubmitButton)).toBeVisible();
});

// ─── Thens — ALLOW outcomes ─────────────────────────────────────────

/** Assert that a non-null session was written to localStorage and carries
 *  the expected provider string (e.g. `'password'` or `'oidc'`). Reads
 *  the raw `hug.session` key via {@link readSession}. */
Then('the session is stored for the {word} provider', async ({ page }, provider: string) => {
  const session = (await readSession(page)) as { provider?: string } | null;
  expect(session).not.toBeNull();
  expect(session?.provider).toBe(provider.toLowerCase());
});

/** Assert that the login view is gone after a successful sign-in,
 *  allowing up to 15 s for the BFF round-trip + navigation to complete. */
Then('the login view is no longer shown', async ({ page }) => {
  await expect(page.locator(SELECTORS.loginView)).toHaveCount(0, { timeout: 15_000 });
});

Then('the complete-registration gate is shown', async ({ page }) => {
  await expect(page.locator(SELECTORS.completeView)).toBeVisible({ timeout: 15_000 });
});

/** Assert that the Complete-registration submit button is disabled when
 *  the display name field is still blank. The button is
 *  `[disabled]="completeBlocked()"` in the template — this verifies the
 *  signal-derived guard fires correctly before any name is entered. */
Then('the complete-registration submit is disabled until a display name is entered', async ({ page }) => {
  await expect(page.locator(SELECTORS.completeButton)).toBeDisabled();
});

Then('the complete-registration submit is enabled', async ({ page }) => {
  await expect(page.locator(SELECTORS.completeButton)).toBeEnabled();
});

Then('the complete-registration submit is disabled', async ({ page }) => {
  await expect(page.locator(SELECTORS.completeButton)).toBeDisabled();
});

Then('the screen-reader name prompt is shown', async ({ page }) => {
  // needsScreenReaderName() reveals the ASCII screen-reader-name field + its
  // helptext once the display name is non-blank but NOT pure printable-ASCII
  // (mirrors the server ScreenReaderNames rule).
  await expect(page.locator(SELECTORS.screenReaderNameInput)).toBeVisible();
  await expect(page.locator(SELECTORS.screenReaderHelp)).toContainText(
    /screen reader cannot announce cleanly/i,
  );
});

// ─── Thens — DENY outcomes ──────────────────────────────────────────

/** Assert that the error live region is visible and announces a
 *  "sign-in failed" message (the text the LoginComponent sets on a
 *  non-banned BFF rejection). */
Then('a sign-in error is announced', async ({ page }) => {
  const err = page.locator(SELECTORS.error);
  await expect(err).toBeVisible({ timeout: 15_000 });
  await expect(err).toContainText(/sign-in failed/i);
});

/** Assert that no session was persisted — localStorage `hug.session`
 *  should be absent or null after a failed sign-in attempt. */
Then('no session is stored', async ({ page }) => {
  expect(await readSession(page)).toBeNull();
});

/** Assert that the login view remains visible (a failed sign-in must NOT
 *  navigate away). */
Then('the login view is still shown', async ({ page }) => {
  await expect(page.locator(SELECTORS.loginView)).toBeVisible();
});

/** Assert that the appeal page was navigated to (URL contains
 *  `/login/appeal`) and its root element is visible. The LoginComponent
 *  routes here when the BFF returns `account_banned` or
 *  `account_suspended`. */
Then('the appeal page is shown', async ({ page }) => {
  await expect(page).toHaveURL(/\/login\/appeal/, { timeout: 15_000 });
  await expect(page.locator(SELECTORS.appealView)).toBeVisible();
});

/** Assert that the optional blocked-reason alert is visible on the appeal
 *  page (present when the BFF sign-in response carried a non-blank reason
 *  and it was URL-encoded into `?reason=`). */
Then('the appeal page announces a blocked reason', async ({ page }) => {
  await expect(page.locator(SELECTORS.appealReason)).toBeVisible();
});

// ─── Thens — error-state a11y ───────────────────────────────────────

/** Assert that the error element carries `role="alert"` +
 *  `aria-live="assertive"`, matching WCAG 4.1.3 Status Messages: an
 *  error that directly affects the user must be announced immediately
 *  by a screen reader without needing to move focus. */
Then('the error region is an assertive live region', async ({ page }) => {
  const err = page.locator(SELECTORS.error);
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toHaveAttribute('aria-live', 'assertive');
});

Then('the username field is marked invalid', async ({ page }) => {
  await expect(page.locator(SELECTORS.usernameInput)).toHaveAttribute('aria-invalid', 'true');
});

Then('the username field is described by the error region', async ({ page }) => {
  const describedBy = await page.locator(SELECTORS.usernameInput).getAttribute('aria-describedby');
  expect(describedBy ?? '').toContain('hug-login-error');
});

/** Assert that the appeal page's blocked-reason element carries
 *  `role="alert"` + `aria-live="assertive"` — the reason is a consequential
 *  message that must be announced immediately when the page loads. */
Then('the appeal blocked-reason is an assertive live region', async ({ page }) => {
  const reason = page.locator(SELECTORS.appealReason);
  await expect(reason).toHaveAttribute('role', 'alert');
  await expect(reason).toHaveAttribute('aria-live', 'assertive');
});
