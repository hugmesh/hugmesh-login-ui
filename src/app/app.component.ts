import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { LoginBackgroundComponent } from './login-background.component';

/**
 * Shell for the Login remote — and, on this platform, the document real users get.
 *
 * The fe-gateway matches /login/** directly to THIS container and serves its own
 * index.html (StripPrefix=1), which mounts this component; see the note at the top of
 * src/index.html. The remote is ALSO federable (`./routes`), and in that case a host
 * renders the routes inside its own chrome and this shell is not loaded — which is
 * why the backdrop lives here rather than in the login view: it should paint the
 * whole page when this shell IS the page, and never paint over a host's own chrome.
 */
@Component({
  selector: 'hug-login-root',
  standalone: true,
  imports: [RouterOutlet, LoginBackgroundComponent],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {}
