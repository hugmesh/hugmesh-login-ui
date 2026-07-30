import { Injectable, inject } from '@angular/core';
import { SessionService } from './session.service';
import {
  ChallengeFactor,
  MfaFactor,
  MfaResult,
  TotpEnrollStart,
  WebAuthnOptions,
} from './mfa.types';

/** BFF base URL, provided by the host at runtime (same source as BffService). */
const CFG = {
  bff: (globalThis as any).__HUG_BFF_URL__ ?? '',
};

/** The HTTP status the admin-bff returns for EVERY `/bff/mfa/*` call while the
 *  feature ships dark (`app.casdoor.mfa.enabled=false`). The UI treats it as
 *  "MFA not yet launched" — hide/disable the surface, never surface an error. */
const DARK_STATUS = 503;

/**
 * Hand-written client for the admin-bff `/bff/mfa/*` contract — deliberately
 * mirrors {@link BffService}'s plain-`fetch` style (no generated client) so the
 * two stay byte-similar and reviewable side by side.
 *
 * AUTH (owner == authenticated subject ALWAYS): the owner is the authenticated
 * `bff_session` subject the BFF derives from the JWT `sub` / auth-name — NEVER a
 * request-body field. The browser holds NO bearer: every call sends
 * `credentials: 'include'` so the httpOnly `bff_` cookie rides along (the gateway
 * turns it into the upstream bearer server-side). The UI passes no subject
 * anywhere; it cannot enroll/list/remove anyone else's factors.
 *
 * SHIPS DARK: while `app.casdoor.mfa.enabled=false` every endpoint answers 503.
 * Each method returns an {@link MfaResult} whose {@code dark} flag is set on a
 * 503 so callers degrade to "MFA not enabled" instead of showing an error. NO
 * SECRETS are persisted — the TOTP secret + recovery codes are returned to the
 * caller for a single display-once render and never written to storage.
 */
@Injectable({ providedIn: 'root' })
export class MfaService {
  private readonly session = inject(SessionService);

  // ---- ENROLL -------------------------------------------------------------

  /** Start TOTP enrollment. Factor stored DISABLED; secret/otpauthUri shown ONCE
   *  for the QR + manual-entry step. No step-up (bootstrap). */
  enrollTotp(): Promise<MfaResult<TotpEnrollStart>> {
    return this.post<TotpEnrollStart>('/bff/mfa/enroll/totp');
  }

  /** Verify a 6-digit TOTP passcode and ENABLE the pending factor. Returns the
   *  display-once recovery codes (10, format XXXX-XXXX-XXXX-XXXX). */
  verifyTotp(passcode: string): Promise<MfaResult<{ enabled: boolean; recoveryCodes: string[] }>> {
    return this.post('/bff/mfa/enroll/totp/verify', { passcode });
  }

  /** Request a WebAuthn registration challenge — feed to navigator.credentials.create(). */
  enrollWebauthnOptions(): Promise<MfaResult<WebAuthnOptions>> {
    return this.post<WebAuthnOptions>('/bff/mfa/enroll/webauthn/options');
  }

  /** Submit the navigator.credentials.create() attestation to register the passkey. */
  verifyWebauthn(attestation: string): Promise<MfaResult<{ factorId: string; enabled: boolean }>> {
    return this.post('/bff/mfa/enroll/webauthn/verify', { attestation });
  }

  /** Request a WebAuthn assertion challenge for step-up — feed to
   *  navigator.credentials.get(); the result is submitted via {@link challenge}. */
  assertWebauthnOptions(): Promise<MfaResult<WebAuthnOptions>> {
    return this.post<WebAuthnOptions>('/bff/mfa/assert/webauthn/options');
  }

  // ---- LIST / MUTATE ------------------------------------------------------

  /** List the caller's OWN factors (no secrets, ever). */
  factors(): Promise<MfaResult<{ factors: MfaFactor[] }>> {
    return this.request('GET', '/bff/mfa/factors');
  }

  /** Remove one of the caller's factors. STEP-UP GATED (403 without fresh step-up). */
  removeFactor(id: string): Promise<MfaResult<{ removed: boolean }>> {
    return this.request('DELETE', `/bff/mfa/factors/${encodeURIComponent(id)}`);
  }

  /** Regenerate the display-once recovery code set (invalidates the prior set).
   *  STEP-UP GATED (403 without fresh step-up). */
  regenerateRecovery(): Promise<MfaResult<{ recoveryCodes: string[] }>> {
    return this.post('/bff/mfa/recovery/regenerate');
  }

  // ---- STEP-UP CHALLENGE (existing, unchanged shape) ----------------------

  /** Satisfy an MFA step-up with a TOTP code / recovery code / WebAuthn assertion.
   *  {@code credential} is the 6-digit code, the XXXX-…-formatted recovery code,
   *  or the navigator.credentials.get() response JSON string for webauthn. */
  challenge(factor: ChallengeFactor, credential: string): Promise<MfaResult<{ mfaSatisfied: boolean }>> {
    return this.post('/bff/mfa/challenge', { factor, credential });
  }

  // ---- transport ----------------------------------------------------------

  private post<T>(path: string, body?: unknown): Promise<MfaResult<T>> {
    return this.request<T>('POST', path, body);
  }

  /** The shared transport: cookie auth, JSON in/out, and the 503-is-dark mapping.
   *  Never throws — a network failure maps to a non-dark error result so callers
   *  always get a structured outcome. */
  private async request<T>(method: string, path: string, body?: unknown): Promise<MfaResult<T>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    const mutating = method !== 'GET' && method !== 'HEAD';
    // The httpOnly `bff_` cookie carries auth — NO Bearer header, ever. In cookie
    // mode echo the double-submit X-CSRF-TOKEN on every mutating /bff/mfa/* call
    // (these are NOT cookie-mint endpoints, so the BFF require-matcher enforces CSRF).
    if (this.session.cookieMode && mutating) Object.assign(headers, this.session.csrfHeader());
    const init: RequestInit = {
      method,
      headers,
      // Send the opaque-session cookie; the gateway turns it into the bearer.
      credentials: 'include',
    };
    if (body !== undefined) {
      headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    let r: Response;
    try {
      r = await fetch(`${CFG.bff}${path}`, init);
    } catch {
      return { ok: false, dark: false, status: 0, error: 'Network error' };
    }
    if (r.status === DARK_STATUS) {
      return { ok: false, dark: true, status: DARK_STATUS };
    }
    const data = (await r.json().catch(() => undefined)) as any;
    if (!r.ok) {
      return { ok: false, dark: false, status: r.status, error: data?.error || `HTTP ${r.status}` };
    }
    return { ok: true, dark: false, status: r.status, data: data as T };
  }
}
