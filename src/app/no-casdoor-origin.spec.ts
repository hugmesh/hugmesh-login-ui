import * as oidcConfigModule from './oidc-config';

/**
 * Guard: the SPA's OWN username/password form is the only login surface — the
 * browser is NEVER redirected to Casdoor. This pins that the client-side OIDC/PKCE
 * REDIRECT surface has been fully retired, so no Casdoor origin / authorize URL can
 * be constructed anywhere in the app (the user-bff drives Casdoor's INTERNAL login
 * + code exchange server-side; the browser only holds the opaque bff_ cookie).
 *
 * A complementary build-time check greps the compiled bundle for a Casdoor origin
 * (see README "Build"); this unit guard fails fast the moment any Casdoor URL
 * builder is reintroduced into the source.
 */
describe('no Casdoor origin in the SPA (native-login custody)', () => {
  // Read the module through a plain, dynamically-typed handle so the checks below
  // don't create a static named-import binding to a (deliberately absent) export.
  const mod = oidcConfigModule as unknown as Record<string, unknown>;

  it('oidc-config exposes ONLY the session-custody flag — no Casdoor URL builder', () => {
    // The former oidcConfig()/OidcConfig authorize-URL surface is gone; the
    // remaining export is a boolean flag that selects the cookie-custody session
    // model, NOT any redirect.
    expect(typeof mod['oidcEnabled']).toBe('function');
    expect((mod['oidcEnabled'] as () => boolean)()).toBe(false);
    expect(mod['oidcConfig']).toBeUndefined();
    expect(Object.keys(mod)).toEqual(['oidcEnabled']);
  });

  it('no exported value produces a casdoor origin or an OAuth authorize path — even with a Casdoor issuer set', () => {
    // A malicious/stale Casdoor issuer global must have NO effect: nothing in the
    // config surface turns it into a reachable authorize URL.
    (globalThis as Record<string, unknown>)['__HUG_OIDC_ISSUER__'] = 'https://casdoor.evil.example';
    try {
      for (const value of Object.values(mod)) {
        if (typeof value === 'function') {
          let out: unknown;
          try { out = (value as () => unknown)(); } catch { out = ''; }
          expect(String(out)).not.toMatch(/casdoor/i);
          expect(String(out)).not.toMatch(/\/login\/oauth\/authorize/i);
        }
      }
    } finally {
      delete (globalThis as Record<string, unknown>)['__HUG_OIDC_ISSUER__'];
    }
  });
});
