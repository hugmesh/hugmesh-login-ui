/**
 * playwright-bdd BDD World + hook registration for the login-ui e2e suite.
 *
 * This file is the SINGLE ENTRY POINT for step imports: it re-exports the
 * extended `test` instance (with the `fixture` custom fixture) plus
 * `Given`/`When`/`Then`/etc. hook factories. Every step file MUST import
 * `{ Given, When, Then, ... }` from here, not from `playwright-bdd` directly,
 * so all hooks and step definitions are bound to the SAME `test` instance the
 * generated specs use.
 *
 * HOOK PLACEMENT (load-bearing). `playwright-bdd`'s `createBdd(test)` returns
 * hook factories (`Before`, `After`, `AfterStep`, …) that must be CALLED
 * (i.e. the hook body registered) against the very same `test` instance the
 * generated specs consume. If hook registrations are split across files loaded
 * independently via the `steps[]` glob, load ordering races and hooks silently
 * never fire. Keeping ALL hook registrations here, in a single support file,
 * is the reliable pattern.
 *
 * CUSTOM FIXTURE — `fixture(handle)`. Each feature file names identities by a
 * human handle (e.g. `'alice'`). The `fixture` function resolves that handle
 * into a {@link LoginFixture} (provider, email/username, registration state,
 * account status) from the {@link LOGIN_FIXTURES} catalogue. A typo in a
 * feature file throws loudly (instead of silently driving the wrong realm) so
 * test failures are immediately actionable.
 *
 * SCREENSHOT CAPTURE (AfterStep). Every step appends a path-based PNG
 * attachment to the HTML report so a reviewer can see the UI state at every
 * transition without re-running. Path-based attachments are used (not body-
 * based) because Playwright's HTML reporter only persists path-based ones into
 * `html/data`.
 *
 * OFFLINE GATE (Before). Scenarios tagged `@cluster` are runtime-skipped
 * (not dropped) when `E2E_LIVE` is unset so they still appear in
 * `playwright test --list` and step binding is proven offline.
 */

import { test as base, createBdd } from 'playwright-bdd';
import { LOGIN_FIXTURES, LoginFixture } from '../../tests/helpers/roles';
import { ctxRegistry, resetRegistry } from '../steps/_registry';

/**
 * The custom Playwright fixture surface added to the BDD World. Step
 * definitions destructure `{ fixture }` from their World argument to resolve
 * a feature-file handle (e.g. `'alice'`) into a fully-typed
 * {@link LoginFixture} without threading identity data through step params.
 */
interface FixtureLookup {
  /**
   * Resolve a login fixture by its handle string.
   *
   * @param handle - The identity handle named in the feature file
   *   (e.g. `'alice'`, `'bob_banned'`). Must exactly match a
   *   {@link LoginFixture.handle} in {@link LOGIN_FIXTURES}.
   * @returns The matching {@link LoginFixture}.
   * @throws {Error} When the handle is not found in {@link LOGIN_FIXTURES},
   *   so a typo in a feature file fails loudly instead of silently driving
   *   the wrong identity or provider.
   */
  fixture(handle: string): LoginFixture;
}

export const test = base.extend<FixtureLookup>({
  fixture: async ({}, use) => {
    await use((handle: string) => {
      const found = LOGIN_FIXTURES.find((f) => f.handle === handle);
      if (!found) {
        throw new Error(
          `Unknown login fixture: "${handle}". Known: ${LOGIN_FIXTURES.map((f) => f.handle).join(', ')}`,
        );
      }
      return found;
    });
  },
});

export const { Given, When, Then, Step, Before, After, BeforeStep, AfterStep, BeforeAll, AfterAll } =
  createBdd(test);

// ─── Step-level screenshot capture ─────────────────────────────────
// Every step gets a PNG attached to the HTML report so a reviewer can see the
// UI state at every transition (focus on the error live region, the appeal
// landing, the complete-registration gate) without re-running.

let stepCounter = 0;

// Whether a live integration-test host is reachable. Until then the harness
// ships dark: @cluster scenarios are runtime-skipped (not dropped), so they
// still appear in `playwright test --list` to prove step binding.
const E2E_LIVE = process.env.E2E_LIVE === '1';

Before(async ({ $tags, $testInfo }) => {
  stepCounter = 0;
  resetRegistry();
  // Ship dark: skip any scenario that needs the real login round-trip / host
  // federation shell unless an integration-test host is wired (E2E_LIVE=1).
  if ($tags.includes('@cluster') && !E2E_LIVE) {
    $testInfo.skip(true, 'cluster-dependent: needs a live integration-test host (set E2E_LIVE=1)');
  }
});

AfterStep(async ({ page, $step, $testInfo }) => {
  stepCounter += 1;
  // Path-based attach. Body-based attachments succeed at attach time but
  // Playwright's HTML reporter only persists path-based ones into html/data.
  try {
    const stepTitle = ($step as { title?: string })?.title ?? `step-${stepCounter}`;
    const safeName = `${String(stepCounter).padStart(2, '0')}-${stepTitle}`
      .replace(/[^a-z0-9_-]+/gi, '-')
      .slice(0, 80);
    const filePath = $testInfo.outputPath(`${safeName}.png`);
    await page.screenshot({ path: filePath, fullPage: false });
    await $testInfo.attach(`step ${safeName}`, { path: filePath, contentType: 'image/png' });
  } catch {
    // Page closed mid-step (context torn down) — drop silently.
  }
});

After(async () => {
  // Close any contexts a scenario opened by hand so cookies / federation init
  // don't leak into the next scenario's login.
  for (const ctx of ctxRegistry.values()) {
    try { await ctx.close(); } catch { /* already closed */ }
  }
  resetRegistry();
  stepCounter = 0;
});
