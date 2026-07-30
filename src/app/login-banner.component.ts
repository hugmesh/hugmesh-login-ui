import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { PublicAnnouncementsService } from './public-announcements.service';
import {
  Announcement,
  activeLoginAnnouncements,
  buildAnnouncementDoc,
} from './announcement.types';

/**
 * Public LOGIN-page announcement banner. Renders the active, login-targeted
 * announcements (from the UNAUTHENTICATED `GET /bff/public/announcements/login`
 * feed) at the TOP of the login page for ALL visitors — anonymous included, no
 * token. Renders NOTHING unless at least one active login announcement exists.
 *
 * SANDBOXING (security-critical) — two walls (see {@link buildAnnouncementDoc}):
 *
 *   1. `body_html` is admin HTML already SANITISED server-side (jsoup Safelist)
 *      before it was persisted. We NEVER assign it to innerHTML.
 *   2. It is rendered ONLY inside a `<iframe sandbox>` whose token list carries
 *      NO `allow-scripts` and NO `allow-same-origin`: the frame is a unique,
 *      opaque (null) origin with scripting OFF, so even a server-side sanitiser
 *      miss cannot execute JS or reach the host DOM / cookies / storage.
 *
 * a11y: a labelled `role="region"` with `aria-live="polite"` (the banner appears
 * after an async fetch, so screen readers are notified non-disruptively); each
 * dismissible announcement has a keyboard-operable close button.
 */
@Component({
  selector: 'hug-login-banner',
  standalone: true,
  imports: [CommonModule],
  templateUrl: './login-banner.component.html',
  styleUrl: './login-banner.component.scss',
})
export class LoginBannerComponent implements OnInit {
  private readonly feed = inject(PublicAnnouncementsService);
  private readonly sanitizer = inject(DomSanitizer);

  /** Raw active login announcements (post server + client filtering). */
  private readonly all = signal<Announcement[]>([]);
  /** Ids the visitor dismissed this session (kept in-memory only). */
  private readonly dismissed = signal<ReadonlySet<string>>(new Set());

  /** The announcements to render — active, not dismissed. */
  readonly announcements = computed(() =>
    this.all().filter((a) => !this.dismissed().has(a.id)),
  );
  readonly hasAnnouncements = computed(() => this.announcements().length > 0);

  async ngOnInit(): Promise<void> {
    const feed = await this.feed.login();
    this.all.set(activeLoginAnnouncements(feed));
  }

  /**
   * The sandboxed iframe `srcdoc` for one announcement. Bound through
   * bypassSecurityTrustHtml ONLY because Angular otherwise strips `srcdoc`; the
   * content is already neutralised (server-sanitised + no script) and the iframe
   * sandbox is the hard wall regardless.
   */
  doc(a: Announcement): SafeHtml {
    return this.sanitizer.bypassSecurityTrustHtml(buildAnnouncementDoc(a.body_html));
  }

  /**
   * The accessible name of an announcement's dismiss button. Lives here rather
   * than as `'Dismiss announcement: ' + a.title` in the template because an
   * `i18n-` attribute cannot localize a template EXPRESSION — a concatenation in
   * the binding is invisible to the extractor and would have shipped as
   * permanently-English text glued to a translated page. Both accessible names
   * below were exactly that, and are the reason this component has methods at all.
   */
  dismissLabel(a: Announcement): string {
    return $localize`:Accessible name of an announcement's dismiss button. {{PLACEHOLDER}} is the announcement title@@banner.dismiss.label:Dismiss announcement: ${a.title}:title:`;
  }

  /** The accessible title of the sandboxed announcement iframe (see above). */
  frameTitle(a: Announcement): string {
    return $localize`:Accessible title of the announcement body frame. {{PLACEHOLDER}} is the announcement title@@banner.frame.title:Announcement: ${a.title}:title:`;
  }

  dismiss(id: string): void {
    this.dismissed.update((s) => new Set(s).add(id));
  }

  /** Stable identity for the @for list. */
  trackById = (_: number, a: Announcement) => a.id;
}
