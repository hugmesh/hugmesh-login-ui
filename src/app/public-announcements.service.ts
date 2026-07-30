import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { map } from 'rxjs/operators';
import { AnnouncementFeed } from './announcement.types';
import { AnnouncementSurfaceControllerService } from './api/services/announcement-surface-controller.service';

/** BFF base URL, provided by the host at runtime (same source as BffService). */
const CFG = {
  bff: (globalThis as any).__HUG_BFF_URL__ ?? '',
};

/**
 * Reads the PUBLIC, UNAUTHENTICATED login-announcement feed
 * (`GET /bff/public/announcements/login`) shown to ALL visitors at the top of
 * the login page. This endpoint is `permitAll` at the BFF and PUBLIC at the
 * gateway, so the request carries NO Authorization header — it is reachable
 * before (and without) a session. A failed/empty fetch degrades silently to an
 * empty feed so the login form is never blocked by the banner.
 *
 * <p><b>ng-openapi-gen migration (pilot):</b> this service now DELEGATES the
 * read to the generated, typed {@link AnnouncementSurfaceControllerService}
 * (under {@code src/app/api}, generated from the admin-bff-api OpenAPI spec)
 * instead of hand-rolling a {@code fetch}. The generated client calls the SAME
 * {@code /bff/public/announcements/login} path; its {@code rootUrl} is pinned to
 * the host-provided {@code __HUG_BFF_URL__} so the wire URL is byte-identical
 * to the legacy path. The endpoint's OpenAPI response is an untyped
 * {@code Map<String,Object>}, so the typed surface returns {@code { [k: string]:
 * {} }}; this service BRIDGES that to its own public {@link AnnouncementFeed}
 * type at the delegation boundary (as-unknown-as), so {@link LoginBannerComponent}
 * — which consumes only {@link AnnouncementFeed} — needs ZERO change. The same
 * defensive contract is preserved: never throws, and a non-OK / network-failure
 * / unexpected-shape payload degrades to an empty feed. This is an ANONYMOUS
 * read: the generated client attaches no Authorization header and no credentials
 * (no withCredentials), exactly as the legacy fetch did.
 */
@Injectable({ providedIn: 'root' })
export class PublicAnnouncementsService {
  private readonly surface = inject(AnnouncementSurfaceControllerService);

  constructor() {
    // Pin the generated client to the host-provided BFF origin so the wire URL
    // is identical to the legacy `${__HUG_BFF_URL__}/bff/public/...` path.
    this.surface.rootUrl = CFG.bff;
  }

  /** Fetch the public login-announcement feed. Never throws. */
  async login(): Promise<AnnouncementFeed> {
    try {
      const feed = await firstValueFrom(
        this.surface.announcementSurfaceLogin().pipe(
          // The OpenAPI endpoint is typed as an untyped Map<String,Object>;
          // bridge it to our own AnnouncementFeed shape at this boundary.
          map((body) => body as unknown as AnnouncementFeed | null),
        ),
      );
      return { announcements: Array.isArray(feed?.announcements) ? feed!.announcements : [] };
    } catch {
      return { announcements: [] };
    }
  }
}
