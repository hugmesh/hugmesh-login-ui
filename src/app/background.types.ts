/**
 * The login BACKGROUND catalog: which presets exist, what Vanta options each one
 * derives from the live theme, and what an operator-supplied background file is
 * allowed to be.
 *
 * Pure data + pure functions on purpose — everything here is decided WITHOUT a DOM,
 * a WebGL context or a network fetch, so the interesting decisions (does a preset
 * stay legible? is this URL safe to paint?) are unit-testable rather than
 * "looks fine on my machine". {@link LoginBackgroundComponent} owns the effects.
 */
import {
  ThemePalette,
  compositeOver,
  contrastRatio,
  hexToInt,
} from './theme-tokens';

/**
 * The animated presets. This list is EMPIRICAL, not aspirational: every id here was
 * verified to actually render against the three.js revision this repo ships (see
 * README "Login background"). Vanta's `birds`, `dots` and friends were dropped
 * because they call three.js APIs removed years ago (`THREE.Geometry`,
 * `THREE.VertexColors`) — Vanta CATCHES that internally and silently falls back to a
 * flat colour, so shipping one would have looked like a working option and rendered
 * a dead rectangle.
 */
export type BackgroundEffectId = 'fog' | 'waves' | 'net' | 'globe';

/**
 * Every selectable background, animated or not.
 *   - `static` — the themed CSS gradient alone: no WebGL, no lazy chunk, no motion.
 *   - `image`  — an operator-supplied background file (see {@link safeBackgroundImageUrl}).
 */
export type BackgroundPresetId = BackgroundEffectId | 'static' | 'image';

export const BACKGROUND_EFFECT_IDS: readonly BackgroundEffectId[] = ['fog', 'waves', 'net', 'globe'];
export const BACKGROUND_PRESET_IDS: readonly BackgroundPresetId[] = [
  ...BACKGROUND_EFFECT_IDS,
  'static',
  'image',
];

/**
 * `fog` is the default because it is the closest thing in the catalog to what was
 * actually asked for — a slow animated GRADIENT — and because it is the only shipped
 * preset that is a single full-screen fragment shader: no geometry, no per-frame
 * scene graph, the cheapest of the four on a weak GPU.
 */
export const DEFAULT_BACKGROUND_PRESET: BackgroundPresetId = 'fog';

/**
 * Opacity of the scrim laid OVER the animation and UNDER the page content.
 *
 * This is the legibility mechanism, and it is structural rather than per-preset: the
 * scrim is painted in `--hug-bg-0`, the very colour every `--hug-text*` token was
 * derived to be readable against, so no matter what an effect renders the composite
 * the user reads text on is dragged back toward the themed background. That is why a
 * new preset cannot quietly break contrast, and why {@link worstCaseTextContrast}
 * can be asserted without knowing which effect is running.
 *
 * MUST match the `.hug-bg__scrim` opacity in login-background.component.scss — pinned
 * by a spec that reads the rendered element's computed style, not by this comment.
 */
export const BACKGROUND_SCRIM_ALPHA = 0.72;

/** Minimum accepted size of an operator background file, in CSS pixels. */
export const BACKGROUND_IMAGE_MIN_WIDTH = 320;
export const BACKGROUND_IMAGE_MIN_HEIGHT = 240;

/** Whether `id` names one of the animated (Vanta) presets. */
export function isBackgroundEffect(id: BackgroundPresetId): id is BackgroundEffectId {
  return (BACKGROUND_EFFECT_IDS as readonly string[]).includes(id);
}

/**
 * The preset that can actually be honoured.
 *
 * `image` without a configured file is the one combination that would render an
 * empty rectangle, so it collapses to the themed gradient — the same fallback every
 * other failure path in this feature lands on. Everything else is honoured as asked.
 */
export function resolveBackgroundPreset(
  requested: BackgroundPresetId,
  hasImage: boolean,
): BackgroundPresetId {
  return requested === 'image' && !hasImage ? 'static' : requested;
}

/**
 * Parse an operator- or visitor-supplied preset id, or null when it is not one.
 *
 * FAIL-SAFE, and deliberately so: this reads a value that arrives from an env var
 * (via snap-config.js) or from localStorage, i.e. from outside the build. A typo'd
 * `SNAP_BG_EFFECT=waaves` must land on the default background, never on an
 * exception thrown while the login page is booting.
 */
export function parseBackgroundPreset(raw: unknown): BackgroundPresetId | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  return (BACKGROUND_PRESET_IDS as readonly string[]).includes(value)
    ? (value as BackgroundPresetId)
    : null;
}

/** Options every effect shares. */
function commonOptions(): Record<string, number | boolean> {
  return {
    // Pointer parallax is a nice touch and costs nothing. TOUCH and GYRO are OFF:
    // both register non-passive window listeners that would compete with scrolling
    // and device motion on the phone that someone is trying to sign in from.
    mouseControls: true,
    touchControls: false,
    gyroControls: false,
    minHeight: 200,
    minWidth: 200,
    // Vanta's default scale of 2 (4 on mobile) renders at multiples of CSS pixels.
    // For a backdrop sitting under a 72% scrim that is invisible detail bought with
    // real GPU time, so both are pinned to 1.
    scale: 1,
    scaleMobile: 1,
  };
}

/**
 * The Vanta options for one effect, derived ENTIRELY from the live theme palette.
 *
 * Every colour is a `--hug-*` token read at runtime — there is no palette in this
 * file — which is what makes the background follow a preset change (pride flags
 * included) instead of needing its own copy of the brand. All four shipped effects
 * re-read their colour options inside Vanta's per-frame `onUpdate`, so pushing a new
 * palette through `setOptions()` restyles them LIVE, with no teardown and no reload.
 */
export function vantaOptionsFor(
  id: BackgroundEffectId,
  palette: ThemePalette,
): Record<string, number | boolean> {
  const base = commonOptions();
  switch (id) {
    case 'fog':
      // Fog reads as a slow gradient wash: the brand's three colours over the page
      // backdrop, so a rebrand is visible in the background within one frame.
      return {
        ...base,
        highlightColor: hexToInt(palette.primary),
        midtoneColor: hexToInt(palette.secondary),
        lowlightColor: hexToInt(palette.accent),
        baseColor: hexToInt(palette.bg0),
        blurFactor: 0.55,
        speed: 0.9,
        zoom: 0.9,
      };
    case 'waves':
      // A lit surface, so the colour wants to be the ACCENT (a mid-tone the theme
      // guarantees is distinct from both the backdrop and the text) rather than the
      // primary, which on the shipped brand is a near-white yellow.
      return {
        ...base,
        color: hexToInt(palette.accent),
        shininess: 30,
        waveHeight: 12,
        waveSpeed: 0.6,
        zoom: 0.85,
      };
    case 'net':
      // Points-and-lines: the one preset that literally draws a mesh, which is the
      // platform's own metaphor. Fewer points than Vanta's default — this is a
      // backdrop behind a sign-in form, not the page's subject.
      return {
        ...base,
        color: hexToInt(palette.primary),
        backgroundColor: hexToInt(palette.bg0),
        points: 8,
        maxDistance: 22,
        spacing: 17,
        showDots: true,
      };
    case 'globe':
      return {
        ...base,
        color: hexToInt(palette.primary),
        color2: hexToInt(palette.accentSoft),
        backgroundColor: hexToInt(palette.bg0),
        size: 0.9,
        points: 8,
        maxDistance: 22,
        spacing: 17,
      };
  }
}

/**
 * The WORST contrast the body text can end up at for a given theme, i.e. the ratio
 * of `--hug-text` against the brightest thing an effect could possibly paint (white)
 * once the scrim has composited it.
 *
 * Every real frame is lighter on the eye than this bound, because no shipped preset
 * renders pure white edge to edge. Asserting the BOUND rather than a screenshot is
 * what makes "text stays legible in every preset" a property instead of a promise.
 */
export function worstCaseTextContrast(
  palette: ThemePalette,
  scrimAlpha: number = BACKGROUND_SCRIM_ALPHA,
): number {
  const brightest = compositeOver(palette.bg0, '#ffffff', scrimAlpha);
  const darkest = compositeOver(palette.bg0, '#000000', scrimAlpha);
  return Math.min(
    contrastRatio(palette.text, brightest),
    contrastRatio(palette.text, darkest),
  );
}

/**
 * Characters that must never reach `background-image: url("…")`.
 *
 * The image URL is operator config, but "operator config" is not a security
 * boundary — it arrives through an env var and a CSS custom property, both of which
 * are strings someone can get wrong or get poisoned. Quotes, parens, backslashes and
 * whitespace are the entire vocabulary of a CSS `url()` breakout, so they are
 * rejected outright rather than escaped.
 */
const UNSAFE_URL_CHARS = /["'()\\\s<>]|[\u0000-\u0020\u007f-\u009f]/;

/** Raster image types accepted for an operator background. */
const DATA_IMAGE_RE = /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[a-z0-9+/=]+$/i;

/**
 * Validate an operator-supplied background image reference, returning it unchanged
 * when it is safe to paint and null otherwise.
 *
 * Accepted: an https: URL, a same-origin relative or root-relative path, or a
 * base64 `data:` URI of a RASTER image type.
 *
 * SVG is rejected even though it is an image, matching the platform's existing
 * stance on operator-supplied art (the avatar path rejects SVG for the same reason):
 * an SVG is a document that can carry script and external references, and this one
 * would be painted on the login page — the single most valuable page to inject into.
 * PNG/JPEG/WEBP/AVIF/GIF carry no script.
 *
 * `http:` is rejected because the login page is HTTPS and a mixed-content image is
 * both blocked and a downgrade; protocol-relative `//host/x.png` is rejected because
 * it is an off-origin fetch wearing a relative path's clothes; `javascript:` and
 * every other scheme fall through the allowlist.
 *
 * NOTE this is the SHAPE check only. The pixels are checked separately, at load
 * time, by decoding the image and enforcing {@link BACKGROUND_IMAGE_MIN_WIDTH} x
 * {@link BACKGROUND_IMAGE_MIN_HEIGHT} — a string check cannot tell a photograph from
 * a 1x1 tracking pixel stretched across the viewport.
 */
export function safeBackgroundImageUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value || value.length > 8192) return null;

  if (DATA_IMAGE_RE.test(value)) return value;
  // Everything past here is a URL/path, where the breakout characters apply. (A
  // base64 data: URI is checked above by an exhaustive character class instead.)
  if (UNSAFE_URL_CHARS.test(value)) return null;
  if (value.startsWith('//')) return null;
  if (/^https:\/\/[^/]+\//i.test(value)) return value;
  // Relative ("brand-bg.jpg") or root-relative ("/login/brand-bg.jpg") same-origin
  // path: no scheme may appear before the first slash.
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) return value;
  return null;
}

/**
 * Pull the reference out of a CSS `url(…)` value, so an operator background can also
 * arrive as a THEME TOKEN (`--hug-login-bg-image`) rather than as container env.
 *
 * That path matters because it is how this platform already ships operator-supplied
 * assets: an uploaded brand FONT is gate-checked by the Studio and embedded as a
 * data: URI inside the same `SNAP_THEME_CSS` text the colours ride on
 * (hugmesh-generator `core/fonts.py::font_face_css`). A background image is the same
 * kind of thing — a themeable asset — so it gets the same transport rather than a
 * new one, and the extracted value is then held to exactly the same allowlist as the
 * env-supplied URL by {@link safeBackgroundImageUrl}.
 *
 * Returns null for a value that is not a single `url(…)`, including the `none` that
 * an unset property computes to.
 */
export function extractCssUrl(raw: string | null | undefined): string | null {
  const value = (raw ?? '').trim();
  const match = /^url\(\s*(?:"([^"]*)"|'([^']*)'|([^)\s]*))\s*\)$/.exec(value);
  if (!match) return null;
  const url = (match[1] ?? match[2] ?? match[3] ?? '').trim();
  return url || null;
}
