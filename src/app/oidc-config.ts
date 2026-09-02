/**
 * Runtime OIDC-login-path flag reader.
 *
 * THIS remote's own username/password form is the only login surface — the
 * browser is NEVER redirected to Casdoor, so there is no client-side OIDC/PKCE
 * redirect, no Casdoor issuer/authorize URL, and no code-exchange in the SPA (the
 * user-bff drives Casdoor's INTERNAL login + code exchange SERVER-SIDE and mints
 * the opaque `bff_` cookie).
 *
 * Read off `globalThis` at RUNTIME (the hugmesh.net host injects
 * `globalThis.__HUG_*__` before federating this remote — this remote only READS
 * them). Session CUSTODY does not depend on it: since login-ui #3 the session is
 * ALWAYS the httpOnly `bff_` cookie, hydrated from `GET /bff/session` and never
 * persisted to web storage (the former localStorage mode and its
 * `__HUG_SESSION_COOKIE_MODE__` switch are gone).
 */

/**
 * Whether the host reports the OIDC login path as active. It NO LONGER gates any
 * Casdoor redirect (the SPA has none) and NO LONGER selects a custody model
 * (there is only one). Its single remaining effect is cosmetic: a session
 * hydrated with no caller-established identity (a reload with a live cookie) is
 * tagged `provider: 'oidc'` instead of the vestigial `'google'` placeholder —
 * see SessionService.hydrate(); nothing in the UI reads that tag.
 *
 * FALSE unless the host explicitly sets `globalThis.__HUG_OIDC_ENABLED__ = true`.
 */
export function oidcEnabled(): boolean {
  return (globalThis as any).__HUG_OIDC_ENABLED__ === true;
}
