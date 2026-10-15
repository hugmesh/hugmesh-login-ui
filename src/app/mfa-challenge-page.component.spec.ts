import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { MfaChallengePageComponent } from './mfa-challenge-page.component';
import { MfaChallengeComponent } from './mfa-challenge.component';
import { MfaService } from './mfa.service';

/**
 * The routed `/login/mfa/challenge` page. Everything it owns is what makes it a
 * PAGE rather than an embedded dialog: the `?returnTo=` resume and the
 * back-to-sign-in link. The challenge itself is the shared component and is
 * covered by its own spec.
 *
 * The returnTo contract is cross-repo: hugmesh-forum-ui links here with
 * `?returnTo=<its own url>` today (forum-ui#3 / #16), so a regression here
 * strands a moderator on the security page instead of the topic they were on.
 *
 * #23 CHANGED WHAT THESE SPECS PIN, and deliberately did not delete them. They
 * used to assert that an ARBITRARY value was honoured verbatim, which locked in
 * the permissive behaviour. They now assert the ALLOWLIST: a same-origin
 * absolute path is still honoured — forum-ui's contract is untouched — and
 * anything else resumes at DEFAULT_RETURN_TO instead of reaching
 * `navigateByUrl()` at all.
 */
describe('MfaChallengePageComponent (the routed /login/mfa/challenge page)', () => {
  let fixture: ComponentFixture<MfaChallengePageComponent>;
  let page: MfaChallengePageComponent;
  let router: Router;

  async function setup(): Promise<void> {
    await TestBed.configureTestingModule({
      imports: [MfaChallengePageComponent],
      providers: [
        provideRouter([]),
        {
          provide: MfaService,
          useValue: jasmine.createSpyObj<MfaService>('MfaService', [
            'challenge',
            'assertWebauthnOptions',
          ]),
        },
      ],
    }).compileComponents();
    fixture = TestBed.createComponent(MfaChallengePageComponent);
    page = fixture.componentInstance;
    router = TestBed.inject(Router);
    fixture.detectChanges();
  }

  function child(): MfaChallengeComponent {
    return fixture.debugElement.children.find((d) => d.componentInstance instanceof MfaChallengeComponent)!
      .componentInstance as MfaChallengeComponent;
  }

  beforeEach(setup);

  it('renders the shared challenge component, not a second implementation', () => {
    expect(child()).toBeInstanceOf(MfaChallengeComponent);
  });

  it('turns the shared cancel button OFF (this surface has its own way back)', () => {
    expect(child().cancellable()).toBeFalse();
    expect(
      (fixture.nativeElement as HTMLElement).querySelector('[data-testid="mfa-challenge-cancel"]'),
    ).toBeNull();
  });

  /** Drive one satisfied challenge with `returnTo` set to `value`. */
  function resumeWith(value: unknown): jasmine.Spy {
    spyOn(router, 'parseUrl').and.returnValue({ queryParams: { returnTo: value } } as never);
    const nav = spyOn(router, 'navigateByUrl');
    child().satisfied.emit();
    return nav;
  }

  it('resumes at ?returnTo= when the challenge is satisfied (same-origin absolute path)', () => {
    // The forum-ui contract, unchanged by #23: this shape is still honoured
    // verbatim, which is the whole point of allowlisting the SHAPE rather than
    // a list of mount-point prefixes.
    expect(resumeWith('/social/forum/topic/7')).toHaveBeenCalledWith('/social/forum/topic/7');
  });

  it('falls back to the security page when no returnTo was supplied', () => {
    spyOn(router, 'parseUrl').and.returnValue({ queryParams: {} } as never);
    const nav = spyOn(router, 'navigateByUrl');
    child().satisfied.emit();
    expect(nav).toHaveBeenCalledWith(MfaChallengePageComponent.DEFAULT_RETURN_TO);
    expect(MfaChallengePageComponent.DEFAULT_RETURN_TO).toBe('/login/security');
  });

  it('#23: a protocol-relative returnTo never reaches navigateByUrl', () => {
    // The one that matters most: `//evil.example/x` is a URL, not a path. It is
    // the value the old code passed straight through.
    expect(resumeWith('//evil.example/x')).toHaveBeenCalledWith(
      MfaChallengePageComponent.DEFAULT_RETURN_TO,
    );
  });

  it('#23: a REPEATED ?returnTo= (an array, not a string) resumes at the default', () => {
    // Angular hands back an array for `?returnTo=/a&returnTo=//evil.example`.
    // The old code would have given that array to navigateByUrl().
    expect(resumeWith(['/social/forum/topic/7', '//evil.example/x'])).toHaveBeenCalledWith(
      MfaChallengePageComponent.DEFAULT_RETURN_TO,
    );
  });

  describe('#23: the returnTo allowlist (same-origin absolute paths only)', () => {
    // Control characters are built rather than written literally: a browser
    // STRIPS raw CR/LF/TAB while resolving a URL, so `/x<LF>//evil.example`
    // would otherwise smuggle a protocol-relative URL past a leading-slash
    // check — and a literal one in a source file is invisible to a reviewer.
    const ch = (code: number) => String.fromCharCode(code);

    const accepted = [
      '/login/security',
      '/social/forum/topic/7',
      '/mod/queue?tab=1',
      '/wiki/page#anchor',
      '/x%20y',
      '/',
    ];
    const rejected: Array<[string, unknown]> = [
      ['a protocol-relative URL', '//evil.example/x'],
      ['a backslash authority (browsers normalise \\ to /)', '/\\evil.example/x'],
      ['an absolute URL', 'https://evil.example/'],
      ['a scheme', 'javascript:alert(1)'],
      ['a relative path (resolves against the current route)', 'social/forum/topic/7'],
      ['an embedded LF', '/x' + ch(10) + '//evil.example'],
      ['an embedded CR', '/x' + ch(13) + '//evil.example'],
      ['an embedded TAB', '/x' + ch(9) + '//evil.example'],
      ['an embedded NUL', '/x' + ch(0) + 'y'],
      ['a leading space', ' //evil.example/x'],
      ['the empty string', ''],
      ['a non-string', { toString: () => '/social/forum/topic/7' }],
      ['null', null],
      ['undefined', undefined],
    ];

    for (const value of accepted) {
      it(`accepts ${JSON.stringify(value)}`, () => {
        expect(MfaChallengePageComponent.safeReturnTo(value)).toBe(value);
      });
    }
    for (const [what, value] of rejected) {
      it(`rejects ${what}`, () => {
        // Compared as a BOOLEAN with withContext(), not `expect(got).toBe(…)`:
        // several of these values carry a raw control character, and jasmine
        // putting one into a failure message makes karma abort the whole run
        // with an UncaughtException instead of reporting the failing spec.
        // Measured: with the allowlist mutated, `toBe` gave
        // "UncaughtException: Invalid character in string" and no TOTAL line.
        // A guard whose failure mode crashes the runner reports nothing.
        const got = MfaChallengePageComponent.safeReturnTo(value);
        expect(got === MfaChallengePageComponent.DEFAULT_RETURN_TO)
          .withContext(`${what} must fall back to DEFAULT_RETURN_TO`)
          .toBeTrue();
      });
    }
  });

  it('does NOT navigate on anything but a satisfied challenge', () => {
    const nav = spyOn(router, 'navigateByUrl');
    child().unavailable.emit();
    child().dismissed.emit();
    expect(nav).not.toHaveBeenCalled();
  });

  it('shows the back-to-sign-in link only once the surface reports itself dark', () => {
    const el = () => fixture.nativeElement as HTMLElement;
    expect(el().querySelector('a')).toBeNull();
    child().unavailable.emit();
    fixture.detectChanges();
    expect(page.dark()).toBeTrue();
    const link = el().querySelector('a');
    expect(link?.textContent).toContain('Back to sign in');
  });
});
