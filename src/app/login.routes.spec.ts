import { Route } from '@angular/router';
import { LOGIN_ROUTES } from './login.routes';
import { localeGuard } from './i18n/locale.guard';
import { sessionHydrateGuard } from './session-hydrate.guard';
import { LoginComponent } from './login.component';
import { AppealComponent } from './appeal.component';
import { ForgotPasswordComponent } from './forgot-password.component';
import { MfaEnrollComponent } from './mfa-enroll.component';
import { MfaChallengeComponent } from './mfa-challenge.component';
import { MfaSecurityComponent } from './mfa-security.component';

/**
 * These specs lock down the federation contract: `./routes` (exposed under the
 * remote name "login") is the single module the hugmesh.net host mounts
 * at /login. The host depends on these paths and components, so a regression
 * here would silently break the host's login/registration flow.
 *
 * i18n changed the SHAPE of this array but deliberately NOT the contract: the
 * five routes moved under a PATHLESS parent that carries {@link localeGuard}
 * (which loads the translation catalog before anything renders). A pathless
 * parent consumes no URL segment, so every URL the host and the e2e harness
 * drive resolves exactly as before. The specs below therefore assert the URL
 * contract THROUGH the nesting rather than against the parent — matching on the
 * flat array again would be the regression.
 */
describe('LOGIN_ROUTES (exposed ./routes federation contract)', () => {
  /** The five real routes, reached through the locale-guard wrapper. */
  const mounted = (): Route[] => {
    const parent = LOGIN_ROUTES[0];
    return parent.children ?? [];
  };
  const at = (path: string) => mounted().find((r) => r.path === path);

  it('exposes exactly one pathless parent (adds no URL segment)', () => {
    expect(LOGIN_ROUTES.length).toBe(1);
    expect(LOGIN_ROUTES[0].path).toBe('');
    expect(LOGIN_ROUTES[0].component).toBeUndefined();
  });

  it('guards every entry into the remote with the locale loader', () => {
    // The catalog MUST be loaded before any component renders; a route that
    // escaped the wrapper would render untranslated with no error at all.
    expect(LOGIN_ROUTES[0].canMatch).toEqual([localeGuard]);
    expect(LOGIN_ROUTES.every((r) => r.component === undefined)).toBe(true);
  });

  it('kicks off the bootstrap session hydrate on every entry (non-gating canActivate on the parent)', () => {
    // Cookie custody holds the session in memory only, so a fresh document must
    // ask /bff/session; the parent is the one place that covers all six routes.
    // It is a canActivate (the catalog must already be in) and, like the locale
    // loader, it always answers true — it is a hook, not a gate.
    expect(LOGIN_ROUTES[0].canActivate).toEqual([sessionHydrateGuard]);
  });

  it('exposes the LoginComponent at the empty path (default mount point)', () => {
    expect(at('')?.component).toBe(LoginComponent);
  });

  it('exposes the AppealComponent at the `appeal` path (banned-user appeal page)', () => {
    expect(at('appeal')?.component).toBe(AppealComponent);
  });

  it('exposes the ForgotPasswordComponent at the `forgot-password` path', () => {
    // The recovery route. It is part of the FEDERATION CONTRACT: the host mounts it at
    // /login/forgot-password and the sign-in form links to it relatively, so losing it
    // here silently strands every locked-out user on a dead link.
    expect(at('forgot-password')?.component).toBe(ForgotPasswordComponent);
  });

  it('does NOT guard the forgot-password route behind anything', () => {
    // A visitor reaching this page has no session and no working credential BY
    // DEFINITION, so any canActivate/canMatch on it would be the lock-out itself.
    const route = at('forgot-password');
    expect(route?.canActivate).toBeUndefined();
    expect(route?.canMatch).toBeUndefined();
  });

  it('declares every route with either a component or children (no dead routes)', () => {
    for (const route of mounted()) {
      expect(route.component || route.children).withContext(`route ${route.path}`).toBeTruthy();
    }
  });

  it('contains no duplicate paths', () => {
    const paths = mounted().map((r) => r.path);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it('exposes the MFA enrollment wizard at `mfa/enroll`', () => {
    expect(at('mfa/enroll')?.component).toBe(MfaEnrollComponent);
  });

  it('exposes the MFA step-up challenge at `mfa/challenge`', () => {
    expect(at('mfa/challenge')?.component).toBe(MfaChallengeComponent);
  });

  it('exposes the self-service security section at `security`', () => {
    expect(at('security')?.component).toBe(MfaSecurityComponent);
  });

  it('exposes NO OIDC `callback` route (the SPA never redirects to Casdoor)', () => {
    // The native username/password form is the only login surface, so there is no
    // Casdoor redirect landing to mount.
    expect(at('callback')).toBeUndefined();
  });

  it('mounts the paths the host and e2e harness already drive, plus forgot-password', () => {
    expect(mounted().map((r) => r.path)).toEqual([
      '',
      'appeal',
      'forgot-password',
      'mfa/enroll',
      'mfa/challenge',
      'security',
    ]);
  });
});
