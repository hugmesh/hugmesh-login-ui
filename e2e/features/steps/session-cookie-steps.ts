// Step definitions backing features/auth/session-cookie.feature — the
// httpOnly-cookie session CUSTODY (login-ui #3) and the `hug.session` fleet
// mirror that is its non-secret TRANSPORT: a sign-in holds no credential in web
// storage, hydrates the session from GET /bff/session, publishes the projection
// the not-yet-migrated remotes read, and tells sibling TABS over the
// 'hug-session-change' BroadcastChannel so they re-hydrate — exactly once, with
// no re-hydrate storm between tabs (both tabs write the mirror, so an
// unconditional republish would make them wake each other forever).
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
import { Given, When, Then } from '../support/fixtures';
import {
  FLEET_SESSION_MIRROR_KEY,
  ensureLoginFormReady,
  evaluateFleetRemoteGuard,
  readFleetMirror,
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

    // POST /bff/sessionOut: the real logout — deletes the server session and
    // expires the cookie, so every later /bff/session read is a 401.
    await context.route('**/bff/sessionOut', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      server.cookieMinted = false;
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ loggedOut: true }),
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

// ─── Whens ──────────────────────────────────────────────────────────────────

When('the second tab signs out, expiring the cookie server-side before announcing it', async ({}) => {
  // login-ui has no sign-out control of its own (the host shell owns it), so
  // the test drives the other tab at the same two boundaries
  // SessionService.clear() touches, in the same ORDER: POST /bff/sessionOut is
  // awaited (the cookie is dead server-side) and only THEN the one post on the
  // 'hug-session-change' channel. The receiving tab — the page under test — runs
  // the real service: its handler is a cookie read, which now 401s.
  const before = server.sessionReads;
  await secondTab().evaluate(async () => {
    await fetch('/bff/sessionOut', { method: 'POST', credentials: 'include' });
    const bc = new BroadcastChannel('hug-session-change');
    bc.postMessage('changed');
    bc.close();
  });
  expect(server.cookieMinted).toBe(false);
  await expect.poll(() => server.sessionReads, { message: 'the announced sign-out made this tab re-read /bff/session' }).toBeGreaterThan(before);
});

When(
  'a not-yet-migrated host shell in the second tab signs out the legacy way, over the hug.session mirror alone',
  async ({ page }) => {
    // The rest of the fleet has NOT migrated: hugmesh-host-shell's SessionService
    // owns a localStorage `hug.session` mirror, holds NO BroadcastChannel at all,
    // and its own `storage` handler only sets its signal (it re-broadcasts
    // nothing same-document). So when a shell signs out in ANOTHER tab, the only
    // signal that can cross to this remote is the `storage` event its mirror
    // write raises. This step drives exactly that shell shape in the second tab
    // — no channel post anywhere — and the tab under test runs the real
    // SessionService.
    const tab = secondTab();
    const mirrored = server.sessionReads;
    // 1. the shell mirrors the session on ITS sign-in (the `storage` event this
    //    raises here is a live-cookie hydrate: nothing changes).
    await tab.evaluate((key) => {
      localStorage.setItem(key, JSON.stringify({
        id: 'shell-user', label: 'shell-user', provider: 'password',
        roles: ['user'], registrationComplete: false,
      }));
    }, FLEET_SESSION_MIRROR_KEY);
    await expect
      .poll(() => server.sessionReads, { message: 'the mirror write reached this tab as a live-cookie hydrate' })
      .toBeGreaterThan(mirrored);
    expect(await readSessionProbe(page)).not.toBeNull();

    // 2. the shell's clear(): expire the cookie FIRST, then drop the mirror.
    const before = server.sessionReads;
    await tab.evaluate(async (key) => {
      await fetch('/bff/sessionOut', { method: 'POST', credentials: 'include' });
      localStorage.removeItem(key);
    }, FLEET_SESSION_MIRROR_KEY);
    expect(server.cookieMinted).toBe(false);
    await expect
      .poll(() => server.sessionReads, { message: 'the mirror removal made this tab re-read /bff/session' })
      .toBeGreaterThan(before);
  },
);

// ─── Thens ──────────────────────────────────────────────────────────────────

Then('this tab drops to no session over the broadcast channel', async ({ page }) => {
  await expect
    .poll(async () => await readSessionProbe(page), { message: 'the sign-out reaches this tab' })
    .toBeNull();
});

Then('the in-memory session carries the roles the BFF reported', async ({ page }) => {
  // hydrate() replaces login()'s roles:['user'] guess with the server's array,
  // VERBATIM (no drop, no up-case, order preserved).
  const probe = await waitForSessionProbeRoles(page);
  expect(probe.roles).toEqual(server.roles);
  expect(probe.registrationComplete).toBe(false);
});

Then('the second tab learns of the sign-in and hydrates the same session', async ({}) => {
  // HONESTY: since login-ui publishes the fleet mirror again there are TWO live
  // cross-tab transports — the BroadcastChannel post and the `storage` event the
  // mirror write raises — so this step does NOT prove the channel is the only
  // one. What it does prove is the part that matters and that a lost transport
  // would break: the other tab, provably anonymous a moment ago (its bootstrap
  // read got the 401), ends up holding the session with the SERVER's roles,
  // reached by its own cookie read. Channel-exclusivity is pinned separately in
  // the unit suite (hydrate() never posts; the mirror is written only from
  // set()/clear()), and the mirror-only transport has its own scenario below.
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

/** The half of the contract #3 actually retired: web storage holds no
 *  CREDENTIAL. Auth rides the httpOnly `bff_` cookie, so the published mirror
 *  must carry only the five non-secret fields and nothing token-shaped. */
Then('no credential is persisted to web storage', async ({ page }) => {
  for (const p of [page, pageRegistry.get(SECOND_TAB)].filter(Boolean) as Page[]) {
    const mirror = await readFleetMirror(p);
    expect(Object.keys(mirror ?? {}).sort()).toEqual(['id', 'label', 'provider', 'registrationComplete', 'roles']);
    for (const key of Object.keys(mirror ?? {})) expect(/token|secret|cookie|password/i.test(key)).toBe(false);
    expect(JSON.stringify(mirror ?? {})).not.toMatch(/bff_|XSRF|Bearer|eyJ/); // no cookie, CSRF token or JWT ever reaches storage
  }
});

/** The other half — the one whose absence locked every role-home out: the
 *  mirror the not-yet-migrated remotes read must exist and carry the SERVER's
 *  roles, not login()'s roles:['user'] guess. */
Then("the fleet mirror carries the server's roles for the not-yet-migrated remotes", async ({ page }) => {
  await expect
    .poll(async () => (await readFleetMirror(page))?.roles, { message: 'the hydrated roles reaching the fleet mirror' })
    .toEqual(server.roles);
  const mirror = await readFleetMirror(page);
  expect(mirror?.registrationComplete).toBe(false);
  // ...and it agrees with this app's own in-memory state.
  expect(mirror?.roles).toEqual((await readSessionProbe(page))?.roles);
});

/** Two tabs both publish the mirror, so "settled" must also mean they settled on
 *  the SAME bytes — otherwise each would keep overwriting the other's value. */
Then('both tabs agree on one fleet mirror value', async ({ page }) => {
  const here = await readFleetMirror(page);
  const there = await readFleetMirror(secondTab());
  expect(here).not.toBeNull();
  expect(there).toEqual(here);
  expect(here?.roles).toEqual(server.roles);
});

/** A sign-out has to REMOVE the mirror: it is the only sign-out signal the
 *  not-yet-migrated remotes get, and a value left behind leaves them showing a
 *  signed-in user whose cookie is dead. */
Then('the fleet mirror is gone, signing the not-yet-migrated remotes out too', async ({ page }) => {
  await expect
    .poll(async () => await readFleetMirror(page), { message: 'the sign-out removing the fleet mirror' })
    .toBeNull();
  expect(await evaluateFleetRemoteGuard(page)).toEqual({ loggedIn: false, isAdmin: false, guard: '/login' });
});

/** The fleet regression itself, run as the fleet runs it: hugmesh-admin-ui's own
 *  reader + adminGuard, verbatim, against the value login-ui published. */
Then("a not-yet-migrated remote's own guard admits the admin", async ({ page }) => {
  await expect
    .poll(async () => await evaluateFleetRemoteGuard(page), { message: "a sibling remote's guard admitting the signed-in admin" })
    .toEqual({ loggedIn: true, isAdmin: true, guard: true });
});


Then('this tab drops to no session over the legacy storage mirror', async ({ page }) => {
  // Nothing posted on the BroadcastChannel in that scenario — reaching anonymous
  // here IS the legacy-mirror bridge working (mutation-checked: detaching the
  // `storage` listener fails this scenario and nothing else in the file).
  await expect
    .poll(async () => await readSessionProbe(page), { message: 'the legacy sign-out reaches this tab' })
    .toBeNull();
});
