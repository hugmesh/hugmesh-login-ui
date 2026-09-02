// Step definitions backing features/auth/login-local-roles.feature — the
// passwordless local-role picker (role-picker.component.ts,
// local-agent.service.ts, bff.service.ts loginLocal).
//
// OFFLINE, NOT @cluster: mocks ONLY the network boundary — the loopback Studio
// agent (http://127.0.0.1:27621/v1/roles + /v1/handoff) and POST /bff/login/local
// — via page.route, and runs the REAL component pipeline against it. The agent
// calls are cross-origin with a custom header (X-HugMesh-Local) that forces a
// CORS preflight; the fulfilled responses carry permissive CORS headers so the
// real fetch resolves. "the login view is shown" / "the native username and
// password fields are shown" / "the complete-registration gate is shown" /
// "the session is held in memory for the <provider> provider" are reused from
// auth-steps.ts (bound globally across features).

import { expect } from '@playwright/test';
import { Given, When, Then } from '../support/fixtures';
import { SELECTORS } from '../../tests/helpers/roles';

/** Permissive CORS headers so the cross-origin agent fetch (credentials: omit,
 *  custom X-HugMesh-Local header) resolves against the mocked response. */
const AGENT_CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'X-HugMesh-Local',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
};

const PASSWORD_FORM = SELECTORS.usernameInput;
const ROLE_PICKER = '[data-testid="role-picker"]';
const roleCard = (id: string) => `[data-testid="role-card-${id}"]`;

// ─── Givens — loopback agent + /bff/login/local boundary mocks ──────────────

Given('the local agent advertises roles {string} and {string}', async ({ page }, a: string, b: string) => {
  const roles = [a, b].map((id) => ({ id, label: id, brand: '' }));
  await page.route('**/v1/roles', async (route) => {
    // The custom X-HugMesh-Local header forces a CORS preflight — answer the
    // OPTIONS with the permissive CORS headers so the real GET can follow.
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: AGENT_CORS, body: '' });
    }
    await route.fulfill({
      status: 200,
      headers: AGENT_CORS,
      contentType: 'application/json',
      body: JSON.stringify({ roles }),
    });
  });
});

Given('the local agent is not running', async ({ page }) => {
  // A genuine connection failure (agent absent) — LocalAgentService.roles catches
  // the thrown fetch and degrades to [], leaving the password form in place.
  await page.route('**/v1/roles', async (route) => route.abort('failed'));
});

Given('the local handoff for {string} succeeds', async ({ page }, roleId: string) => {
  await page.route('**/v1/handoff', async (route) => {
    // Preflight (the custom header forces OPTIONS) then the real POST.
    if (route.request().method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: AGENT_CORS, body: '' });
    }
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      headers: AGENT_CORS,
      contentType: 'application/json',
      body: JSON.stringify({
        roleId,
        username: `${roleId}@acme.local`,
        secret: 'local-secret',
        expiresAt: '2026-07-08T12:00:30Z',
      }),
    });
  });
});

Given('the passwordless sign-in for {string} succeeds but registration is incomplete', async ({ page }, _roleId: string) => {
  // Stateful boundary: /bff/session is 401 (anonymous) until the handoff
  // "mints the cookie", then 200 with the same non-secret projection the
  // admin-bff returns. The app hydrates from it right after the sign-in (and on
  // entry); left unmocked it would 404 and the just-established session would
  // be dropped as "not logged in" -- the real BFF answers 200 here.
  let cookieMinted = false;
  await page.route('**/bff/session', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (!cookieMinted) {
      return route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'unauthenticated' }) });
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ roles: ['user'], registrationComplete: false, mfaSatisfied: false }),
    });
  });
  await page.route('**/bff/login/local', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    cookieMinted = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ registrationComplete: false, status: 'active', mfaRequired: false }),
    });
  });
});

Given('the passwordless sign-in for {string} needs a verification code', async ({ page }, _roleId: string) => {
  await page.route('**/bff/login/local', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ mfaRequired: true, mfaType: ['totp'] }),
    });
  });
});

// ─── Whens ──────────────────────────────────────────────────────────────────

When('I pick the {string} role', async ({ page }, roleId: string) => {
  const card = page.locator(roleCard(roleId));
  await expect(card).toBeVisible();
  await card.click();
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the role picker replaces the password form', async ({ page }) => {
  await expect(page.locator(ROLE_PICKER)).toBeVisible();
  // The username/password form is REPLACED by the picker, not merely hidden beside it.
  await expect(page.locator(PASSWORD_FORM)).toHaveCount(0);
});

Then('a role card is shown for {string}', async ({ page }, roleId: string) => {
  await expect(page.locator(roleCard(roleId))).toBeVisible();
});

Then('the role picker is not shown', async ({ page }) => {
  await expect(page.locator(ROLE_PICKER)).toHaveCount(0);
});

Then('the password form is revealed with the local-role verification-code message', async ({ page }) => {
  // The single-use handoff cannot carry a passcode, so the picker falls back to
  // the password form (which supports the MFA challenge) with an explicit reason.
  await expect(page.locator(PASSWORD_FORM)).toBeVisible();
  const error = page.locator(SELECTORS.error);
  await expect(error).toBeVisible();
  await expect(error).toContainText('This role needs a verification code. Sign in with your password to continue.');
});
