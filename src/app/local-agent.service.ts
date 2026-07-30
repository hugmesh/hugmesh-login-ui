import { Injectable } from '@angular/core';

/**
 * FIXED loopback origin of the local passwordless-login agent (owned by
 * generator/Studio). Per the pinned wire contract this is EXACTLY
 * `http://127.0.0.1:27621` — loopback only, one fixed port, NEVER a LAN
 * interface and NEVER a port scan. login-ui probes only this origin; if the
 * agent does not answer here it simply does not exist for us and the login view
 * falls back to the username/password form.
 */
const AGENT_ORIGIN = 'http://127.0.0.1:27621';

/**
 * The custom header BOTH agent routes REQUIRE. Its presence is load-bearing for
 * the agent's CORS hardening: a non-safelisted request header forces a CORS
 * preflight (OPTIONS), so a browser "simple request" (a form POST, an <img>, a
 * beacon) can never reach `/v1/roles` or `/v1/handoff`; the agent 403s any
 * request that arrives without it. We send ONLY this custom header (plus the
 * default safelisted content-type on the body) because the agent's
 * `Access-Control-Allow-Headers` allow-list is exactly `X-HugMesh-Local` —
 * adding e.g. an explicit `content-type: application/json` would make the
 * preflight ask for a header the agent does not allow, and the browser would
 * block the call.
 */
const LOCAL_HEADER = 'X-HugMesh-Local';

/** A role the local agent advertises for one-click sign-in. Metadata ONLY — the
 *  `/v1/roles` probe NEVER returns a secret; the credential is vended separately
 *  and single-use via {@link LocalAgentService.handoff}. */
export interface LocalRole {
  /** Stable role id echoed back on the handoff request (e.g. `brandowner`). */
  id: string;
  /** Human label rendered on the role card (e.g. `Brand Owner`). */
  label: string;
  /** The brand/tenant the role belongs to (e.g. `acme`); may be blank. */
  brand: string;
}

/** The single-use, short-TTL credential the agent vends for a chosen role
 *  (`POST /v1/handoff`). The {@code secret} is used IMMEDIATELY by the caller and
 *  is NEVER persisted (no localStorage, no session) — a fresh probe is required
 *  to re-vend it. */
export interface LocalHandoff {
  roleId: string;
  username: string;
  secret: string;
  /** ISO-8601 expiry (now+30s per contract); advisory only for the client. */
  expiresAt: string;
}

/**
 * Talks to the LOCAL passwordless-login agent on `127.0.0.1:27621` (login-ui's
 * half of the passwordless-local-secrets contract). Two routes, both requiring
 * the {@link LOCAL_HEADER} custom header:
 *
 *   • `GET  /v1/roles`   — metadata-only probe: which local roles can sign in.
 *   • `POST /v1/handoff` — single-use, short-TTL credential for a chosen role.
 *
 * Custody rules honoured here:
 *   • NEVER send cookies to the agent (`credentials: 'omit'`). The agent
 *     authenticates the caller by loopback + a server-side Origin allow-list +
 *     the custom header; it does NOT emit `Access-Control-Allow-Credentials`, so
 *     a credentialed request would be blocked by the browser anyway.
 *   • Both calls DEGRADE GRACEFULLY: any failure (agent absent → fetch rejects,
 *     non-200, malformed body, CORS/Origin rejection) resolves to an empty/null
 *     result rather than throwing, so the login view can fall back to the
 *     password form and NEVER breaks normal sign-in.
 *   • The handoff {@code secret} is returned to the caller (BffService.loginLocal)
 *     and submitted immediately; this service holds no state and persists nothing.
 */
@Injectable({ providedIn: 'root' })
export class LocalAgentService {
  /**
   * Probe `GET /v1/roles`. Returns the advertised roles, or `[]` on ANY failure
   * (agent not running, non-200, malformed JSON, CORS/Origin rejection) so the
   * caller falls back to the password form. NEVER throws.
   */
  async roles(): Promise<LocalRole[]> {
    let r: Response;
    try {
      r = await fetch(`${AGENT_ORIGIN}/v1/roles`, {
        method: 'GET',
        // No cookies to the loopback agent (see class doc); the custom header
        // forces the CORS preflight the agent's hardening depends on.
        credentials: 'omit',
        headers: { [LOCAL_HEADER]: '1' },
      });
    } catch {
      return [];
    }
    if (!r.ok) return [];
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return [];
    }
    const raw = (body as { roles?: unknown } | null)?.roles;
    if (!Array.isArray(raw)) return [];
    return raw.map(toLocalRole).filter((x): x is LocalRole => x !== null);
  }

  /**
   * Request the SINGLE-USE, short-TTL credential for {@code roleId}
   * (`POST /v1/handoff`). Returns the handoff, or `null` on any failure. NEVER
   * throws and NEVER persists the returned secret — the caller must submit it
   * immediately.
   *
   * The body is sent as a plain JSON string WITHOUT an explicit
   * `content-type: application/json` header on purpose: that header is not in the
   * agent's CORS `Access-Control-Allow-Headers` (only `X-HugMesh-Local` is),
   * so setting it would fail the preflight. The default safelisted `text/plain`
   * content-type carries the JSON string fine, and the custom header still forces
   * the preflight.
   */
  async handoff(roleId: string): Promise<LocalHandoff | null> {
    let r: Response;
    try {
      r = await fetch(`${AGENT_ORIGIN}/v1/handoff`, {
        method: 'POST',
        credentials: 'omit',
        headers: { [LOCAL_HEADER]: '1' },
        body: JSON.stringify({ roleId }),
      });
    } catch {
      return null;
    }
    if (!r.ok) return null;
    let body: unknown;
    try {
      body = await r.json();
    } catch {
      return null;
    }
    const b = body as Record<string, unknown> | null;
    if (typeof b?.['username'] !== 'string' || typeof b?.['secret'] !== 'string') return null;
    return {
      roleId: typeof b['roleId'] === 'string' ? (b['roleId'] as string) : roleId,
      username: b['username'] as string,
      secret: b['secret'] as string,
      expiresAt: typeof b['expiresAt'] === 'string' ? (b['expiresAt'] as string) : '',
    };
  }
}

/** Narrow one arbitrary entry from the agent's `roles[]` into a {@link LocalRole},
 *  or `null` if it is missing the id/label a card needs (defends against a
 *  malformed/hostile response — we only render what we can verify). */
function toLocalRole(x: unknown): LocalRole | null {
  if (!x || typeof x !== 'object') return null;
  const o = x as Record<string, unknown>;
  if (typeof o['id'] !== 'string' || o['id'].length === 0) return null;
  if (typeof o['label'] !== 'string' || o['label'].length === 0) return null;
  return {
    id: o['id'],
    label: o['label'],
    brand: typeof o['brand'] === 'string' ? o['brand'] : '',
  };
}
