/**
 * Angular bootstrap for the login-ui DEV SHELL. Mounts {@link AppComponent}
 * with the {@link routes} (LOGIN_ROUTES mounted at '') so the remote is
 * browsable standalone via `ng serve login`.
 *
 * In production this file is NOT loaded — the hugmesh.net host
 * federates `./routes` (LOGIN_ROUTES) directly at the /login mount.
 */
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  // provideHttpClient() backs the generated ng-openapi-gen clients (src/app/api),
  // which every migrated service delegates to — the anonymous public reads AND,
  // since #2, the credentialed session/register/provision/appeal/MFA calls (those
  // opt in per call via withBffCredentials, so the cookie rides along without an
  // interceptor). In PRODUCTION this file is not loaded and the generated clients
  // — `providedIn: 'root'` — take the HOST's HttpClient; the login route already
  // depended on that before #2 (LoginBannerComponent -> PublicAnnouncementsService),
  // and hugmesh-host-shell provides it in its own bootstrap. The two cookie-mint
  // sign-in calls in BffService still use fetch directly and are unaffected.
  providers: [provideRouter(routes), provideHttpClient()],
}).catch((err) => console.error(err));
