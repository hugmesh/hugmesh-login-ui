import {
  Announcement,
  activeLoginAnnouncements,
  buildAnnouncementDoc,
  isActive,
} from './announcement.types';

/** A fully-populated, currently-active login announcement to vary per test. */
function ann(over: Partial<Announcement> = {}): Announcement {
  return {
    id: 'a1',
    title: 'Heads up',
    body_html: '<p>hello</p>',
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

const NOW = Date.parse('2026-06-09T12:00:00Z');

describe('announcement.types', () => {
  describe('isActive', () => {
    it('is active when published, login-targeted and within an open window', () => {
      expect(isActive(ann(), NOW)).toBeTrue();
    });

    it('is inactive when not published (draft / archived)', () => {
      expect(isActive(ann({ state: 'draft' }), NOW)).toBeFalse();
      expect(isActive(ann({ state: 'archived' }), NOW)).toBeFalse();
    });

    it('is inactive when the login target flag is false', () => {
      expect(isActive(ann({ target_login: false }), NOW)).toBeFalse();
    });

    it('is inactive before starts_at and after ends_at', () => {
      expect(isActive(ann({ starts_at: '2026-06-10T00:00:00Z' }), NOW)).toBeFalse();
      expect(isActive(ann({ ends_at: '2026-06-08T00:00:00Z' }), NOW)).toBeFalse();
    });

    it('honours an explicit in-window [starts_at, ends_at]', () => {
      const a = ann({ starts_at: '2026-06-01T00:00:00Z', ends_at: '2026-06-30T00:00:00Z' });
      expect(isActive(a, NOW)).toBeTrue();
    });
  });

  describe('activeLoginAnnouncements', () => {
    it('keeps only active rows and sorts by priority desc then created desc', () => {
      const feed = {
        announcements: [
          ann({ id: 'low', priority: 1 }),
          ann({ id: 'draft', state: 'draft', priority: 99 }),
          ann({ id: 'high', priority: 5 }),
          ann({ id: 'not-login', target_login: false, priority: 99 }),
          ann({ id: 'mid-old', priority: 5, created_at: '2025-01-01T00:00:00Z' }),
        ],
      };
      const out = activeLoginAnnouncements(feed, NOW).map((a) => a.id);
      expect(out).toEqual(['high', 'mid-old', 'low']);
    });

    it('is defensive against null / non-array payloads', () => {
      expect(activeLoginAnnouncements(null, NOW)).toEqual([]);
      expect(activeLoginAnnouncements({ announcements: undefined as any }, NOW)).toEqual([]);
    });
  });

  describe('buildAnnouncementDoc', () => {
    it('wraps the body in a self-contained, script-free document', () => {
      const doc = buildAnnouncementDoc('<p>hi <a href="https://x">x</a></p>');
      expect(doc).toContain('<!doctype html>');
      expect(doc).toContain('<div class="announcement"><p>hi <a href="https://x">x</a></p></div>');
      expect(doc.toLowerCase()).not.toContain('<script');
    });

    it('tolerates an empty / nullish body', () => {
      expect(buildAnnouncementDoc('')).toContain('<div class="announcement"></div>');
      expect(buildAnnouncementDoc(undefined as any)).toContain('<div class="announcement"></div>');
    });
  });
});
