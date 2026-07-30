import { CanMatchFn } from '@angular/router';
import { installLocale } from './locale';

/**
 * Load the translation catalog BEFORE any login route renders.
 *
 * WHY A GUARD, AND NOT `main.ts` / `bootstrap.ts` — this is the single easiest
 * way to get federated i18n wrong. `src/main.ts` says it verbatim: *"In
 * production the host federates `./routes` (LOGIN_ROUTES) directly without
 * bootstrapping the shell"*, and `src/bootstrap.ts`: *"In production this file
 * is NOT loaded"*. Both are DEV-SHELL ONLY. A `loadTranslations()` call there
 * would translate the app under `ng serve` and be DEAD CODE in production —
 * a silently untranslated deploy that every local test passes.
 *
 * The exposed `./routes` module is the ONLY production entry point, so the load
 * must hang off it. A `canMatch` guard on the pathless parent of LOGIN_ROUTES
 * runs after the module is imported but before any child component is
 * instantiated — and since the compiler defers every template `$localize` into
 * a lazy `consts: () => {...}` factory evaluated at first render, awaiting the
 * catalog here means no message can be evaluated untranslated.
 *
 * ALWAYS RETURNS TRUE. It is a load hook, not an authorization gate: login must
 * never be blocked by a translation file. {@link installLocale} already swallows
 * every failure and falls back to English; the `catch` here is pure
 * defence-in-depth so no future edit can turn a catalog problem into a locked
 * door.
 *
 * RE-RUNS ON EVERY ACTIVATION, DELIBERATELY. Because `@angular/localize` is
 * never shared across federated bundles (it is hard-coded into
 * native-federation's NG_SKIP_LIST), each bundle inlines its own localize chunk,
 * and whichever bundle imports `@angular/localize/init` LAST wins
 * `globalThis.$localize` — a virgin instance has `translate === undefined`, so
 * `$localize` silently stops translating with no error and no warning. Today
 * login-ui is the fleet's only localize owner, so this cannot happen; re-running
 * the load is a cheap self-heal if a sibling remote ever mounts after us.
 * See the invariant recorded in `federation-base.js`.
 */
export const localeGuard: CanMatchFn = async () => {
  try {
    await installLocale();
  } catch {
    // Unreachable — installLocale never throws. Belt and braces: a translation
    // catalog must NEVER be able to lock a user out of the login page.
  }
  return true;
};
