import { resolveLocale, SOURCE_LOCALE } from './locale';
import { localeGuard } from './locale.guard';
import { SHIPPED_LOCALES } from './shipped-locales';

/**
 * Locale RESOLUTION is pure and fully testable without a browser; the catalog
 * FETCH is proven end to end by the build (tools/i18n) and by the pseudo-locale.
 *
 * `resolveLocale` takes the shipped set as a parameter precisely so these specs
 * can pin it — asserting against the generated {@link SHIPPED_LOCALES} would make
 * the suite depend on whatever `SNAP_WEB_LOCALES` the last build happened to set.
 */
describe('resolveLocale', () => {
  it('returns English when the build shipped no catalogs (the default)', () => {
    // The zero-config path: web_locales=() must never even consider a fetch.
    expect(resolveLocale([])).toBe(SOURCE_LOCALE);
  });

  it('never returns a locale the build did not ship', () => {
    // Requesting a catalog that was never emitted is a guaranteed 404 and, on an
    // air-gapped mesh, a pointless request. Resolution is closed over the set.
    expect(resolveLocale(['de'])).toMatch(/^(de|en)$/);
    expect(['de', 'en']).toContain(resolveLocale(['de']));
  });

  it('matches a shipped locale exactly, case-insensitively', () => {
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['DE']);
    expect(resolveLocale(['de'])).toBe('de');
  });

  it('falls back to the primary subtag so de-AT gets the de catalog', () => {
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['de-AT']);
    expect(resolveLocale(['de'])).toBe('de');
  });

  it('falls back to English when nothing the browser wants was shipped', () => {
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['fr-CA', 'fr']);
    expect(resolveLocale(['de'])).toBe(SOURCE_LOCALE);
  });

  it('prefers the first browser language that IS shipped over an earlier one that is not', () => {
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['fr', 'de']);
    expect(resolveLocale(['de'])).toBe('de');
  });

  it('lets a stored preference win over the browser language', () => {
    localStorage.setItem('snap.login.lang', 'de');
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['fr']);
    try {
      expect(resolveLocale(['de'])).toBe('de');
    } finally {
      localStorage.removeItem('snap.login.lang');
    }
  });

  it('ignores a stored preference that was never shipped', () => {
    localStorage.setItem('snap.login.lang', 'fr');
    spyOnProperty(navigator, 'languages', 'get').and.returnValue(['de']);
    try {
      expect(resolveLocale(['de'])).toBe('de');
    } finally {
      localStorage.removeItem('snap.login.lang');
    }
  });
});

describe('SHIPPED_LOCALES (generated)', () => {
  it('never contains the source locale — English has no catalog', () => {
    expect(SHIPPED_LOCALES).not.toContain('en');
  });
});

describe('localeGuard', () => {
  it('always allows the route through', async () => {
    // A translation catalog must NEVER be able to lock a user out of login. The
    // guard is a load hook, not an authorization gate.
    expect(await localeGuard({} as never, [], {} as never)).toBe(true);
  });

  it('allows the route through even when the catalog fetch fails outright', async () => {
    spyOn(window, 'fetch').and.rejectWith(new Error('network down'));
    expect(await localeGuard({} as never, [], {} as never)).toBe(true);
  });
});
