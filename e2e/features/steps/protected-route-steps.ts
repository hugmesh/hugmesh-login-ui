// Step definitions backing features/auth/protected-route.feature — the
// registeredGuard redirect exercised through the FEDERATED HOST SHELL
// (@cluster; the standalone dev shell has no protected surface of its own).
//
// Cross-persona isolation follows the repo's registry pattern: the signed-in
// persona gets its OWN browser context (newE2eContext + ctxRegistry), closed by
// the After hook in features/support/fixtures.ts, so that session can never
// leak into the signed-out visitor's scenario.
//
// The ALLOW persona signs in FOR REAL through the native form. Since login-ui #3
// the session is the httpOnly `bff_` cookie and nothing else — there is no
// localStorage mirror left to seed — so the only way to hold a session is to
// have the BFF mint one, and the host shell then hydrates it from GET /bff/session
// with that cookie.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import {
  SELECTORS,
  ensureLoginFormReady,
  newE2eContext,
  signIn,
} from '../../tests/helpers/roles';
import { ctxRegistry, pageRegistry } from './_registry';

/** The protected Matrix surface's root view (matrix remote,
 *  matrix-chat.component.html). Centralised here because it is the ONLY
 *  cross-remote selector this harness touches. */
const MATRIX_VIEW = '[data-testid="matrix-view"]';

// ─── Givens ────────────────────────────────────────────────────────

Given(
  '{string} signs in to a fully-registered session in their own context',
  async ({ browser, fixture }, handle: string) => {
    const f = fixture(handle);
    const ctx = await newE2eContext(browser);
    ctxRegistry.set(handle, ctx);
    const page = await ctx.newPage();
    // A real native sign-in: the BFF mints the httpOnly bff_ cookie (the ONLY
    // session custody), and a fully-registered identity leaves the login view.
    await signIn(page, f);
    await expect(page.locator(SELECTORS.loginView)).toHaveCount(0, { timeout: 15_000 });
    pageRegistry.set(handle, page);
  },
);

// ─── Whens ──────────────────────────────────────────────────────────

When('a signed-out visitor opens the protected {string} surface', async ({ page }, path: string) => {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
});

When(
  '{string} opens the protected {string} surface in their own context',
  async ({}, handle: string, path: string) => {
    const page = pageRegistry.get(handle);
    if (!page) throw new Error(`No page registered for "${handle}" — sign in first`);
    await page.goto(path, { waitUntil: 'domcontentloaded' });
  },
);

// ─── Thens ──────────────────────────────────────────────────────────

Then('the visitor is redirected to the login view', async ({ page }) => {
  // registeredGuard returns router.parseUrl('/login'): the URL must land on
  // /login AND the login view must actually render (a dead redirect target
  // would otherwise pass a URL-only assertion).
  await expect(page).toHaveURL(/\/login/, { timeout: 30_000 });
  await ensureLoginFormReady(page);
  await expect(page.locator(SELECTORS.loginView)).toBeVisible();
});

Then(
  '{string} is not redirected to login and the Matrix view is shown',
  async ({}, handle: string) => {
    const page = pageRegistry.get(handle);
    if (!page) throw new Error(`No page registered for "${handle}"`);
    // ALLOW must prove the protected surface RENDERED for the authorised
    // persona — not merely that the URL stayed put.
    await expect(page.locator(MATRIX_VIEW)).toBeVisible({ timeout: 30_000 });
    await expect(page).toHaveURL(/\/social\/matrix/);
    await expect(page.locator(SELECTORS.loginView)).toHaveCount(0);
  },
);
