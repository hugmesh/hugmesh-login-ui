/**
 * FLEET INVARIANT — `@angular/localize/init` has exactly ONE importer in this
 * repo, and it is `./i18n/localize-init`, which this exposed entry point imports
 * FIRST.
 *
 * `/init` assigns `globalThis.$localize` from ITS OWN copy of the localize chunk.
 * native-federation hard-codes `@angular/localize` into its NG_SKIP_LIST, so
 * localize is never a shared singleton and every BUNDLE that imports it inlines a
 * private copy. Two importing bundles race for one global, the last one wins, and
 * the loser's catalog is silently discarded — `$localize.translate` is `undefined`
 * on a virgin instance, so translation is skipped with NO error and NO warning.
 * hugmesh-login-ui is the fleet's sole owner of this import (verified: zero
 * `@angular/localize` in any sibling repo). `npm run i18n:check` GATE 3 enforces
 * it here; the reasoning lives in `federation-base.js`, the file the whole
 * federation contract shares.
 *
 * The import moved OUT of this file and into its own module when this remote
 * gained a SECOND exposed entry point, `./mfa-step-up` (generator#347 decision
 * 21) — a consumer that loads only that module never imports this one, and would
 * otherwise render a compiled i18n template with `$localize` undefined. One
 * module imported by both entry points is still exactly one copy: the exposes
 * are bundled by one esbuild pass with splitting on. See i18n/localize-init.ts.
 *
 * It is imported HERE, at the top of the exposed `./routes` surface, because this
 * module is that surface's only production entry point (the host federates
 * `./routes`; `main.ts`/`bootstrap.ts` are dev-shell only). Importing it at
 * module scope installs `$localize` before any component can render.
 */
import './i18n/localize-init';

import { Routes } from '@angular/router';
import { localeGuard } from './i18n/locale.guard';
import { sessionHydrateGuard } from './session-hydrate.guard';
import { LoginComponent } from './login.component';
import { AppealComponent } from './appeal.component';
import { ForgotPasswordComponent } from './forgot-password.component';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { MfaChallengePageComponent } from './mfa-challenge-page.component';
import { MfaSecurityComponent } from './mfa-security.component';

/**
 * Routes exposed by this native-federation remote (`./routes`). The
 * hugmesh.net host federates these in and mounts them at /login.
 *
 * The `appeal` route is the client-side appeal/contact page for a BANNED or
 * SUSPENDED user. Per the canonical pattern (hugmesh.games), it is NOT a POST
 * form — a fully revoked principal is hard-stopped at the gateway (403, no JWT),
 * so no @PreAuthorize BFF endpoint is reachable. Instead {@link AppealComponent}
 * GETs the permitAll appeal-contact RESOLVER (admin-bff
 * `GET /bff/public/appeal-contact` -> `{ email }`, MERGED) and renders a real
 * `mailto:` link + appeal instructions. The login view links here so a blocked
 * visitor can reach it; the host's banned landing can also deep-link
 * `/login/appeal?reason=<text>` to pass a blocked reason (announced role=alert).
 *
 * GATEWAY DEPENDENCY (honest gap): the admin-bff marks `/bff/public/**`
 * permitAll, but the hugmesh-gateway PUBLIC floor (the data-driven
 * `gateway_route_access` Postgres table enforced by `GatewayRouteAccessFilter`)
 * currently allowlists ONLY `/bff/public/announcements/**` — so an anonymous
 * `/bff/public/appeal-contact` fetch may 401 at the gateway until a PUBLIC row
 * is added for it. The page is built to DEGRADE: AppealContactService returns `null` and the page still shows
 * the appeal steps + a "couldn't load the address" notice.
 *
 * The `/bff/login` response carries account status (active|suspended|banned):
 * a blocked sign-in answers `{ error:'account_banned'|'account_suspended',
 * reason }`, which {@link BffService.login}/{@link BffService.loginLocal}
 * surface as `{ blocked:true, reason }` and {@link LoginComponent.submit}/
 * {@link LoginComponent.pickRole} route to `/login/appeal?reason=` automatically
 * (announced there in an assertive live region) — never the raw token. The
 * host's banned landing can also deep-link `/login/appeal?reason=<text>`.
 */
/**
 * MFA enrollment + step-up + self-service routes (D6+D8, ships dark). These are
 * MOUNTED unconditionally so the federation contract is stable, but they are
 * only meaningfully REACHABLE once the MFA surface is live: the host links to
 * them only behind the session/feature signal, AND every `/bff/mfa/*` call 503s
 * while `app.casdoor.mfa.enabled=false` — which each component maps to a terminal
 * "MFA not enabled" state. So nothing here does anything until enforcement flips.
 *
 *   • `mfa/enroll`    — the enrollment wizard (TOTP QR + verify, passkey, recovery)
 *   • `mfa/challenge` — the step-up challenge (TOTP / passkey / recovery code);
 *                       takes `?returnTo=` to resume the gated action after a stamp.
 *                       The page is {@link MfaChallengePageComponent}, a thin shell
 *                       that owns the returnTo navigation and the back link around
 *                       the SHARED {@link MfaChallengeComponent} — the same class the
 *                       federated `./mfa-step-up` module hands to forum, mod and wiki
 *                       (generator#347 decision 21). One implementation, two mounts.
 *   • `security`      — the self-service list + remove-factor / regenerate surface
 *
 * There is NO OIDC `callback` route: this remote's own username/password form is
 * the only login surface and the browser is never redirected to Casdoor, so there
 * is no redirect landing to mount.
 */
/**
 * The five real login routes. Mounted as CHILDREN of a pathless parent below so
 * one {@link localeGuard} covers every entry into this remote — see LOGIN_ROUTES.
 */
const ROUTES: Routes = [
  { path: '', component: LoginComponent },
  { path: 'appeal', component: AppealComponent },
  // FORGOT PASSWORD — the recovery route the platform had no equivalent of. It is a
  // SIBLING of the login form, not a child of any guard: the whole point is that the
  // visitor has no session and no working credential, so anything that required either
  // would be the lock-out itself. Mounted by the host at /login/forgot-password.
  { path: 'forgot-password', component: ForgotPasswordComponent },
  { path: 'mfa/enroll', component: MfaEnrollComponent },
  { path: 'mfa/challenge', component: MfaChallengePageComponent },
  { path: 'security', component: MfaSecurityComponent },
];

/**
 * The exposed federation surface (`./routes`), unchanged in URL shape: a
 * PATHLESS parent consumes no path segment, so every URL the host and the e2e
 * harness already drive (`/login`, `/login/appeal`, `/login/forgot-password`,
 * `/login/mfa/challenge`, `/login/security`) resolves exactly as before.
 *
 * The parent exists only to carry {@link localeGuard}, which loads the
 * translation catalog before any child component is instantiated. `canMatch`
 * (not `canActivate`) is deliberate: it runs during route MATCHING, the earliest
 * hook available, and it is the one that also covers a child that might later be
 * lazily loaded. The guard always returns true — it never gates access.
 *
 * The parent ALSO carries {@link sessionHydrateGuard} (`canActivate`, after the
 * catalog is in): the session lives in memory only (httpOnly-cookie custody,
 * login-ui #3), so every entry into the remote kicks off the ONE
 * `GET /bff/session` read that tells a fresh document whether the browser holds
 * a live cookie. It never waits on that read and always returns true — the
 * forgot-password route in particular must stay reachable with no session at all.
 */
export const LOGIN_ROUTES: Routes = [
  { path: '', canMatch: [localeGuard], canActivate: [sessionHydrateGuard], children: ROUTES },
];
