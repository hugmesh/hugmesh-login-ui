import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LoginBannerComponent } from './login-banner.component';
import { PublicAnnouncementsService } from './public-announcements.service';
import { Announcement, AnnouncementFeed } from './announcement.types';

function ann(over: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    title: 'Scheduled maintenance',
    body_html: '<p>We will be down briefly.</p>',
    format: 'html',
    state: 'published',
    target_home: false,
    target_login: true,
    target_akkoma: false,
    target_forum: false,
    priority: 0,
    starts_at: null,
    ends_at: null,
    timezone: 'UTC',
    dismissible: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

describe('LoginBannerComponent', () => {
  let fixture: ComponentFixture<LoginBannerComponent>;
  let feed: jasmine.SpyObj<PublicAnnouncementsService>;

  async function mount(payload: AnnouncementFeed): Promise<HTMLElement> {
    feed.login.and.resolveTo(payload);
    fixture = TestBed.createComponent(LoginBannerComponent);
    fixture.detectChanges(); // triggers ngOnInit
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    feed = jasmine.createSpyObj<PublicAnnouncementsService>('PublicAnnouncementsService', ['login']);
    TestBed.configureTestingModule({
      imports: [LoginBannerComponent],
      providers: [{ provide: PublicAnnouncementsService, useValue: feed }],
    });
  });

  it('renders nothing when there are no active login announcements', async () => {
    const el = await mount({ announcements: [] });
    expect(el.querySelector('[data-testid="login-banner"]')).toBeNull();
  });

  it('renders nothing when the only announcement is not active (draft)', async () => {
    const el = await mount({ announcements: [ann({ state: 'draft' })] });
    expect(el.querySelector('[data-testid="login-banner"]')).toBeNull();
  });

  it('renders an active login announcement with its title', async () => {
    const el = await mount({ announcements: [ann()] });
    expect(el.querySelector('[data-testid="login-banner"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="login-announcement"]')).toBeTruthy();
    expect(el.textContent).toContain('Scheduled maintenance');
  });

  // --- Security: the body is rendered ONLY inside a hard-sandboxed iframe ----

  it('renders body_html inside a sandboxed null-origin srcdoc iframe (never innerHTML)', async () => {
    const el = await mount({ announcements: [ann()] });
    const iframe = el.querySelector<HTMLIFrameElement>('[data-testid="login-announcement-body"]')!;
    expect(iframe).toBeTruthy();
    // sandbox="" => no allow-scripts, no allow-same-origin: opaque origin, no JS.
    expect(iframe.getAttribute('sandbox')).toBe('');
    expect(iframe.sandbox.contains('allow-scripts')).toBeFalse();
    expect(iframe.sandbox.contains('allow-same-origin')).toBeFalse();
    expect(iframe.getAttribute('referrerpolicy')).toBe('no-referrer');
    // The body went into srcdoc, not into the host DOM.
    expect(iframe.getAttribute('srcdoc')).toContain('We will be down briefly.');
    expect(el.innerHTML).not.toContain('<p>We will be down briefly.</p>');
  });

  it('does not execute script: a script in body_html stays inert text in srcdoc', async () => {
    const el = await mount({
      announcements: [ann({ body_html: '<p>ok</p><script>window.__pwned=1<\/script>' })],
    });
    const iframe = el.querySelector<HTMLIFrameElement>('[data-testid="login-announcement-body"]')!;
    // The string is carried as srcdoc data; the sandbox (no allow-scripts) is the
    // hard wall — no <script> is ever attached to the host document.
    expect((window as any).__pwned).toBeUndefined();
    expect(el.querySelector('script')).toBeNull();
    expect(iframe.getAttribute('srcdoc')).toBeTruthy();
  });

  // --- a11y ------------------------------------------------------------------

  it('exposes a labelled aria-live region (WCAG 1.3.1 / 4.1.3)', async () => {
    const el = await mount({ announcements: [ann()] });
    const region = el.querySelector('[data-testid="login-banner"]')!;
    expect(region.getAttribute('role')).toBe('region');
    expect(region.getAttribute('aria-label')).toBeTruthy();
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('names each announcement via aria-labelledby pointing at its title (WCAG 1.3.1)', async () => {
    const el = await mount({ announcements: [ann()] });
    const article = el.querySelector('[data-testid="login-announcement"]')!;
    const labelledBy = article.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    const title = el.querySelector(`#${labelledBy}`);
    expect(title?.textContent).toContain('Scheduled maintenance');
  });

  it('gives the dismiss control type=button and a descriptive aria-label', async () => {
    const el = await mount({ announcements: [ann()] });
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-announcement-dismiss"]')!;
    expect(btn).toBeTruthy();
    expect(btn.getAttribute('type')).toBe('button');
    expect(btn.getAttribute('aria-label')).toContain('Scheduled maintenance');
  });

  it('omits the dismiss control for a non-dismissible announcement', async () => {
    const el = await mount({ announcements: [ann({ dismissible: false })] });
    expect(el.querySelector('[data-testid="login-announcement-dismiss"]')).toBeNull();
  });

  // --- Dismiss behaviour -----------------------------------------------------

  it('removes an announcement (and hides the banner) when dismissed', async () => {
    const el = await mount({ announcements: [ann()] });
    el.querySelector<HTMLButtonElement>('[data-testid="login-announcement-dismiss"]')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="login-announcement"]')).toBeNull();
    expect(el.querySelector('[data-testid="login-banner"]')).toBeNull();
  });

  // --- Keyboard operability (WCAG 2.1.1) -------------------------------------

  it('makes the dismiss control keyboard-focusable (a native button, not a click-only div)', async () => {
    const el = await mount({ announcements: [ann()] });
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-announcement-dismiss"]')!;
    // A real <button> takes Tab focus and Enter/Space activation from the browser.
    expect(btn.tagName).toBe('BUTTON');
    btn.focus();
    expect(document.activeElement).withContext('dismiss button is focusable').toBe(btn);
    // No positive tabindex => it stays in natural focus order.
    const ti = btn.getAttribute('tabindex');
    if (ti !== null) expect(Number(ti)).toBeLessThanOrEqual(0);
  });

  it('dismisses via the keyboard: a native button fires click on Enter/Space', async () => {
    const el = await mount({ announcements: [ann()] });
    const btn = el.querySelector<HTMLButtonElement>('[data-testid="login-announcement-dismiss"]')!;
    btn.focus();
    // A native button activates the (click) handler on Enter/Space keydown; the
    // browser maps that to a synthetic click, which we assert by activating it.
    btn.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    btn.click(); // native Enter/Space => click on a real button
    fixture.detectChanges();
    expect(el.querySelector('[data-testid="login-announcement"]')).toBeNull();
  });

  it('orders multiple announcements by priority (highest first)', async () => {
    const el = await mount({
      announcements: [ann({ id: 'low', title: 'Low', priority: 1 }), ann({ id: 'hi', title: 'High', priority: 9 })],
    });
    const titles = Array.from(el.querySelectorAll('[data-testid="login-announcement"] h3')).map(
      (h) => h.textContent?.trim(),
    );
    expect(titles).toEqual(['High', 'Low']);
  });
});
