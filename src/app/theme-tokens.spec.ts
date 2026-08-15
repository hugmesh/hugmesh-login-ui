import {
  FALLBACK_PALETTE,
  compositeOver,
  contrastRatio,
  hexToInt,
  normalizeHex,
  paletteFingerprint,
  readThemePalette,
  relativeLuminance,
} from './theme-tokens';

/**
 * These specs guard the SEAM between the injected theme and the animated
 * background. The whole feature's claim is "the background follows the theme
 * because it reads the theme's own tokens" — so the reader is where that claim
 * either holds or silently stops holding, exactly as the --sd-/--hug- prefix bug
 * once stopped the whole theme from applying without anything failing.
 */
describe('theme-tokens', () => {
  describe('normalizeHex', () => {
    it('passes through the #rrggbb literals theme.py emits', () => {
      expect(normalizeHex('#7c4dff')).toBe('#7c4dff');
      // Tokens arrive with the whitespace of the authored CSS attached.
      expect(normalizeHex('  #FFD700 ')).toBe('#ffd700');
    });

    it('expands shorthand hex', () => {
      expect(normalizeHex('#abc')).toBe('#aabbcc');
    });

    it('drops alpha rather than smuggling a second transparency past the scrim', () => {
      expect(normalizeHex('#aabbcc80')).toBe('#aabbcc');
      expect(normalizeHex('rgba(255, 215, 0, 0.5)')).toBe('#ffd700');
    });

    it('reads rgb()/rgba() for hand-written overrides', () => {
      expect(normalizeHex('rgb(255, 215, 0)')).toBe('#ffd700');
      expect(normalizeHex('rgb(10 10 18)')).toBe('#0a0a12');
    });

    it('returns null for anything it cannot read, so the caller falls back', () => {
      expect(normalizeHex('rebeccapurple')).toBeNull();
      expect(normalizeHex('var(--something)')).toBeNull();
      expect(normalizeHex('')).toBeNull();
      expect(normalizeHex(null)).toBeNull();
      expect(normalizeHex(undefined)).toBeNull();
    });
  });

  describe('hexToInt', () => {
    it('produces the 0xRRGGBB integer WebGL options are expressed in', () => {
      expect(hexToInt('#7c4dff')).toBe(0x7c4dff);
      expect(hexToInt('#000000')).toBe(0);
      expect(hexToInt('#ffffff')).toBe(0xffffff);
    });
  });

  describe('readThemePalette', () => {
    let root: HTMLElement;

    beforeEach(() => {
      root = document.createElement('div');
      document.body.appendChild(root);
    });

    afterEach(() => root.remove());

    it('reads the --hug-* tokens the runtime theme sets', () => {
      root.style.setProperty('--hug-bg-0', '#101020');
      root.style.setProperty('--hug-primary', '#ff5588');
      root.style.setProperty('--hug-accent', '#22ddaa');

      const palette = readThemePalette(root);
      expect(palette.bg0).toBe('#101020');
      expect(palette.primary).toBe('#ff5588');
      expect(palette.accent).toBe('#22ddaa');
    });

    it('falls back PER TOKEN, so a partial theme still yields a whole palette', () => {
      root.style.setProperty('--hug-primary', '#ff5588');

      const palette = readThemePalette(root);
      expect(palette.primary).toBe('#ff5588');
      expect(palette.bg0).toBe(FALLBACK_PALETTE.bg0);
      expect(palette.text).toBe(FALLBACK_PALETTE.text);
    });

    it('resolves secondary from the accent when only the accent is themed', () => {
      // styles.scss compiles no --hug-secondary fallback; a one-colour brand must
      // still pair coherently instead of pulling in the shipped purple.
      root.style.setProperty('--hug-accent', '#22ddaa');
      expect(readThemePalette(root).secondary).toBe('#22ddaa');
    });

    it('prefers an explicit --hug-secondary over the accent', () => {
      root.style.setProperty('--hug-accent', '#22ddaa');
      root.style.setProperty('--hug-secondary', '#4455ff');
      expect(readThemePalette(root).secondary).toBe('#4455ff');
    });
  });

  describe('paletteFingerprint', () => {
    it('is equal for equal palettes, so no-op mutations cost nothing downstream', () => {
      expect(paletteFingerprint(FALLBACK_PALETTE)).toBe(paletteFingerprint({ ...FALLBACK_PALETTE }));
    });

    it('changes when any single token changes', () => {
      const themed = { ...FALLBACK_PALETTE, accentSoft: '#123456' };
      expect(paletteFingerprint(themed)).not.toBe(paletteFingerprint(FALLBACK_PALETTE));
    });
  });

  describe('WCAG maths', () => {
    it('matches the reference luminance endpoints', () => {
      expect(relativeLuminance('#000000')).toBeCloseTo(0, 5);
      expect(relativeLuminance('#ffffff')).toBeCloseTo(1, 5);
    });

    it('gives 21:1 for black on white and 1:1 for a colour on itself', () => {
      expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 2);
      expect(contrastRatio('#7c4dff', '#7c4dff')).toBeCloseTo(1, 5);
    });

    it('agrees with an independent reference computation of the shipped palette', () => {
      // --hug-text on --hug-bg-0, the pair this feature's legibility floor is
      // measured against. Values verified against a separate implementation of the
      // WCAG formula rather than against the ratios written into styles.scss's
      // comments, which are rounded a little low (15.9 / 8.77) — this arithmetic is
      // the thing under test, so it may not be pinned to prose.
      expect(contrastRatio('#e8e8f0', '#0a0a12')).toBeCloseTo(16.18, 2);
      expect(contrastRatio('#a8acc4', '#0a0a12')).toBeCloseTo(8.79, 2);
    });
  });

  describe('compositeOver', () => {
    it('is the identity at alpha 1 and a no-op at alpha 0', () => {
      expect(compositeOver('#ffffff', '#000000', 1)).toBe('#ffffff');
      expect(compositeOver('#ffffff', '#000000', 0)).toBe('#000000');
    });

    it('blends channel-wise, matching what the browser paints for the scrim', () => {
      // 0.5 * 255 + 0.5 * 0 = 127.5 -> 128 (#80) on every channel.
      expect(compositeOver('#ffffff', '#000000', 0.5)).toBe('#808080');
    });
  });
});
