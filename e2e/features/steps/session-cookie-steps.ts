// Step definitions backing features/auth/session-cookie.feature — the
// httpOnly-cookie session custody (login-ui #3): a sign-in holds the session in
// MEMORY only (nothing in web storage), hydrates it from GET /bff/session, and
// tells sibling TABS over the 'hug-session-change' BroadcastChannel so they
// re-hydrate — exactly once, with no re-hydrate storm between tabs.
//
// OFFLINE, NOT @cluster: mocks ONLY the network boundary (POST /bff/login and
// GET /bff/session) via context.route — CONTEXT-wide, because the cross-tab
// scenario opens a second page in the same context and both tabs must see ONE
// stateful server: /bff/session answers 401 until the mocked sign-in "mints the
// cookie", then 200 with the persona's roles. That statefulness is the point —
// a mock that always 200s cannot tell a real cross-tab hydrate from a page that
// was never anonymous, and one that never flips cannot prove the sign-in
// reached the other tab.
//
// "a fresh browser context" / "the login view is shown" / "<handle> signs in
// with their username and password" / "the complete-registration gate is shown"
// / "the session is held in memory for the <provider> provider" are reused from
// auth-steps.ts (playwright-bdd binds steps globally across features).

import { expect, Page } from '@playwright/test';
import { Given, Then } from '../support/fixtures';
import {
  ensureLoginFormReady,
  readPersistedSession,
  readSessionProbe,
  usernameFor,
  waitForSessionProbeRoles,
} from '../../tests/helpers/roles';
import { pageRegistry } from './_registry';

/** Registry key for the second tab (a page, not a fixture handle). */
const SECOND_TAB = 'session-cookie:second-tab';

/** The ONE stateful mock server per scenario. Module scope because
 *  playwright-bdd steps cannot share locals; reset by the Given that installs
 *  the routes, so a scenario never inherits the previous one's cookie state. */
const server = { cookieMinted: false, roles: [] as string[], sessionReads: 0 };

function secondTab(): Page {
  const tab = pageRegistry.get(SECOND_TAB);
  if (!tab) throw new Error('No second tab open — use "a second tab is open on the login view" first');
  return tab;
}

// ─── Givens — the stateful cookie server at the boundary ────────────────────

Given(
  'the BFF mints a session cookie for {string} with an incomplete registration',
  async ({ context, fixture }, handle: string) => {
    const f = fixture(handle);
    server.cookieMinted = false;
    server.roles = f.roles ?? ['user'];
    server.sessionReads = 0;

    // POST /bff/login: the cookie-mint call. A correct username "sets the cookie"
    // (flips the server state); anything else is a plain 401 like the real BFF.
    await context.route('**/bff/login', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      const body = (route.request().postDataJSON() ?? {}) as { username?: string };
      if (body.username !== usernameFor(f)) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'invalid_credentials', message: 'bad credentials' }),
        });
      }
      server.cookieMinted = true;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ registrationComplete: false, status: 'active', mfaRequired: false }),
      });
    });

    // GET /bff/session: the cookie-authenticated read every hydrate performs —
    // 401 while anonymous, then the SAME non-secret projection the admin-bff
    // returns ({roles, registrationComplete, mfaSatisfied}; no token, no id).
    await context.route('**/bff/session', async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      server.sessionReads += 1;
      if (!server.cookieMinted) {
        return route.fulfill({
          status: 401,
          contentType: 'application/json',
          body: JSON.stringify({ error: 'unauthenticated' }),
        });
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ roles: server.roles, registrationComplete: false, mfaSatisfied: false }),
      });
    });
  },
);

Given('a second tab is open on the login view', async ({ context }) => {
  const tab = await context.newPage();
  await tab.goto('/login', { waitUntil: 'domcontentloaded' });
  await ensureLoginFormReady(tab);
  // Provably anonymous to start with: its bootstrap read ran and got the 401.
  await expect.poll(() => server.sessionReads, { message: 'the second tab performed its bootstrap /bff/session read' }).toBeGreaterThan(0);
  expect(await readSessionProbe(tab)).toBeNull();
  pageRegistry.set(SECOND_TAB, tab);
});

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('the in-memory session carries the roles the BFF reported', async ({ page }) => {
  // hydrate() replaces login()'s roles:['user'] guess with the server's array,
  // VERBATIM (no drop, no up-case, order preserved).
  const probe = await waitForSessionProbeRoles(page);
  expect(probe.roles).toEqual(server.roles);
  expect(probe.registrationComplete).toBe(false);
});

Then('the second tab hydrates the same session over the broadcast channel', async ({}) => {
  // Nothing was written to web storage, so the ONLY way this tab can learn of
  // the sign-in is the BroadcastChannel post followed by its own cookie read.
  const probe = await waitForSessionProbeRoles(secondTab());
  expect(probe.roles).toEqual(server.roles);
  expect(probe.registrationComplete).toBe(false);
});

Then('the two tabs settle without a re-hydrate storm', async ({ page }) => {
  const tab = secondTab();
  const before = server.sessionReads;
  await page.waitForTimeout(1_500);
  // A hydrate that posted back would make the two tabs re-read /bff/session in a
  // loop — dozens of reads over this window. One straggling in-flight read is
  // tolerated; a loop is not.
  expect(server.sessionReads - before).toBeLessThanOrEqual(1);
  // ...and both tabs still hold the session afterwards.
  expect((await readSessionProbe(page))?.roles).toEqual(server.roles);
  expect((await readSessionProbe(tab))?.roles).toEqual(server.roles);
});

Then('nothing is persisted to web storage', async ({ page }) => {
  expect(await readPersistedSession(page)).toBeNull();
  const tab = pageRegistry.get(SECOND_TAB);
  if (tab) expect(await readPersistedSession(tab)).toBeNull();
});
