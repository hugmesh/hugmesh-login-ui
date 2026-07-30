/**
 * Pure, framework-free announcement model + active-window filter + sandboxed
 * iframe-document builder for the public LOGIN banner (see
 * {@link LoginBannerComponent}). Kept as a standalone module (no Angular deps)
 * so the active-window logic and the dangerous-`body_html`→`srcdoc` builder are
 * unit-testable in isolation.
 *
 * SHARED CONTRACT. The shape mirrors the admin-bff `Announcement` record
 * (snake_case JSON) served by `GET /bff/public/announcements/login` — the
 * UNAUTHENTICATED public login feed. The BFF already returns only the
 * login-targeted, published, in-window rows; the {@link isActive} filter here is
 * defence-in-depth so a stale/over-broad payload can never surface a draft,
 * archived, expired, not-yet-started, or non-login announcement on the page.
 *
 * SECURITY MODEL — DEFENCE IN DEPTH. `body_html` is admin-authored HTML rendered
 * to ANONYMOUS login-page visitors. It was SANITISED server-side (jsoup Safelist)
 * at create/update before persistence; here it is rendered ONLY inside an
 * `<iframe sandbox>` whose token list carries NEITHER `allow-scripts` NOR
 * `allow-same-origin`, so the framed document runs in a unique, opaque origin
 * with scripting disabled — it can neither execute JS nor reach the host DOM,
 * cookies, or storage. We NEVER assign `body_html` to `innerHTML`. The
 * server-side sanitiser is the first wall; the sandboxed iframe is the second,
 * hard wall — a bypass of one is still contained by the other.
 */

/** One announcement as served by the public login feed (snake_case JSON). */
export interface Announcement {
  id: string;
  title: string;
  /** Admin HTML, sanitised server-side. NEVER assigned to innerHTML — iframe only. */
  body_html: string;
  format: 'html' | 'wysiwyg';
  state: 'draft' | 'published' | 'archived';
  target_home: boolean;
  target_login: boolean;
  target_akkoma: boolean;
  target_forum: boolean;
  priority: number;
  /** null = active from now. */
  starts_at: string | null;
  /** null = open-ended. */
  ends_at: string | null;
  timezone: string;
  dismissible: boolean;
  created_at: string;
  updated_at: string;
}

/** The envelope returned by `GET /bff/public/announcements/login`. */
export interface AnnouncementFeed {
  announcements: Announcement[];
}

/**
 * ACTIVE on the login surface = published AND now within [starts_at, ends_at]
 * (null start = from now, null end = open) AND target_login. Mirrors the
 * server-side rule; applied client-side as defence-in-depth.
 */
export function isActive(a: Announcement, now: number = Date.now()): boolean {
  if (a.state !== 'published') return false;
  if (!a.target_login) return false;
  const starts = parseTime(a.starts_at);
  const ends = parseTime(a.ends_at);
  if (starts !== null && now < starts) return false;
  if (ends !== null && now > ends) return false;
  return true;
}

/**
 * The login-active announcements, highest priority first (priority is an int,
 * higher = more important), then most recently created. Defensive against a
 * non-array payload.
 */
export function activeLoginAnnouncements(
  feed: AnnouncementFeed | null | undefined,
  now: number = Date.now(),
): Announcement[] {
  const list = Array.isArray(feed?.announcements) ? feed!.announcements : [];
  return list
    .filter((a) => isActive(a, now))
    .sort((x, y) => y.priority - x.priority || parseTime(y.created_at)! - parseTime(x.created_at)!);
}

/** Parse an ISO instant to epoch ms, or null for null/empty/unparseable. */
function parseTime(value: string | null | undefined): number | null {
  if (!value) return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

/**
 * Build the full, self-contained document dropped into the banner iframe's
 * `srcdoc`. It contains ONLY a tiny reset + the (already server-sanitised)
 * `body_html` inside a `.announcement` wrapper. There is NO `<script>` anywhere
 * and the iframe runs script-disabled in a null origin, so even if the server
 * sanitiser missed something, this string can never act on the host.
 *
 * `prefers-color-scheme` is honoured so the framed announcement matches the dark
 * shell; the body is left transparent so it blends into the banner chrome.
 */
export function buildAnnouncementDoc(bodyHtml: string): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html, body { margin: 0; padding: 0; background: transparent; }
  .announcement {
    font-family: Arial, Helvetica, sans-serif;
    color: #e8e8f0;
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .announcement a { color: #b388ff; }
  .announcement :first-child { margin-top: 0; }
  .announcement :last-child { margin-bottom: 0; }
  @media (prefers-color-scheme: light) { .announcement { color: #1a1a2e; } }
</style></head>
<body><div class="announcement">${bodyHtml ?? ''}</div></body></html>`;
}
