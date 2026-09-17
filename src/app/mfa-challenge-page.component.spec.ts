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

  it('resumes at ?returnTo= when the challenge is satisfied', () => {
    spyOn(router, 'parseUrl').and.returnValue({
      queryParams: { returnTo: '/social/forum/topic/7' },
    } as never);
    const nav = spyOn(router, 'navigateByUrl');
    child().satisfied.emit();
    expect(nav).toHaveBeenCalledWith('/social/forum/topic/7');
  });

  it('falls back to the security page when no returnTo was supplied', () => {
    spyOn(router, 'parseUrl').and.returnValue({ queryParams: {} } as never);
    const nav = spyOn(router, 'navigateByUrl');
    child().satisfied.emit();
    expect(nav).toHaveBeenCalledWith(MfaChallengePageComponent.DEFAULT_RETURN_TO);
    expect(MfaChallengePageComponent.DEFAULT_RETURN_TO).toBe('/login/security');
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
