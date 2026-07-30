// Step definitions backing features/auth/locale.feature — runtime i18n
// (src/app/i18n/locale.ts + locale.guard.ts). OFFLINE, NOT @cluster: mocks ONLY
// the catalog fetch (**/i18n/en-XA.json) via page.route and runs the REAL
// localeGuard -> installLocale -> loadTranslations pipeline. en-XA is the
// checked-in shipped pseudo-locale (shipped-locales.ts), so ?lang=en-XA resolves
// and requests exactly this catalog before the first login route renders.
//
// "the native username and password fields are shown" is reused from
// auth-steps.ts (bound globally across features).

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { ensureLoginFormReady } from '../../tests/helpers/roles';

const HEADING = '#hug-login-heading';
const LANG_KEY = 'snap.login.lang';

// ─── Givens — catalog boundary mock ─────────────────────────────────────────

Given('the {string} catalog translates the sign-in heading to {string}', async ({ page }, locale: string, heading: string) => {
  // The SimpleJsonTranslationSerializer catalog shape installLocale() consumes:
  // { locale, translations: { <messageId>: <translation> } }. The heading is
  // @@login.heading, so keying that id re-translates it; every other message
  // renders its compiled English source (a per-message MissingTranslation warn).
  await page.route(`**/i18n/${locale}.json`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ locale, translations: { 'login.heading': heading } }),
    });
  });
});

Given('the {string} catalog is unavailable', async ({ page }, locale: string) => {
  // A REAL 404 over the mocked boundary — exercises installLocale's catch path
  // (warn + fall back to English) for real, not merely asserted never to throw.
  await page.route(`**/i18n/${locale}.json`, async (route) => {
    await route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I open the login view in locale {string}', async ({ page }, locale: string) => {
  await page.goto(`/login?lang=${encodeURIComponent(locale)}`, { waitUntil: 'domcontentloaded' });
  await ensureLoginFormReady(page);
});

When('I reopen the login view without a lang override', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await ensureLoginFormReady(page);
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the sign-in heading reads {string}', async ({ page }, text: string) => {
  await expect(page.locator(HEADING)).toHaveText(text);
});

Then('the stored login locale is {string}', async ({ page }, locale: string) => {
  const stored = await page.evaluate((key) => window.localStorage.getItem(key), LANG_KEY);
  expect(stored).toBe(locale);
});
