import { Routes } from '@angular/router';
import { LOGIN_ROUTES } from './login.routes';

/** Dev-shell routes: mount the exposed Login routes at the root so the remote
 *  is browsable standalone. The host ignores this and loads `./routes`.
 *
 *  The routes are ALSO mounted under `login` so the standalone shell resolves
 *  the exact same `/login/*` URLs the hugmesh.systems host serves (the host
 *  federates `./routes` in at /login). This keeps deep links — e.g.
 *  `/login/appeal` and `/login/mfa/challenge` — path-compatible between the
 *  federated host and the standalone shell, which is what the offline Playwright
 *  e2e harness (e2e/) drives when no live host is wired. Dev-shell-only: the host
 *  never loads this file. */
export const routes: Routes = [
  { path: 'login', children: LOGIN_ROUTES },
  { path: '', children: LOGIN_ROUTES },
];
