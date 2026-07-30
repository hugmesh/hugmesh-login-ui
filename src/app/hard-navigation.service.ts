import { Injectable } from '@angular/core';

/**
 * A thin, mockable wrapper around a HARD (full-page) browser navigation.
 *
 * This remote DOES build a module-federation `remoteEntry` (see
 * federation.config.js), but the fe-gateway route table matches `/login/**`
 * to THIS container directly, before the frontend-host catch-all — so in the
 * actual deployed topology nothing ever fetches it, and this app effectively
 * runs standalone (its own index.html, own Router, own Angular zone). Leaving
 * it (e.g. to reach the host shell at '/') therefore cannot go through the
 * Angular Router, which only ever has this remote's own login routes to
 * resolve. `window.location` itself isn't a spy-able target in a real
 * browser (its methods are non-configurable), so this indirection exists
 * purely to keep the hard-nav call site unit-testable without touching the
 * global `window`/`DOCUMENT`.
 */
@Injectable({ providedIn: 'root' })
export class HardNavigationService {
  /** `.replace()`, not `.assign()` — the just-submitted login form shouldn't
   *  linger in browser history; hitting Back after a successful sign-in
   *  should not return to a fresh, unauthenticated GET of the login page. */
  navigate(url: string): void {
    window.location.replace(url);
  }
}
