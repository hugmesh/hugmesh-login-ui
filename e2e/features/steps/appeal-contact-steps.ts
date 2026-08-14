// Step definitions backing features/auth/appeal-contact.feature — the
// appeal-contact page (offline, mocked network boundary, NOT @cluster).
//
// Mocks ONLY the admin-bff resolver `GET /bff/public/appeal-contact` via
// page.route (mirrors mfa-enroll-steps.ts' `/bff/mfa/enroll/*` mock idiom);
// the real AppealComponent -> AppealContactService -> generated client ->
// HttpClient pipeline runs against that mocked response.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';

/** The exact mailto subject the component pre-fills (appeal.component.ts
 *  APPEAL_SUBJECT) — kept in lockstep here so a src rename fails this test
 *  loudly rather than the assertion silently drifting. */
const APPEAL_SUBJECT = 'Account appeal — hugmesh.net';

Given('the appeal-contact resolver answers with the email {string}', async ({ page }, email: string) => {
  await page.route('**/bff/public/appeal-contact', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email }),
    });
  });
});

Given('the appeal-contact resolver is unreachable', async ({ page }) => {
  // A REAL failed fetch (not just "assert it never throws") — the resolver
  // answers 500, exercising AppealContactService's catch-degrade-to-null path
  // for real over the network boundary.
  await page.route('**/bff/public/appeal-contact', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'boom' });
  });
});

When('I open the appeal page directly', async ({ page }) => {
  await page.goto('/login/appeal', { waitUntil: 'domcontentloaded' });
});

When('I open the appeal page with reason {string}', async ({ page }, reason: string) => {
  await page.goto(`/login/appeal?reason=${encodeURIComponent(reason)}`, { waitUntil: 'domcontentloaded' });
});

// NOTE: "the appeal page is shown" is already defined in auth-steps.ts
// (asserts the URL settles on /login/appeal AND the appeal-view renders) —
// reused verbatim here rather than redefined.

Then(
  'the appeal mailto link points to {string} with the appeal subject',
  async ({ page }, email: string) => {
    const link = page.locator('[data-testid="appeal-mailto"]');
    await expect(link).toBeVisible();
    const expectedHref = `mailto:${email}?subject=${encodeURIComponent(APPEAL_SUBJECT)}`;
    await expect(link).toHaveAttribute('href', expectedHref);
    await expect(link).toHaveText(email);
  },
);

Then(
  'the appeal mailto link\'s accessible name mentions {string}',
  async ({ page }, email: string) => {
    const link = page.locator('[data-testid="appeal-mailto"]');
    await expect(link).toHaveAttribute('aria-label', `Email ${email} to appeal your account block`);
  },
);

Then('no blocked-reason is announced', async ({ page }) => {
  await expect(page.locator('[data-testid="appeal-reason"]')).toHaveCount(0);
});

Then(
  'the blocked reason {string} is announced in an assertive live region',
  async ({ page }, reason: string) => {
    const banner = page.locator('[data-testid="appeal-reason"]');
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute('role', 'alert');
    await expect(banner).toHaveAttribute('aria-live', 'assertive');
    await expect(banner).toHaveText(reason);
  },
);

Then('the appeal page shows the contact-unavailable notice', async ({ page }) => {
  const notice = page.locator('[data-testid="appeal-contact-unavailable"]');
  await expect(notice).toBeVisible();
  await expect(notice).toHaveAttribute('role', 'alert');
});

Then('no appeal mailto link is rendered', async ({ page }) => {
  await expect(page.locator('[data-testid="appeal-mailto"]')).toHaveCount(0);
});
