import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { SessionService } from './session.service';
import { MfaChallengeControllerService } from './api/services/mfa-challenge-controller.service';
import { MfaEnrollmentControllerService } from './api/services/mfa-enrollment-controller.service';
import { StrictHttpResponse } from './api/strict-http-response';
import { bffFailure, withBffCredentials } from './http/bff-credentials';
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
 * Client for the admin-bff `/bff/mfa/*` contract, delegating to the GENERATED,
 * typed {@link MfaEnrollmentControllerService} / {@link MfaChallengeControllerService}
 * (under {@code src/app/api}) — the same ng-openapi-gen migration
 * {@link PublicAnnouncementsService} and {@link AppealContactService} did for the
 * anonymous reads. The wire contract is unchanged: identical paths, methods and
 * bodies, with {@code rootUrl} pinned to the host-provided {@code __HUG_BFF_URL__}.
 *
 * AUTH (owner == authenticated subject ALWAYS): the owner is the authenticated
 * `bff_session` subject the BFF derives from the JWT `sub` / auth-name — NEVER a
 * request-body field. The browser holds NO bearer: every call is marked
 * credentialed ({@link withBffCredentials}) so the httpOnly `bff_` cookie rides
 * along (the gateway turns it into the upstream bearer server-side). The UI passes
 * no subject anywhere; it cannot enroll/list/remove anyone else's factors.
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
  private readonly enrollment = inject(MfaEnrollmentControllerService);
  private readonly challenges = inject(MfaChallengeControllerService);

  constructor() {
    // Pin the generated clients to the host-provided BFF origin so the wire URL is
    // identical to the legacy `${__HUG_BFF_URL__}/bff/mfa/...` paths.
    this.enrollment.rootUrl = CFG.bff;
    this.challenges.rootUrl = CFG.bff;
  }

  // ---- ENROLL -------------------------------------------------------------

  /** Start TOTP enrollment. Factor stored DISABLED; secret/otpauthUri shown ONCE
   *  for the QR + manual-entry step. No step-up (bootstrap). */
  enrollTotp(): Promise<MfaResult<TotpEnrollStart>> {
    return this.result(this.enrollment.mfaEnrollmentBeginTotp$Response({}, this.creds(true)));
  }

  /** Verify a 6-digit TOTP passcode and ENABLE the pending factor. Returns the
   *  display-once recovery codes (10, format XXXX-XXXX-XXXX-XXXX). */
  verifyTotp(passcode: string): Promise<MfaResult<{ enabled: boolean; recoveryCodes: string[] }>> {
    return this.result(
      this.enrollment.mfaEnrollmentVerifyTotp$Response({ body: { passcode } }, this.creds(true)),
    );
  }

  /** Request a WebAuthn registration challenge — feed to navigator.credentials.create(). */
  enrollWebauthnOptions(): Promise<MfaResult<WebAuthnOptions>> {
    return this.result(this.enrollment.mfaEnrollmentWebauthnOptions$Response({}, this.creds(true)));
  }

  /** Submit the navigator.credentials.create() attestation to register the passkey. */
  verifyWebauthn(attestation: string): Promise<MfaResult<{ factorId: string; enabled: boolean }>> {
    return this.result(
      this.enrollment.mfaEnrollmentWebauthnVerify$Response({ body: { attestation } }, this.creds(true)),
    );
  }

  /** Request a WebAuthn assertion challenge for step-up — feed to
   *  navigator.credentials.get(); the result is submitted via {@link challenge}. */
  assertWebauthnOptions(): Promise<MfaResult<WebAuthnOptions>> {
    return this.result(
      this.enrollment.mfaEnrollmentWebauthnAssertOptions$Response({}, this.creds(true)),
    );
  }

  // ---- LIST / MUTATE ------------------------------------------------------

  /** List the caller's OWN factors (no secrets, ever). */
  factors(): Promise<MfaResult<{ factors: MfaFactor[] }>> {
    // GET — not mutating, so no CSRF header (the BFF require-matcher exempts it).
    return this.result(this.enrollment.mfaEnrollmentListFactors$Response({}, this.creds(false)));
  }

  /** Remove one of the caller's factors. STEP-UP GATED (403 without fresh step-up). */
  removeFactor(id: string): Promise<MfaResult<{ removed: boolean }>> {
    return this.result(this.enrollment.mfaEnrollmentRemoveFactor$Response({ id }, this.creds(true)));
  }

  /** Regenerate the display-once recovery code set (invalidates the prior set).
   *  STEP-UP GATED (403 without fresh step-up). */
  regenerateRecovery(): Promise<MfaResult<{ recoveryCodes: string[] }>> {
    return this.result(
      this.enrollment.mfaEnrollmentRegenerateRecovery$Response({}, this.creds(true)),
    );
  }

  // ---- STEP-UP CHALLENGE (existing, unchanged shape) ----------------------

  /** Satisfy an MFA step-up with a TOTP code / recovery code / WebAuthn assertion.
   *  {@code credential} is the 6-digit code, the XXXX-…-formatted recovery code,
   *  or the navigator.credentials.get() response JSON string for webauthn. */
  challenge(factor: ChallengeFactor, credential: string): Promise<MfaResult<{ mfaSatisfied: boolean }>> {
    return this.result(
      this.challenges.mfaChallengeChallenge$Response({ body: { factor, credential } }, this.creds(true)),
    );
  }

  // ---- transport ----------------------------------------------------------

  /** The credentialed context every `/bff/mfa/*` call rides on. The httpOnly
   *  `bff_` cookie carries auth — NO Bearer header, ever. Echo the double-submit
   *  X-CSRF-TOKEN on every MUTATING call (these are NOT cookie-mint endpoints,
   *  so the BFF require-matcher enforces CSRF). */
  private creds(mutating: boolean) {
    return withBffCredentials(mutating ? this.session.csrfHeader() : {});
  }

  /** The shared outcome mapping: the 503-is-dark rule and a structured failure.
   *  Never throws — a network failure maps to a non-dark error result so callers
   *  always get a structured outcome. The `$Response` variants are used so the
   *  real HTTP status still reaches {@link MfaResult.status} on success. */
  private async result<T>(call: Observable<StrictHttpResponse<unknown>>): Promise<MfaResult<T>> {
    try {
      const r = await firstValueFrom(call);
      return { ok: true, dark: false, status: r.status, data: (r.body ?? undefined) as T };
    } catch (err) {
      const { status, body } = bffFailure(err);
      if (status === DARK_STATUS) {
        return { ok: false, dark: true, status: DARK_STATUS };
      }
      if (status === 0) {
        return { ok: false, dark: false, status: 0, error: 'Network error' };
      }
      return { ok: false, dark: false, status, error: body['error'] || `HTTP ${status}` };
    }
  }
}
