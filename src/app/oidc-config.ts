/**
 * Runtime SESSION-CUSTODY flag reader.
 *
 * THIS remote's own username/password form is the only login surface — the
 * browser is NEVER redirected to Casdoor, so there is no client-side OIDC/PKCE
 * redirect, no Casdoor issuer/authorize URL, and no code-exchange in the SPA (the
 * user-bff drives Casdoor's INTERNAL login + code exchange SERVER-SIDE and mints
 * the opaque `bff_` cookie). All that remains here is the host-injected flag that
 * selects the opaque-cookie SESSION-CUSTODY model.
 *
 * Read off `globalThis` at RUNTIME (the hugmesh.net host injects
 * `globalThis.__HUG_*__` before federating this remote — this remote only READS
 * them). With the global absent, {@link oidcEnabled} is false and the session is
 * held in the legacy localStorage mode.
 */

/**
 * Whether the opaque-cookie custody session model is active. When true, the
 * browser holds ONLY the httpOnly `bff_` session cookie and the non-secret
 * session metadata is hydrated from `GET /bff/session` (never persisted to web
 * storage). It NO LONGER gates any Casdoor redirect — the SPA has none.
 *
 * FALSE unless the host explicitly sets `globalThis.__HUG_OIDC_ENABLED__ = true`.
 */
export function oidcEnabled(): boolean {
  return (globalThis as any).__HUG_OIDC_ENABLED__ === true;
}
