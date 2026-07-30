import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { AppComponent } from './app.component';

/**
 * The AppComponent is the standalone dev shell (`ng serve login`). In
 * production the host federates `./routes` directly and never renders this
 * shell — but served standalone it must still meet the a11y baseline: a
 * skip-to-content link and a focusable <main> landmark wrapping the router
 * outlet, so a keyboard user can jump straight to the login view.
 */
describe('AppComponent (standalone dev shell)', () => {
  let fixture: ComponentFixture<AppComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [AppComponent],
      providers: [provideRouter([])],
    }).compileComponents();
    fixture = TestBed.createComponent(AppComponent);
    fixture.detectChanges();
  });

  it('creates the dev-shell root', () => {
    expect(fixture.componentInstance).toBeTruthy();
  });

  it('renders a skip-to-content link that targets the main landmark', () => {
    const el: HTMLElement = fixture.nativeElement;
    const skip = el.querySelector<HTMLAnchorElement>('a.skip');
    expect(skip).toBeTruthy();
    expect(skip!.getAttribute('href')).toBe('#hug-login-main');
    // The skip target must actually exist or the link is a dead end.
    const target = el.querySelector('#hug-login-main');
    expect(target).toBeTruthy();
  });

  it('wraps the router outlet in a focusable <main> landmark', () => {
    const el: HTMLElement = fixture.nativeElement;
    const main = el.querySelector<HTMLElement>('main#hug-login-main');
    expect(main).toBeTruthy();
    // tabindex=-1 lets the skip link move focus into the landmark.
    expect(main!.getAttribute('tabindex')).toBe('-1');
    expect(main!.querySelector('router-outlet')).toBeTruthy();
  });

  it('makes the skip link the FIRST keyboard-focusable element (WCAG 2.4.1)', () => {
    const el: HTMLElement = fixture.nativeElement;
    // The skip link must be the very first interactive node so a keyboard user's
    // initial Tab lands on it before anything else.
    const firstInteractive = el.querySelector<HTMLElement>('a[href], button, input, [tabindex]:not([tabindex="-1"])');
    expect(firstInteractive).toBeTruthy();
    expect(firstInteractive!.classList.contains('skip')).withContext('first focusable is the skip link').toBeTrue();
  });

  it('makes the skip link a native, focusable <a> that targets a focusable main (no positive tabindex)', () => {
    const el: HTMLElement = fixture.nativeElement;
    const skip = el.querySelector<HTMLAnchorElement>('a.skip')!;
    expect(skip.tagName).toBe('A');
    // Native anchor with an href => Tab-reachable + Enter-activatable for free.
    expect(skip.getAttribute('href')).toBe('#hug-login-main');
    expect(skip.getAttribute('tabindex')).toBeNull(); // natural focus order
    skip.focus();
    expect(document.activeElement).withContext('skip link is focusable').toBe(skip);
  });
});
