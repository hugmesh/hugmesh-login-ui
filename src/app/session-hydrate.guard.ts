import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { SessionService } from './session.service';

/**
 * Bootstrap-hydrate hook for every entry into this remote. NOT a gate — it
 * always returns `true`, synchronously.
 *
 * The session is held in memory only (httpOnly-cookie custody, login-ui #3), so
 * a fresh document — a reload of `/login`, a deep link to `/login/appeal` or
 * `/login/security`, the remote being mounted lazily by the host shell — has no
 * way to know whether the browser holds a live `bff_` cookie except by asking
 * `GET /bff/session`. This kicks that read off ({@link SessionService.ensureHydrated},
 * memoised per instance) WITHOUT waiting for it: the front door must render
 * immediately even when the BFF is slow or dark, and every view here reads the
 * session through signals, so the pending-registration card, the appeal form
 * and the greeting simply appear when the read resolves. An anonymous visitor's
 * read 401s and resolves to "no session", which is the state the views already
 * start in.
 */
export const sessionHydrateGuard: CanActivateFn = () => {
  void inject(SessionService).ensureHydrated();
  return true;
};
