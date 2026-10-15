import { Component, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { MfaChallengeComponent } from './mfa-challenge.component';

/**
 * The only shape `?returnTo=` may take: a SAME-ORIGIN ABSOLUTE PATH (#23).
 *
 *   ^\/           one leading slash — so `https://evil.example/`,
 *                 `javascript:…` and a bare `social/forum` can never match
 *   (?![/\\])     and the NEXT character is not another slash or a backslash —
 *                 `//evil.example/x` is a protocol-relative URL and
 *                 `/\evil.example/x` is the same thing after a browser
 *                 normalises `\` to `/`
 *   [^\s\\…]*     no backslash, no whitespace and no C0/DEL control character
 *                 anywhere. A browser STRIPS raw CR/LF/TAB when it resolves a
 *                 URL, so `/\n//evil.example` would smuggle a `//` past the
 *                 lookahead; legitimate values are percent-encoded and contain
 *                 none of these.
 *
 * The backslash is rejected TWICE on purpose — by the lookahead and again by
 * the character class — so neither half can be relaxed alone into a hole.
 * Measured consequence: mutating the lookahead to `(?!\/)` alone changes no
 * outcome (enumerated over every string of length <= 4 drawn from
 * `/ \ a . : % ? # SP TAB LF NUL DEL`: 30941 inputs, zero differences), so a
 * mutation test of that half is an EQUIVALENT MUTANT and will not go red.
 *
 * WHY A SHAPE CHECK AND NOT A PREFIX LIST. #23 offered both. A prefix list
 * (`/login/`, `/social/`, `/wiki/`, `/mod/`) has to be kept in step with the
 * fe-gateway's route table, which lives in another repo — that is a fleet
 * decision nobody has made, and getting it out of step strands users silently.
 * The shape check needs no such coupling and still closes the redirect: every
 * value it accepts resolves against this origin.
 *
 * HOW BAD WAS THE OLD BEHAVIOUR. Modest, and worth stating so nobody
 * over-claims: `Router.navigateByUrl()` does not cross an origin, so
 * `https://evil.example/` was treated as an in-app URL and simply failed to
 * match a route. The realistic abuse was steering a user to an unexpected
 * IN-APP route after a step-up. What makes it worth closing anyway is that the
 * value was reaching a navigation primitive UNCHECKED, one refactor away from a
 * sink that does cross origins — this repo already owns one,
 * HardNavigationService (`window.location.replace`).
 */
const SAFE_RETURN_TO = /^\/(?![/\\])[^\s\\\u0000-\u001f\u007f]*$/;

/**
 * The ROUTED `/login/mfa/challenge` page — a thin shell around the one
 * {@link MfaChallengeComponent}, holding everything that is specific to being a
 * PAGE rather than an embedded dialog:
 *
 *   • the `?returnTo=` resume (default `/login/security`), which is the contract
 *     every caller that LINKS here relies on — hugmesh-forum-ui ships exactly
 *     that link today (`/login/mfa/challenge?returnTo=<url>`), and it keeps
 *     working unchanged, subject to the SAFE_RETURN_TO allowlist below (#23):
 *     same-origin absolute paths only, anything else resumes at the default;
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

  /** Where to resume when no `?returnTo=` was supplied — and where a value that
   *  is not a same-origin absolute path is sent instead. */
  static readonly DEFAULT_RETURN_TO = '/login/security';

  /**
   * The `?returnTo=` allowlist (#23). Anything that is not a same-origin
   * absolute path falls back to {@link DEFAULT_RETURN_TO}; it is never an error
   * the user sees, because the step-up itself SUCCEEDED and stranding them on
   * an error page would be a worse outcome than landing on their security page.
   *
   * `raw` is deliberately `unknown`: Angular hands back an ARRAY when a query
   * parameter is repeated (`?returnTo=/a&returnTo=//evil.example`), and the
   * previous code would have passed that array straight to `navigateByUrl`.
   */
  static safeReturnTo(raw: unknown): string {
    return typeof raw === 'string' && SAFE_RETURN_TO.test(raw)
      ? raw
      : MfaChallengePageComponent.DEFAULT_RETURN_TO;
  }

  /** Resume the gated action's surface. Read off the CURRENT url rather than an
   *  injected ActivatedRoute snapshot so the behaviour is identical whether the
   *  page was reached by a full load or an in-app navigation. */
  resume(): void {
    const requested = this.router.parseUrl(this.router.url).queryParams['returnTo'];
    void this.router.navigateByUrl(MfaChallengePageComponent.safeReturnTo(requested));
  }

  onUnavailable(): void {
    this.dark.set(true);
  }
}
