/**
 * Angular bootstrap for the login-ui DEV SHELL. Mounts {@link AppComponent}
 * with the {@link routes} (LOGIN_ROUTES mounted at '') so the remote is
 * browsable standalone via `ng serve login`.
 *
 * In production this file is NOT loaded — the hugmesh.systems host
 * federates `./routes` (LOGIN_ROUTES) directly at the /login mount.
 */
import { bootstrapApplication } from '@angular/platform-browser';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app/app.component';
import { routes } from './app/app.routes';

bootstrapApplication(AppComponent, {
  // provideHttpClient() backs the generated ng-openapi-gen clients (src/app/api),
  // which the migrated PublicAnnouncementsService delegates to. The opaque
  // bff_session login/register/provision flow in BffService still uses fetch
  // directly and is unaffected.
  providers: [provideRouter(routes), provideHttpClient()],
}).catch((err) => console.error(err));
