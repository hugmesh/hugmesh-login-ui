import {
  BACKGROUND_EFFECT_IDS,
  BACKGROUND_PRESET_IDS,
  BACKGROUND_SCRIM_ALPHA,
  DEFAULT_BACKGROUND_PRESET,
  extractCssUrl,
  isBackgroundEffect,
  parseBackgroundPreset,
  resolveBackgroundPreset,
  safeBackgroundImageUrl,
  vantaOptionsFor,
  worstCaseTextContrast,
} from './background.types';
import { FALLBACK_PALETTE, ThemePalette, hexToInt } from './theme-tokens';

/** A light-ramp palette of the shape theme_presets.py emits for `mode="light"`. */
const LIGHT_PALETTE: ThemePalette = {
  bg0: '#f7f7fb',
  bg1: '#ffffff',
  text: '#1a1a2e',
  primary: '#b8860b',
  secondary: '#5a2ea6',
  accent: '#5a2ea6',
  accentSoft: '#3d1f70',
};

/** A pride-preset-shaped palette: saturated primary + secondary, dark ramp. */
const FLAG_PALETTE: ThemePalette = {
  bg0: '#0a0a12',
  bg1: '#12121e',
  text: '#e8e8f0',
  primary: '#e40303',
  secondary: '#ff8c00',
  accent: '#008026',
  accentSoft: '#61cf6b',
};

describe('background.types', () => {
  describe('parseBackgroundPreset', () => {
    it('accepts every shipped id', () => {
      for (const id of BACKGROUND_PRESET_IDS) {
        expect(parseBackgroundPreset(id)).toBe(id);
      }
    });

    it('is tolerant of the case and whitespace an env var arrives with', () => {
      expect(parseBackgroundPreset('  FOG ')).toBe('fog');
    });

    it('returns null (never throws) for junk from outside the build', () => {
      // SNAP_BG_EFFECT is operator-typed; a typo must land on the default
      // background, not on an exception while the front door is booting.
      expect(parseBackgroundPreset('waaves')).toBeNull();
      expect(parseBackgroundPreset('')).toBeNull();
      expect(parseBackgroundPreset(undefined)).toBeNull();
      expect(parseBackgroundPreset(42)).toBeNull();
      expect(parseBackgroundPreset({ id: 'fog' })).toBeNull();
    });
  });

  describe('resolveBackgroundPreset', () => {
    it('collapses image-without-a-file to the themed gradient', () => {
      expect(resolveBackgroundPreset('image', false)).toBe('static');
    });

    it('honours image when a file is configured, and leaves everything else alone', () => {
      expect(resolveBackgroundPreset('image', true)).toBe('image');
      expect(resolveBackgroundPreset('fog', false)).toBe('fog');
      expect(resolveBackgroundPreset('static', true)).toBe('static');
    });
  });

  describe('isBackgroundEffect', () => {
    it('separates the animated presets from the still ones', () => {
      expect(isBackgroundEffect('fog')).toBeTrue();
      expect(isBackgroundEffect('globe')).toBeTrue();
      expect(isBackgroundEffect('static')).toBeFalse();
      expect(isBackgroundEffect('image')).toBeFalse();
    });

    it('agrees with the default preset being animated', () => {
      expect(isBackgroundEffect(DEFAULT_BACKGROUND_PRESET)).toBeTrue();
    });
  });

  describe('vantaOptionsFor', () => {
    it('derives EVERY colour from the palette — no literal survives', () => {
      const themed: ThemePalette = { ...FALLBACK_PALETTE, primary: '#ff0000', accent: '#00ff00' };
      const options = vantaOptionsFor('fog', themed);
      expect(options['highlightColor']).toBe(hexToInt('#ff0000'));
      expect(options['lowlightColor']).toBe(hexToInt('#00ff00'));
      expect(options['baseColor']).toBe(hexToInt(themed.bg0));
    });

    it('yields DIFFERENT colour options for a different theme, for every effect', () => {
      // This is the property that makes a preset switch (pride flags included)
      // visible in the background instead of a silent no-op.
      for (const id of BACKGROUND_EFFECT_IDS) {
        const shipped = JSON.stringify(vantaOptionsFor(id, FALLBACK_PALETTE));
        const flag = JSON.stringify(vantaOptionsFor(id, FLAG_PALETTE));
        expect(flag).withContext(`effect ${id} follows the theme`).not.toEqual(shipped);
      }
    });

    it('leaves touch and gyro listeners off on every effect', () => {
      for (const id of BACKGROUND_EFFECT_IDS) {
        const options = vantaOptionsFor(id, FALLBACK_PALETTE);
        expect(options['touchControls']).withContext(`effect ${id}`).toBeFalse();
        expect(options['gyroControls']).withContext(`effect ${id}`).toBeFalse();
      }
    });

    it('emits plain numbers/booleans only, which is all Vanta options may be', () => {
      for (const id of BACKGROUND_EFFECT_IDS) {
        for (const [key, value] of Object.entries(vantaOptionsFor(id, FALLBACK_PALETTE))) {
          expect(['number', 'boolean'])
            .withContext(`${id}.${key} is ${typeof value}`)
            .toContain(typeof value);
        }
      }
    });
  });

  describe('legibility floor', () => {
    /**
     * The a11y claim under test: text stays readable over the background in EVERY
     * preset. It is asserted as a bound rather than per-effect, because the scrim is
     * what enforces it — the worst case is an effect painting pure white (or pure
     * black) edge to edge, which no shipped preset actually does.
     */
    it('keeps --hug-text at AA (>= 4.5:1) against the worst frame any effect could paint', () => {
      for (const palette of [FALLBACK_PALETTE, LIGHT_PALETTE, FLAG_PALETTE]) {
        expect(worstCaseTextContrast(palette))
          .withContext(`worst-case contrast for bg0 ${palette.bg0}`)
          .toBeGreaterThanOrEqual(4.5);
      }
    });

    it('holds a comfortable margin above AA on the shipped dark brand', () => {
      // Measured 6.68:1 at the shipped alpha — and that is the WORST case, an effect
      // painting pure white across the whole viewport, which none of the four
      // actually does. Pinned so a future scrim tweak has to face the number.
      expect(worstCaseTextContrast(FALLBACK_PALETTE)).toBeGreaterThanOrEqual(6.5);
    });

    it('would FAIL without the scrim — the floor comes from the scrim, not from luck', () => {
      // Sanity-check the test itself: at alpha 0 the text sits on raw white/black.
      expect(worstCaseTextContrast(FALLBACK_PALETTE, 0)).toBeLessThan(4.5);
    });

    it('holds at the alpha the stylesheet actually paints', () => {
      expect(BACKGROUND_SCRIM_ALPHA).toBeGreaterThan(0);
      expect(BACKGROUND_SCRIM_ALPHA).toBeLessThanOrEqual(1);
    });
  });

  describe('safeBackgroundImageUrl', () => {
    it('accepts an https URL, a relative path and a root-relative path', () => {
      expect(safeBackgroundImageUrl('https://cdn.example.net/brand/login.jpg')).toBe(
        'https://cdn.example.net/brand/login.jpg',
      );
      expect(safeBackgroundImageUrl('brand-bg.jpg')).toBe('brand-bg.jpg');
      expect(safeBackgroundImageUrl('/login/brand-bg.png')).toBe('/login/brand-bg.png');
    });

    it('accepts a base64 data: URI of a raster image', () => {
      const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==';
      expect(safeBackgroundImageUrl(png)).toBe(png);
    });

    it('REJECTS an inline SVG, which is a document that can carry script', () => {
      // The data: form is where operator-supplied ART would ride (the theme
      // pipeline already embeds uploaded fonts this way), so it is exactly the
      // shape the avatar path refuses for SVG — and it is refused here too.
      expect(safeBackgroundImageUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
      expect(safeBackgroundImageUrl('data:image/svg+xml,<svg/>')).toBeNull();
    });

    it('REJECTS script and non-image schemes', () => {
      expect(safeBackgroundImageUrl('javascript:alert(1)')).toBeNull();
      expect(safeBackgroundImageUrl('data:text/html;base64,PGh0bWw+')).toBeNull();
      expect(safeBackgroundImageUrl('file:///etc/passwd')).toBeNull();
    });

    it('REJECTS http: (a mixed-content downgrade on an HTTPS login page)', () => {
      expect(safeBackgroundImageUrl('http://example.net/bg.jpg')).toBeNull();
    });

    it('REJECTS a protocol-relative URL wearing a relative path’s clothes', () => {
      expect(safeBackgroundImageUrl('//evil.example/bg.png')).toBeNull();
    });

    it('REJECTS every CSS url() breakout character', () => {
      // These are what would let a poisoned env var close the url() and append its
      // own declarations.
      expect(safeBackgroundImageUrl('bg.png") ; background: red; content: url("')).toBeNull();
      expect(safeBackgroundImageUrl("bg.png') url('x")).toBeNull();
      expect(safeBackgroundImageUrl('bg(1).png')).toBeNull();
      expect(safeBackgroundImageUrl('bg .png')).toBeNull();
      expect(safeBackgroundImageUrl('bg\n.png')).toBeNull();
      expect(safeBackgroundImageUrl('bg\\.png')).toBeNull();
    });

    it('REJECTS non-strings and absurd lengths', () => {
      expect(safeBackgroundImageUrl(undefined)).toBeNull();
      expect(safeBackgroundImageUrl(null)).toBeNull();
      expect(safeBackgroundImageUrl(7)).toBeNull();
      expect(safeBackgroundImageUrl('')).toBeNull();
      expect(safeBackgroundImageUrl('a'.repeat(9000))).toBeNull();
    });
  });

  describe('extractCssUrl', () => {
    it('reads the url out of a theme token, quoted or bare', () => {
      expect(extractCssUrl('url("brand.png")')).toBe('brand.png');
      expect(extractCssUrl("url('brand.png')")).toBe('brand.png');
      expect(extractCssUrl('  url(brand.png)  ')).toBe('brand.png');
    });

    it('returns null for an unset property and for anything that is not a url()', () => {
      expect(extractCssUrl('')).toBeNull();
      expect(extractCssUrl('none')).toBeNull();
      expect(extractCssUrl(null)).toBeNull();
      expect(extractCssUrl('linear-gradient(red, blue)')).toBeNull();
    });

    it('hands its result to the same allowlist, so the token path is not a bypass', () => {
      const extracted = extractCssUrl('url("javascript:alert(1)")');
      expect(extracted).toBe('javascript:alert(1)');
      expect(safeBackgroundImageUrl(extracted)).toBeNull();
    });
  });
});
