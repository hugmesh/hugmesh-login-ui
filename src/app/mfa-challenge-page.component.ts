import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MfaChallengeComponent } from './mfa-challenge.component';

/**
 * The ROUTED `/login/mfa/challenge` page — a thin shell around the one
 * {@link MfaChallengeComponent}, holding everything that is specific to being a
 * PAGE rather than an embedded dialog:
 *
 *   • the `?returnTo=` resume (default `/login/security`), which is the contract
 *     every caller that LINKS here relies on — hugmesh-forum-ui ships exactly
 *     that link today (`/login/mfa/challenge?returnTo=<url>`), and it keeps
 *     working unchanged;
 *   • the "Back to sign in" link shown once the surface reports itself dark.
 *
 * WHY THE SPLIT EXISTS. `MfaChallengeComponent` is now ALSO the federated
 * `./mfa-step-up` module that forum, mod and wiki load in place
 * (hugmesh-generator#347 decision 21). An embedded copy must navigate NOWHERE —
 * under the host shell the injected `Router` is the SHELL's, so a navigate() or
 * an absolute `routerLink` inside the shared component would move the whole page
 * out from under the consumer. So the router lives HERE, in the one consumer
 * that is a page, and the shared component stays router-free. That is the whole
 * difference between the two uses; there is no second challenge implementation.
 *
 * The page opts OUT of the shared component's cancel button
 * (`[cancellable]="false"`): this surface already has its own way back and its
 * pre-federation look is unchanged.
 */
@Component({
  selector: 'hug-mfa-challenge-page',
  standalone: true,
  imports: [MfaChallengeComponent, RouterLink],
  templateUrl: './mfa-challenge-page.component.html',
  styleUrl: './mfa.component.scss',
})
export class MfaChallengePageComponent {
  private readonly router = inject(Router);

  /** The MFA surface answered 503 — show the way out of a page that can do
   *  nothing. Mirrors the child's own terminal state. */
  readonly dark = signal(false);

  /** Where to resume when no `?returnTo=` was supplied. */
  static readonly DEFAULT_RETURN_TO = '/login/security';

  /** Resume the gated action's surface. Read off the CURRENT url rather than an
   *  injected ActivatedRoute snapshot so the behaviour is identical whether the
   *  page was reached by a full load or an in-app navigation. */
  resume(): void {
    const returnTo =
      this.router.parseUrl(this.router.url).queryParams['returnTo'] ||
      MfaChallengePageComponent.DEFAULT_RETURN_TO;
    void this.router.navigateByUrl(returnTo);
  }

  onUnavailable(): void {
    this.dark.set(true);
  }
}
