// Step definitions backing features/auth/protected-route.feature — the
// registeredGuard redirect exercised through the FEDERATED HOST SHELL
// (@cluster; the standalone dev shell has no protected surface of its own).
//
// Cross-persona isolation follows the repo's registry pattern: the seeded
// persona gets its OWN browser context (newE2eContext + ctxRegistry), closed by
// the After hook in features/support/fixtures.ts, so the seeded session can
// never leak into the signed-out visitor's scenario.

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import {
  SELECTORS,
  SESSION_KEY,
  ensureLoginFormReady,
  newE2eContext,
} from '../../tests/helpers/roles';
import { ctxRegistry, pageRegistry } from './_registry';

/** The protected Matrix surface's root view (matrix remote,
 *  matrix-chat.component.html). Centralised here because it is the ONLY
 *  cross-remote selector this harness touches. */
const MATRIX_VIEW = '[data-testid="matrix-view"]';

// ─── Givens ────────────────────────────────────────────────────────

Given(
  '{string} has a seeded fully-registered session in their own context',
  async ({ browser, fixture }, handle: string) => {
    const f = fixture(handle);
    const ctx = await newE2eContext(browser);
    ctxRegistry.set(handle, ctx);
    const page = await ctx.newPage();
    // Seed the LEGACY localStorage-mode session (the mode the host ships with;
    // no __HUG_* flags): the host's SessionService reads `hug.session` on
    // construction, so registrationComplete=true satisfies registeredGuard
    // without a live Casdoor round-trip. Non-secret metadata only — no token
    // field exists in the persisted shape.
    const session = JSON.stringify({
      id: `${f.provider}:${f.handle}`,
      label: f.handle,
      provider: f.provider,
      roles: f.roles ?? ['user'],
      registrationComplete: true,
    });
    await page.addInitScript(
      ({ key, value }: { key: string; value: string }) => {
        window.localStorage.setItem(key, value);
      },
      { key: SESSION_KEY, value: session },
    );
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
    if (!page) throw new Error(`No page registered for "${handle}" — seed the session first`);
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
