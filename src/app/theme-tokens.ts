/**
 * READING the runtime theme instead of re-declaring it.
 *
 * The mesh's login theme is delivered as CSS text: `docker-entrypoint.d/50-snap-theme.sh`
 * writes `snap-theme.css` from `$SNAP_THEME_CSS` at container start and index.html
 * <link>s it, so a rebrand is an env change + restart with NO image rebuild (the
 * derivation itself lives in hugmesh-generator `studio/hugmesh_studio/core/theme.py`
 * — this repo does ZERO colour maths, exactly as the entrypoint does none).
 *
 * The animated login background needs those same colours as NUMBERS (WebGL wants
 * 0xRRGGBB), and the one thing it must never do is carry its own copy of the
 * palette: a second palette is a second implementation, and the moment the operator
 * picks a pride preset the background would still be showing the shipped brand —
 * the exact "my theme choices are not applied" failure this system has already been
 * burned by twice (see the theme rollout notes: the `--sd-` vs `--hug-` prefix bug made
 * the served theme a silent no-op for the feature's whole life).
 *
 * So the palette is READ OUT OF CSS at runtime, from the very custom properties the
 * theme sets. Any mechanism that changes those properties — the injected
 * stylesheet, a `:root` inline style, a future in-page theme switcher — restyles the
 * background for free.
 *
 * WHY hex parsing is enough: `getPropertyValue` on a custom property returns the
 * token's RAW text, not a computed colour, and theme.py's `css_root` REFUSES to emit
 * a non-literal (`token ... is not a literal` on any `var(` in a value). So every
 * value that can legitimately arrive here is a literal `#rrggbb`. `rgb()/rgba()` are
 * parsed too because a hand-written override is plausible; anything else resolves to
 * the compiled fallback rather than to a wrong colour.
 */

/** The colour tokens the background actually consumes, already normalised to `#rrggbb`. */
export interface ThemePalette {
  /** Page backdrop — also the SCRIM colour, which is what keeps text legible. */
  readonly bg0: string;
  /** Card/panel surface. */
  readonly bg1: string;
  /** Body text; the contrast floor is measured against this. */
  readonly text: string;
  /** Brand primary. */
  readonly primary: string;
  /** Brand secondary (absent from the compiled fallback — themes supply it). */
  readonly secondary: string;
  /** Accent (links/focus); the theme derives it from the operator's secondary. */
  readonly accent: string;
  /** Accent tuned for TEXT contrast — WCAG-derived by theme.py, light or dark ramp. */
  readonly accentSoft: string;
}

/**
 * The compiled shipped brand, byte-identical to the `:root` block in styles.scss.
 *
 * Used per-token, not all-or-nothing: an unbranded deploy serves a ZERO-BYTE
 * snap-theme.css (by design), and a theme that only sets some tokens must still get
 * a complete palette rather than a half-black one.
 */
export const FALLBACK_PALETTE: ThemePalette = {
  bg0: '#0a0a12',
  bg1: '#12121e',
  text: '#e8e8f0',
  primary: '#ffd700',
  secondary: '#7c4dff',
  accent: '#7c4dff',
  accentSoft: '#b388ff',
};

/** Custom property backing each palette slot, in the order they are tried. */
const TOKEN_SOURCES: ReadonlyArray<readonly [keyof ThemePalette, readonly string[]]> = [
  ['bg0', ['--hug-bg-0']],
  ['bg1', ['--hug-bg-1']],
  ['text', ['--hug-text']],
  ['primary', ['--hug-primary']],
  // --hug-secondary exists only once a theme is injected (styles.scss compiles no
  // fallback for it), so it falls back to the accent — which IS what theme.py
  // derives the accent from, keeping a one-colour brand coherent instead of
  // pairing the operator's primary with a stale purple.
  ['secondary', ['--hug-secondary', '--hug-accent']],
  ['accent', ['--hug-accent']],
  ['accentSoft', ['--hug-accent-soft']],
];

const HEX_RE = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const RGB_RE = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i;

const clampByte = (n: number): number => Math.max(0, Math.min(255, Math.round(n)));
const hex2 = (n: number): string => clampByte(n).toString(16).padStart(2, '0');

/**
 * Normalise one authored colour to `#rrggbb`, or null when it is not a colour this
 * module can read. Alpha is DROPPED deliberately: the background composites through
 * one known scrim alpha (see BACKGROUND_SCRIM_ALPHA), and a token that smuggled a
 * second alpha in would silently break the contrast floor that scrim guarantees.
 */
export function normalizeHex(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  if (!value) return null;

  if (HEX_RE.test(value)) {
    const body = value.slice(1);
    if (body.length <= 4) {
      // #rgb / #rgba — expand each nibble, drop alpha.
      return '#' + [0, 1, 2].map((i) => body[i] + body[i]).join('').toLowerCase();
    }
    return ('#' + body.slice(0, 6)).toLowerCase();
  }

  const rgb = RGB_RE.exec(value);
  if (rgb) {
    return ('#' + hex2(Number(rgb[1])) + hex2(Number(rgb[2])) + hex2(Number(rgb[3]))).toLowerCase();
  }
  return null;
}

/** `#rrggbb` -> the 0xRRGGBB integer WebGL/Vanta option values are expressed in. */
export function hexToInt(hex: string): number {
  const normalized = normalizeHex(hex) ?? '#000000';
  return parseInt(normalized.slice(1), 16);
}

/** The three channels of a normalised hex as 0..255 numbers. */
function channels(hex: string): [number, number, number] {
  const n = hexToInt(hex);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

/**
 * Read the live palette out of the document. `root` defaults to `<html>`, which is
 * where BOTH the compiled `:root` fallbacks and the injected `:root:root` theme land.
 */
export function readThemePalette(root?: Element | null): ThemePalette {
  const target = root ?? (typeof document === 'undefined' ? null : document.documentElement);
  if (!target || typeof getComputedStyle !== 'function') return FALLBACK_PALETTE;

  const style = getComputedStyle(target);
  const out: Record<string, string> = { ...FALLBACK_PALETTE };
  for (const [slot, tokens] of TOKEN_SOURCES) {
    for (const token of tokens) {
      const parsed = normalizeHex(style.getPropertyValue(token));
      if (parsed) {
        out[slot] = parsed;
        break;
      }
    }
  }
  return out as unknown as ThemePalette;
}

/**
 * A cheap value identity for a palette, so a theme WATCHER can ignore the mutations
 * that changed nothing. Theme observation is deliberately broad (any stylesheet or
 * attribute mutation could have re-themed the page), so the vast majority of
 * notifications resolve to the same palette and must cost nothing downstream.
 */
export function paletteFingerprint(palette: ThemePalette): string {
  return [
    palette.bg0,
    palette.bg1,
    palette.text,
    palette.primary,
    palette.secondary,
    palette.accent,
    palette.accentSoft,
  ].join('|');
}

/** WCAG 2.x relative luminance of a normalised hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = channels(hex).map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio between two opaque colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Source-over composite of `top` at `alpha` onto `bottom`, as `#rrggbb`.
 *
 * This is the arithmetic the SCRIM performs in the browser, reproduced here so the
 * legibility floor can be ASSERTED in a unit test instead of eyeballed: whatever the
 * animation renders underneath, the user sees this composite.
 */
export function compositeOver(top: string, bottom: string, alpha: number): string {
  const a = Math.max(0, Math.min(1, alpha));
  const [tr, tg, tb] = channels(top);
  const [br, bg, bb] = channels(bottom);
  return (
    '#' +
    hex2(tr * a + br * (1 - a)) +
    hex2(tg * a + bg * (1 - a)) +
    hex2(tb * a + bb * (1 - a))
  );
}
