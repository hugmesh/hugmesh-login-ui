/**
 * Shared per-scenario module-global state for the login-ui BDD suite.
 *
 * playwright-bdd recreates the test instance for each scenario; the
 * {@link Before} / {@link After} hooks in `features/support/fixtures.ts`
 * call {@link resetRegistry} so each scenario starts with a clean slate.
 * Keys are fixture HANDLES (string names such as `'alice'`) so step
 * definitions can reference an identity by name without threading a `Page`
 * reference through every step's arguments.
 *
 * Design constraint: playwright-bdd's step functions receive the World
 * (Playwright fixtures) as their first argument, but cross-step state
 * (e.g. "the page alice signed in with") must live in module scope; the
 * registry is that module-scope store.
 */

import { BrowserContext, Page } from '@playwright/test';

/**
 * Maps a fixture handle (e.g. `'alice'`) to the Playwright {@link Page}
 * that performed the sign-in step for that identity. Populated by "When
 * <handle> signs in" steps and read by "Then the login view is …" steps.
 */
export const pageRegistry = new Map<string, Page>();

/**
 * Maps a fixture handle to the {@link BrowserContext} the step opened
 * (for scenarios that open a second context, e.g. cross-user isolation
 * checks). Closed wholesale in the {@link After} hook.
 */
export const ctxRegistry = new Map<string, BrowserContext>();

/** Last HTTP status captured by an API-style step (e.g. a mocked /bff/login
 *  reply, or a real POST /bff/admin/allowlist seed call). Module-global so the
 *  assertion step needn't thread the World. */
export const responseState = { lastStatus: 0 };

/** Per-scenario state for the REAL-WRITE (admin-invite -> register) scenarios
 *  (register-invite-gate.feature). `nonce` makes every seeded allowlist handle
 *  unique per run (repeat runs against a live stack must not collide with a
 *  stale allowlist row); `uniqueNames` translates the declarative names used in
 *  .feature lines to the real, uniquified email/discord handle actually POSTed
 *  to /bff/admin/allowlist and then typed into the register form — mirrors
 *  hugmesh-admin-ui's scenarioState (allowlist-invite.feature). Cleared on
 *  scenario teardown. */
export const scenarioState = {
  nonce: '',
  uniqueNames: new Map<string, string>(),
};

/** Lazily mint the per-scenario uniquifier (lowercase alnum, DNS-label safe). */
export function scenarioNonce(): string {
  if (!scenarioState.nonce) {
    scenarioState.nonce =
      Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  }
  return scenarioState.nonce;
}

/**
 * Clear all per-scenario module state. Called from the {@link Before}
 * hook (so each scenario starts clean) and the {@link After} hook (so
 * leaked references don't carry into the next scenario).
 */
export function resetRegistry(): void {
  pageRegistry.clear();
  ctxRegistry.clear();
  responseState.lastStatus = 0;
  scenarioState.nonce = '';
  scenarioState.uniqueNames.clear();
}
