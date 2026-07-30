import { Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

/**
 * Standalone dev shell for the Login remote. Only used when this remote is
 * run on its own (`ng serve login`); in production the hugmesh.systems
 * host federates `./routes` (LOGIN_ROUTES) directly — this shell is not loaded.
 */
@Component({
  selector: 'hug-login-root',
  standalone: true,
  imports: [RouterOutlet],
  templateUrl: './app.component.html',
  styleUrl: './app.component.scss',
})
export class AppComponent {}
