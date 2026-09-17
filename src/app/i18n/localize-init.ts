/**
 * THE FLEET'S SINGLE `@angular/localize/init` IMPORTER.
 *
 * `/init` assigns `globalThis.$localize` from ITS OWN inlined copy of the
 * localize chunk — localize is never a shared singleton, because
 * native-federation hard-codes `@angular/localize`, `/init` and `/tools` into
 * its NG_SKIP_LIST. Two importers therefore race for one global, the last one
 * wins, and the loser's catalog is silently discarded: `$localize.translate` is
 * `undefined` on a virgin instance, so translation is skipped with NO error, NO
 * warning, not even the library's "No translation found" message. The symptom is
 * an untranslated UI that every local test passes.
 *
 * WHY THIS FILE EXISTS AT ALL. The import used to live at the top of
 * `login.routes.ts`, which was the repo's ONLY exposed federation entry point.
 * This remote now exposes TWO — `./routes` (the login/registration surface the
 * hugmesh.net host mounts at /login) and `./mfa-step-up` (the MFA step-up
 * challenge that forum, mod and wiki load in place; generator#347 decision 21).
 * A consumer that loads ONLY `./mfa-step-up` never imports `./routes`, so
 * `$localize` would be undefined the moment the challenge's compiled template
 * evaluated its `consts` factory — a hard ReferenceError, not a silent
 * English fallback.
 *
 * Hanging the import off a module BOTH entry points import keeps the invariant
 * exactly as strong as it was and makes it easier to state: **one module in this
 * repo imports `@angular/localize/init`, and it is this one.** `npm run
 * i18n:check` GATE 3 pins the file by path, so a second importer fails the
 * build.
 *
 * WHY ONE MODULE IS STILL ONE COPY ACROSS TWO ENTRY POINTS. The exposed modules
 * are bundled by ONE esbuild pass with code splitting on (that is what the
 * `@nf-internal/chunk-*` rows in the emitted `importmap.json` are), so a module
 * imported by two entry points is hoisted into a chunk both import — one
 * instance, one `globalThis.$localize` assignment, no race. The race this gate
 * exists to prevent is a CROSS-BUNDLE one (two different repos' bundles), and
 * that is unchanged: this repo still ships exactly one localize owner.
 *
 * Loading the CATALOG is a separate step from installing `$localize`: see
 * `i18n/locale.guard.ts` (the `./routes` path) and `loadMfaStepUpComponent()`
 * in `mfa-step-up.ts` (the `./mfa-step-up` path). The reasoning for both lives
 * in `federation-base.js`, the file the whole federation contract shares.
 */
import '@angular/localize/init';
