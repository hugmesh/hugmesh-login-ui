// Step definitions backing features/auth/mfa-enroll.feature — the MFA
// enrollment wizard (src/app/mfa-enroll.component.ts).
//
// The 'choose' step renders with no network, so the opening scenario needs no
// mock. The TOTP path + ships-dark state each need a `/bff/mfa/enroll/*`
// RESPONSE, mocked ONLY at that boundary via page.route (the appeal-contact /
// role-session idiom): the REAL component -> MfaService -> fetch pipeline runs
// against the mocked reply. NOT @cluster — fully offline.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

const ENROLL_VIEW = '[data-testid="mfa-enroll-view"]';
const ENROLL_INTRO = '[data-testid="mfa-enroll-intro"]';
const CHOOSE_TOTP = '[data-testid="mfa-choose-totp"]';
const CHOOSE_WEBAUTHN = '[data-testid="mfa-choose-webauthn"]';
const SECRET = '[data-testid="mfa-secret"]';
const PASSCODE = '[data-testid="mfa-passcode"]';
const VERIFY_TOTP = '[data-testid="mfa-verify-totp"]';
const RECOVERY = '[data-testid="mfa-recovery"]';
const RECOVERY_CODES = '[data-testid="mfa-recovery-codes"]';
const ENROLL_ERROR = '[data-testid="mfa-enroll-error"]';
const DARK = '[data-testid="mfa-dark"]';

/** Split a comma-separated Gherkin list into trimmed non-empty entries. */
function csv(list: string): string[] {
  return list.split(',').map((s) => s.trim()).filter(Boolean);
}

// ─── Givens — boundary mocks (real component pipeline runs against these) ────

Given('MFA TOTP enrollment start returns the setup key {string}', async ({ page }, secret: string) => {
  // POST /bff/mfa/enroll/totp → the display-once secret + a scannable otpauthUri.
  await page.route('**/bff/mfa/enroll/totp', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        factorId: 'factor-totp-e2e',
        secret,
        otpauthUri: `otpauth://totp/hugmesh.systems:e2e?secret=${secret}&issuer=hugmesh.systems&algorithm=SHA1&digits=6&period=30`,
      }),
    });
  });
});

Given('verifying the TOTP code returns the recovery codes {string}', async ({ page }, codes: string) => {
  await page.route('**/bff/mfa/enroll/totp/verify', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ enabled: true, recoveryCodes: csv(codes) }),
    });
  });
});

Given('verifying the TOTP code is rejected as incorrect', async ({ page }) => {
  // A REAL 401 over the boundary (not "assert it never throws") drives the
  // component's status===401 branch → the "did not match" error.
  await page.route('**/bff/mfa/enroll/totp/verify', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'invalid code' }),
    });
  });
});

Given('the MFA enrollment endpoints answer dark', async ({ page }) => {
  // 503 is the exact status the admin-bff returns for every /bff/mfa/* call
  // while the feature ships dark; the wizard maps it to the terminal
  // "MFA not enabled" state (never an error).
  await page.route('**/bff/mfa/**', async (route) => {
    await route.fulfill({ status: 503, contentType: 'text/plain', body: 'dark' });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I open the MFA enrollment page', async ({ page }) => {
  await page.goto('/login/mfa/enroll', { waitUntil: 'domcontentloaded' });
  await expect(page.locator(ENROLL_VIEW)).toBeVisible();
});

When('I choose to set up an authenticator app', async ({ page }) => {
  await page.locator(CHOOSE_TOTP).click();
});

When('I enter the 6-digit authenticator code {string}', async ({ page }, code: string) => {
  await page.locator(PASSCODE).fill(code);
});

When('I submit the authenticator code', async ({ page }) => {
  await page.locator(VERIFY_TOTP).click();
});

// ─── Thens — 'choose' step (client-side, no network) ────────────────────────

Then('the MFA enrollment wizard is shown', async ({ page }) => {
  await expect(page.locator(ENROLL_VIEW)).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Set up two-factor authentication' })).toBeVisible();
});

Then('the enrollment choose step invites me to add a second step', async ({ page }) => {
  await expect(page.locator(ENROLL_INTRO)).toContainText(/add a second step/i);
});

Then('the "use an authenticator app" option is offered and enabled', async ({ page }) => {
  const btn = page.locator(CHOOSE_TOTP);
  await expect(btn).toBeVisible();
  await expect(btn).toBeEnabled();
  await expect(btn).toHaveText(/use an authenticator app/i);
});

Then('the "add a passkey" option is offered', async ({ page }) => {
  await expect(page.locator(CHOOSE_WEBAUTHN)).toHaveText(/add a passkey/i);
});

// ─── Thens — TOTP show / verify ─────────────────────────────────────────────

Then('the one-time setup key {string} is shown', async ({ page }, secret: string) => {
  // Positive proof we advanced to the totp-show step (the passcode input only
  // exists there) AND the exact display-once key is rendered.
  await expect(page.locator(PASSCODE)).toBeVisible();
  await expect(page.locator(SECRET)).toContainText(secret);
});

Then('the verify-and-enable button is disabled until a 6-digit code is entered', async ({ page }) => {
  // The code field is blank here (passcodeValid() is false), so the submit is
  // [disabled]="busy() || !passcodeValid()".
  await expect(page.locator(PASSCODE)).toHaveValue('');
  await expect(page.locator(VERIFY_TOTP)).toBeDisabled();
});

Then('the verify-and-enable button is enabled', async ({ page }) => {
  await expect(page.locator(VERIFY_TOTP)).toBeEnabled();
});

Then('the display-once recovery codes {string} are shown', async ({ page }, codes: string) => {
  const region = page.locator(RECOVERY);
  await expect(region).toBeVisible();
  await expect(region).toHaveAttribute('role', 'region');
  const items = page.locator(`${RECOVERY_CODES} li`);
  const expected = csv(codes);
  await expect(items).toHaveCount(expected.length);
  for (let i = 0; i < expected.length; i++) {
    await expect(items.nth(i)).toHaveText(expected[i]);
  }
});

// ─── Thens — error / dark ───────────────────────────────────────────────────

Then('the enrollment error announces the code did not match', async ({ page }) => {
  const err = page.locator(ENROLL_ERROR);
  await expect(err).toBeVisible();
  await expect(err).toHaveAttribute('role', 'alert');
  await expect(err).toHaveAttribute('aria-live', 'assertive');
  await expect(err).toContainText(/did not match/i);
});

Then('no recovery codes are shown', async ({ page }) => {
  await expect(page.locator(RECOVERY)).toHaveCount(0);
});

Then('the MFA-not-enabled enrollment notice is shown', async ({ page }) => {
  const dark = page.locator(DARK);
  await expect(dark).toBeVisible();
  await expect(dark).toContainText(/not enabled/i);
});

Then('no enrollment error is announced', async ({ page }) => {
  await expect(page.locator(ENROLL_ERROR)).toHaveCount(0);
});
