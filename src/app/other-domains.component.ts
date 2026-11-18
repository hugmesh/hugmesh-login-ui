import { Component, OnInit, inject, signal } from '@angular/core';

import { OtherDomain, OtherDomainsService } from './other-domains.service';

/**
 * "Sign in to another domain": a link to the sign-in page of every other domain this mesh
 * serves. Draws NOTHING unless the HTTPS door lists at least one (a mesh with no other
 * domain, a built image and a cluster all answer 404, so their sign-in page is unchanged).
 *
 * The domains share one set of people (the superbrand's tenant), so the same account signs
 * in on each; the browser keeps one session per host, which is why each is a plain link to
 * that domain's own sign-in page rather than a switch.
 */
@Component({
  selector: 'hug-other-domains',
  standalone: true,
  template: `
    @if (domains().length) {
      <nav class="hug-other-domains" data-testid="other-domains"
           aria-labelledby="hug-other-domains-heading">
        <h3 id="hug-other-domains-heading"
            i18n="Heading above the links to this mesh's other domains|@@login.otherDomains.heading">
          Sign in to another domain
        </h3>
        <ul>
          @for (d of domains(); track d.name) {
            <li><a [href]="d.url" [attr.data-domain]="d.name">{{ d.title }}</a></li>
          }
        </ul>
      </nav>
    }
  `,
  styles: [`
    .hug-other-domains { margin-top: 1.5rem; }
    .hug-other-domains h3 { font-size: 1rem; margin: 0 0 .5rem; }
    .hug-other-domains ul { list-style: none; margin: 0; padding: 0; display: flex;
      flex-wrap: wrap; gap: .5rem 1rem; }
  `],
})
export class OtherDomainsComponent implements OnInit {
  private readonly service = inject(OtherDomainsService);
  readonly domains = signal<OtherDomain[]>([]);

  async ngOnInit(): Promise<void> {
    this.domains.set(await this.service.load());
  }
}
