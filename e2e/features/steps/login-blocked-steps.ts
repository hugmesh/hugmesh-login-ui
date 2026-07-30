// Step definitions backing features/auth/login-blocked.feature — the
// banned/suspended sign-in -> /login/appeal auto-route (src/app/login.component.ts
// routeToAppeal + src/app/bff.service.ts classifyRejection).
//
// OFFLINE idiom (same as appeal-contact/appeal-submit): mock ONLY the network
// boundary (POST /bff/login) via page.route and let the REAL component pipeline
// (signIn -> BffService.login -> classifyRejection -> routeToAppeal ->
// AppealComponent's ?reason= alert) run against it. The appeal page, its exact
// reason text, the mailto and the "no session" assertions are already defined in
// auth-steps.ts / appeal-contact-steps.ts and reused verbatim here (playwright-bdd
// binds steps globally across features).

import { expect } from '@playwright/test';
import { Given } from '../support/fixtures';

// ─── Offline boundary mock for POST /bff/login (blocked account) ────────────

Given(
  'the BFF refuses sign-in as {string} with reason {string}',
  async ({ page }, token: string, reason: string) => {
    // A REAL non-OK /bff/login answer carrying the blocked-status token + reason,
    // exercising BffService.classifyRejection's blocked branch for real over the
    // mocked boundary (423 Locked mirrors the documented banned/suspended reply).
    // Glob '**/bff/login' matches the sign-in POST but NOT '/bff/login/local'
    // (that path has a further segment), so the passwordless endpoint is untouched.
    await page.route('**/bff/login', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 423,
        contentType: 'application/json',
        body: JSON.stringify({ error: token, reason }),
      });
    });
  },
);

// ─── @cluster precondition marker: the live host owns the block ─────────────

Given(
  'the integration host has blocked {string} for {string}',
  async ({ fixture }, handle: string, _reason: string) => {
    // @cluster only (runtime-skipped offline). The account block is authored on
    // the live integration host by a second real user/admin (this UI has no
    // account-ban surface of its own and the account-ban endpoint is server-side
    // in admin-bff, not in this remote's spec). We validate the persona is a known
    // fixture so a typo fails loudly; the block itself is the live host's fixture
    // responsibility, exactly as @cluster login-native relies on the live BFF
    // knowing its sign-in fixtures.
    fixture(handle);
    expect(handle).toBeTruthy();
  },
);
