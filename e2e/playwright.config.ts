import { defineConfig, devices } from '@playwright/test';
import { defineBddConfig } from 'playwright-bdd';

// The host federates this remote in and mounts its routes at /login, so the
// auth entry point lives under /login on the integration-test host. Overridable
// for a dev shell (`ng serve login`) via E2E_BASE_URL.
const baseURL = process.env.E2E_BASE_URL ?? 'https://host.docker.internal:8080';

// Results root. Defaults to a repo-local `results/` so the offline gate
// (`bddgen` + `playwright test --list`) and a bare `ng`-less host both work;
// the CI Docker image mounts a `/work` workdir and sets E2E_RESULTS_DIR=/work
// so artefacts land where the harvest expects them.
const resultsDir = process.env.E2E_RESULTS_DIR ?? 'results';

// playwright-bdd compiles every .feature under features/ into a generated
// .spec.js below .features-gen/, picked up via `testDir`, and wires the World
// fixture from features/support/fixtures.ts (which also inlines the
// Before/AfterStep/After hooks). Step definitions live under features/steps/.
const bddTestDir = defineBddConfig({
  features: 'features/**/*.feature',
  steps: [
    'features/steps/**/*.ts',
    'features/support/**/*.ts',
  ],
  // NO tag-exclusion filter here on purpose. The suite has TWO classes
  // (see e2e/README.md):
  //
  //  - OFFLINE (untagged) — mock only the boundary (`/bff/*`, the loopback
  //    Studio agent, the i18n catalog) via `page.route()` and run the REAL
  //    component pipeline. These DO execute, and must stay green, whenever the
  //    remote itself is served at `E2E_BASE_URL` (see the README's "Running the
  //    offline suite locally").
  //  - `@cluster` — drive a REAL login round-trip (BFF /bff/login,
  //    /bff/register/*, Casdoor, the host federation shell) and SHIP DARK: the
  //    `Before` hook in features/support/fixtures.ts calls `testInfo.skip()`
  //    unless `E2E_LIVE=1` (a reachable integration-test host) is set.
  //
  // The `e2e:bdd` CI job today serves no remote and sets no host, so it runs the
  // OFFLINE GATE ONLY (`bddgen` + `--list`) and executes NO scenario of either
  // class — it proves compilation and step binding, nothing more.
  //
  // We deliberately do NOT use a `tags: 'not @cluster'` FILTER (nor the special
  // playwright-bdd `@skip` tag): either of those DROPS the scenario from
  // generation entirely, so `npx playwright test --list` would show nothing and
  // could not prove step binding. Generating-then-runtime-skipping keeps that
  // gate meaningful while the live class ships dark with no host present. Serve
  // the remote (offline class) and/or flip `E2E_LIVE=1` against a live host
  // (@cluster class) to actually execute the scenarios.
});

export default defineConfig({
  // Single-worker. Per-provider login through Casdoor + federation manifest
  // fetches contend on a small dev stack; serial keeps the matrix reliable.
  fullyParallel: false,
  workers: 1,
  // One retry catches the rare login-page flake without papering over a real
  // regression — a deterministic failure fails twice in a row.
  retries: 1,
  timeout: 180_000,
  reporter: [
    ['list'],
    ['html', { outputFolder: `${resultsDir}/html`, open: 'never' }],
  ],
  outputDir: `${resultsDir}/artifacts`,
  use: {
    baseURL,
    // Accept the self-signed integration-test cert without rejecting.
    ignoreHTTPSErrors: true,
    // Trace + per-step screenshot + video forced ON so the report carries the
    // UI state at every transition (mirrors the hugmesh.games harvest path).
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'on',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
    // Optional escape hatch for dev boxes without the Playwright-bundled
    // Chromium (e.g. E2E_BROWSER_CHANNEL=chrome uses the system Chrome). CI
    // uses the pre-baked mcr.microsoft.com/playwright image and leaves this
    // unset (bundled Chromium).
    ...(process.env.E2E_BROWSER_CHANNEL ? { channel: process.env.E2E_BROWSER_CHANNEL } : {}),
  },
  projects: [
    {
      // BDD project — generated specs from .feature files plus their step
      // definitions. This is the only project: this harness is pure BDD (no
      // handwritten tests/*.spec.ts), so `tests/` carries helpers only.
      name: 'bdd',
      testDir: bddTestDir,
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
