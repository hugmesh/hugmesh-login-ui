import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { AppealContactControllerService } from './api/services/appeal-contact-controller.service';

/** BFF base URL, provided by the host at runtime (same source as BffService). */
const CFG = {
  bff: (globalThis as any).__HUG_BFF_URL__ ?? '',
};

/** The public appeal-contact resolver response shape: ONLY a contact email
 *  (no PII, no admin/mod identity) — see the admin-bff AppealContactController. */
export interface AppealContact {
  /** The support address a blocked user mails their appeal to, or `null` when
   *  the resolver is unreachable (so the page renders instructions regardless). */
  email: string | null;
}

/**
 * Reads the PUBLIC, UNAUTHENTICATED appeal-contact resolver
 * (`GET /bff/public/appeal-contact`) so a banned / suspended / logged-out
 * principal — who has NO usable session — can be shown a real support `mailto:`
 * address to appeal to. Mirrors {@link PublicAnnouncementsService}: the request
 * carries NO Authorization header and NO cookies (it is the anonymous surface),
 * and a failed / malformed fetch degrades silently to `{ email: null }` so the
 * appeal PAGE still renders its instructions even if only the address is missing.
 *
 * <p><b>ng-openapi-gen migration:</b> this service now DELEGATES the read to
 * the generated, typed {@link AppealContactControllerService} (under
 * {@code src/app/api}) instead of hand-rolling a {@code fetch} — the same
 * established pattern as {@code PublicAnnouncementsService}. The generated
 * client's {@code rootUrl} is pinned to the host-provided {@code __HUG_BFF_URL__}
 * so the wire URL is byte-identical to the legacy path, and it is called with NO
 * {@code withCredentials} and no Authorization header, exactly as the legacy
 * fetch did — this is the anonymous resolver.
 *
 * The admin-bff marks `/bff/public/**` permitAll and returns ONLY
 * `{ "email": "<address>" }` — deliberately no PII — so this is safe to fetch
 * before (and without) any login. See the GATEWAY dependency noted on the
 * AppealComponent: the hugmesh-gateway PUBLIC floor currently allowlists only
 * `/bff/public/announcements/**`, so until a `/bff/public/appeal-contact` (or
 * broader `/bff/public/**`) PUBLIC row is added the anonymous fetch may 401 at
 * the gateway — this service degrades to `null` exactly so the page survives that.
 */
@Injectable({ providedIn: 'root' })
export class AppealContactService {
  private readonly appeal = inject(AppealContactControllerService);

  constructor() {
    // Pin the generated client to the host-provided BFF origin so the wire URL
    // is identical to the legacy `${__HUG_BFF_URL__}/bff/public/...` path.
    this.appeal.rootUrl = CFG.bff;
  }

  /** Fetch the public appeal-contact email. Never throws; null on any failure. */
  async contact(): Promise<AppealContact> {
    try {
      const body = await firstValueFrom(
        this.appeal.appealContactAppealContact().pipe(map((b) => b as unknown as { email?: unknown } | null)),
      );
      const email = typeof body?.email === 'string' && body.email.trim().length > 0 ? body.email : null;
      return { email };
    } catch {
      return { email: null };
    }
  }
}
