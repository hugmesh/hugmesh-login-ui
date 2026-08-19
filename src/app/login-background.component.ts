import {
  AfterViewInit,
  Component,
  ElementRef,
  InjectionToken,
  NgZone,
  OnDestroy,
  OnInit,
  Renderer2,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import {
  BACKGROUND_EFFECT_IDS,
  BACKGROUND_IMAGE_MIN_HEIGHT,
  BACKGROUND_IMAGE_MIN_WIDTH,
  BackgroundEffectId,
  BackgroundPresetId,
  DEFAULT_BACKGROUND_PRESET,
  THEME_EFFECT_TOKENS,
  ThemeBackgroundEffect,
  extractCssUrl,
  isBackgroundEffect,
  parseBackgroundPreset,
  parseThemeBackgroundEffect,
  resolveBackgroundPreset,
  safeBackgroundImageUrl,
  themeEffectPreset,
  vantaOptionsFor,
} from './background.types';
import {
  ThemePalette,
  paletteFingerprint,
  readThemePalette,
} from './theme-tokens';
import {
  VantaEffectLoader,
  VantaInstance,
  loadVantaEffect,
  webglAvailable,
} from './vanta-effects';

/**
 * The Vanta loader, behind a token so a spec can drive the whole lifecycle without a
 * GPU (and without downloading three.js into the karma bundle).
 */
export const VANTA_EFFECT_LOADER = new InjectionToken<VantaEffectLoader>(
  'VANTA_EFFECT_LOADER',
  { providedIn: 'root', factory: () => loadVantaEffect },
);

/** The WebGL capability probe, behind a token for the same reason. */
export const VANTA_WEBGL_PROBE = new InjectionToken<() => boolean>('VANTA_WEBGL_PROBE', {
  providedIn: 'root',
  factory: () => webglAvailable,
});

/**
 * Event a future in-page theme switcher can dispatch on `window` to tell the
 * background its tokens moved.
 *
 * The background already watches the DOM for theme changes, which covers every
 * mechanism that mutates `:root` or swaps a stylesheet. This event exists for the one
 * case observation cannot see: a switcher that changes tokens inside a constructed
 * stylesheet or a CSSOM rule, where no node and no attribute changes.
 */
export const THEME_CHANGE_EVENT = 'hug-theme-change';

/** localStorage key for the visitor's own pick, honoured only when the picker is on. */
const PRESET_STORAGE_KEY = 'hug.login.background';

/** Theme token an operator background image can be delivered through. */
const IMAGE_TOKEN = '--hug-login-bg-image';

interface BackgroundConfig {
  readonly preset: BackgroundPresetId;
  readonly image: string | null;
  readonly picker: boolean;
  /** True when the ENV named a preset explicitly — theme-token changes must not move it. */
  readonly pinned: boolean;
}

/**
 * The animated, THEME-REACTIVE login backdrop.
 *
 * Three layers, painted back to front:
 *
 *   1. a themed CSS gradient built from `--hug-*` tokens — always present, needs no
 *      JavaScript, and is what the visitor sees if anything below fails;
 *   2. optionally a Vanta/three.js effect, or an operator-supplied image, drawn into
 *      the same box;
 *   3. a scrim in `--hug-bg-0`, which is what keeps the sign-in form legible over
 *      whatever layer 2 decided to render (see BACKGROUND_SCRIM_ALPHA).
 *
 * DEGRADATION IS THE DESIGN, because this is the platform's front door and a
 * decorative backdrop may never be the reason someone cannot sign in. Layer 1 is
 * painted by CSS before any of this class runs, and EVERY path that could fail —
 * no WebGL, a chunk that will not load, a Vanta init that throws, a lost GL context,
 * an image that will not decode or is too small, a bad preset id in an env var —
 * lands back on it. There is no state in which the page is blank.
 *
 * A11y: the visual layers are `aria-hidden` (they carry no information), and
 * `prefers-reduced-motion: reduce` means the effect is NEVER STARTED — not started
 * and paused, not started at 1 frame per second. An animated full-viewport
 * background is a known vestibular trigger, so for a visitor who asked for reduced
 * motion the animation chunks (154 KB gzipped of three.js, plus the effect) are
 * not even fetched.
 *
 * MOUNTED BY THE SHELL (app.component.html) rather than by the login view, because
 * the shell is what is actually served to users on the front door: the fe-gateway
 * routes /login/** straight to this container's own index.html (see the note at the
 * top of src/index.html). Mounting it there covers every route in this remote —
 * sign-in, appeal, MFA — with one fixed backdrop, and leaves the FEDERATED case
 * (where a host renders `./routes` inside its own chrome) to the host's own shell,
 * which is the only thing that should be painting a host page's background.
 */
@Component({
  selector: 'hug-login-background',
  standalone: true,
  templateUrl: './login-background.component.html',
  styleUrl: './login-background.component.scss',
})
export class LoginBackgroundComponent implements OnInit, AfterViewInit, OnDestroy {
  private readonly zone = inject(NgZone);
  private readonly renderer = inject(Renderer2);
  private readonly loadEffect = inject(VANTA_EFFECT_LOADER);
  private readonly hasWebgl = inject(VANTA_WEBGL_PROBE);

  private readonly stage = viewChild.required<ElementRef<HTMLElement>>('stage');

  /** The live theme, re-read whenever anything could have changed it. */
  readonly palette = signal<ThemePalette>(readThemePalette());
  /** What is actually being rendered (already collapsed to something honourable). */
  readonly activePreset = signal<BackgroundPresetId>('static');
  /** True while the visitor has asked for reduced motion. */
  readonly reducedMotion = signal(false);
  /** Whether the visitor-facing preset picker is switched on by the operator. */
  readonly pickerEnabled = signal(false);
  /** The validated operator background image, if one is configured. */
  readonly imageUrl = signal<string | null>(null);
  /** True once an effect is running; drives nothing visual, but specs assert on it. */
  readonly effectRunning = signal(false);

  /** The presets offered in the picker — `image` only when there is an image. */
  readonly offeredPresets = computed<BackgroundPresetId[]>(() => {
    const presets: BackgroundPresetId[] = [...BACKGROUND_EFFECT_IDS, 'static'];
    return this.imageUrl() ? [...presets, 'image'] : presets;
  });

  private instance: VantaInstance | null = null;
  private instanceEffect: BackgroundEffectId | null = null;
  /** The theme's last-seen `--sd-bg-effect` declaration (null: the theme said nothing). */
  private themeEffect: ThemeBackgroundEffect | null = null;
  /**
   * True once something MORE SPECIFIC than the theme owns the preset: an explicit
   * `SNAP_BG_EFFECT` env, or the visitor's own pick. A pinned preset never follows
   * `--sd-bg-effect` — the token is the mesh's brand default, and both of those
   * outrank it for the same reason the env background image outranks the theme's.
   */
  private presetPinned = false;
  /** Monotonic token so a slow lazy import cannot revive a preset already switched away from. */
  private startToken = 0;
  private observers: MutationObserver[] = [];
  private teardown: Array<() => void> = [];
  private paletteFrame = 0;
  private viewReady = false;

  constructor() {
    // A theme change restyles a RUNNING effect in place: all four shipped effects
    // re-read their colour options every frame, so pushing the new palette through
    // setOptions() is a live recolour with no teardown, no context loss and no
    // reload. Guarded on instanceEffect so a palette update that arrives mid-switch
    // cannot push fog's options into waves.
    effect(() => {
      const palette = this.palette();
      const running = this.instance;
      const id = this.instanceEffect;
      if (!running || !id || id !== this.activePreset()) return;
      try {
        running.setOptions?.(vantaOptionsFor(id, palette));
      } catch {
        // A failed recolour leaves the previous frame on screen, which is strictly
        // better than tearing the background down mid-session.
      }
    });
  }

  ngOnInit(): void {
    const config = this.readConfig();
    this.imageUrl.set(config.image);
    this.pickerEnabled.set(config.picker);
    this.presetPinned = config.pinned;
    this.activePreset.set(resolveBackgroundPreset(this.initialPreset(config), !!config.image));
    this.watchReducedMotion();
    this.watchTheme();
  }

  ngAfterViewInit(): void {
    this.viewReady = true;
    void this.applyPreset();
  }

  ngOnDestroy(): void {
    this.stopEffect();
    for (const off of this.teardown) off();
    this.teardown = [];
    for (const observer of this.observers) observer.disconnect();
    this.observers = [];
    if (this.paletteFrame) cancelAnimationFrame(this.paletteFrame);
  }

  /**
   * The visible name of one preset.
   *
   * A METHOD, never a module-level map of `$localize` strings: a `const` at module
   * scope evaluates when the host imports `./routes`, before localeGuard has loaded a
   * catalog, so it would ship permanently English on an otherwise translated page.
   * `npm run i18n:check` fails the build on exactly that mistake — the same reasoning
   * as login.component.ts's screenReaderPrompt().
   */
  presetLabel(id: BackgroundPresetId): string {
    switch (id) {
      case 'fog':
        return $localize`:Name of the drifting-gradient login background|@@background.preset.fog:Gradient`;
      case 'waves':
        return $localize`:Name of the rolling-waves login background|@@background.preset.waves:Waves`;
      case 'net':
        return $localize`:Name of the connected-points login background|@@background.preset.net:Mesh`;
      case 'globe':
        return $localize`:Name of the rotating-globe login background|@@background.preset.globe:Globe`;
      case 'static':
        return $localize`:Name of the still, non-animated login background|@@background.preset.static:Still`;
      case 'image':
        return $localize`:Name of the operator-supplied image login background|@@background.preset.image:Image`;
    }
  }

  /** Picker handler: remember the pick, then swap what is rendering. */
  choosePreset(raw: string): void {
    const picked = parseBackgroundPreset(raw);
    if (!picked) return;
    const next = resolveBackgroundPreset(picked, !!this.imageUrl());
    // A deliberate pick outranks the theme's `--sd-bg-effect` from here on, even
    // when it happens to match the current preset.
    this.presetPinned = true;
    if (next === this.activePreset()) return;
    this.activePreset.set(next);
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, next);
    } catch {
      // Private-browsing / storage-disabled: the pick still applies for this visit.
    }
    void this.applyPreset();
  }

  // ── configuration ─────────────────────────────────────────────────────────────

  /**
   * Runtime config, read off `globalThis` exactly like every other knob in this
   * remote (see oidc-config.ts): `docker-entrypoint.d/40-snap-config.sh` writes the
   * globals from env at container start, so a mesh changes its login background with
   * an env edit and a restart — no image rebuild, the same contract the theme uses.
   *
   * The values are treated as UNTRUSTED input, not as configuration that is known
   * good: an unknown effect id lands on the default and an unusable image URL is
   * dropped, because the alternative is a front door that fails to boot over a typo.
   */
  private readConfig(): BackgroundConfig {
    const globals = globalThis as unknown as Record<string, unknown>;
    // Env wins over the theme token: the token is the mesh's BRAND default (shipped
    // in SNAP_THEME_CSS alongside the colours), while the env var is this
    // deployment's explicit override.
    const fromEnv = safeBackgroundImageUrl(globals['__HUG_BG_IMAGE__']);
    const fromTheme = safeBackgroundImageUrl(this.themeImageToken());
    const image = fromEnv ?? fromTheme;
    // Supplying a background FILE and no effect id means the file is the background —
    // an operator who went to the trouble of pointing at an image did not mean for
    // the default animation to cover it. An explicit SNAP_BG_EFFECT still wins, so
    // "ship the image but show fog today" stays expressible.
    const requested = parseBackgroundPreset(globals['__HUG_BG_EFFECT__']);
    // The theme's own `--sd-bg-effect` sits BETWEEN the env override and the shipped
    // default — the exact precedence the background image token already uses. It may
    // not have arrived yet (snap-theme.css is a <link> that can still be in flight);
    // watchTheme() re-reads it on every theme change, so a late declaration is
    // honoured the moment the stylesheet lands.
    this.themeEffect = this.themeEffectToken();
    return {
      preset: requested ?? themeEffectPreset(this.themeEffect, !!image),
      image,
      picker: globals['__HUG_BG_PICKER__'] === true,
      pinned: requested !== null,
    };
  }

  /** The `--hug-login-bg-image` theme token's URL, if the theme sets one. */
  private themeImageToken(): string | null {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
    return extractCssUrl(getComputedStyle(document.documentElement).getPropertyValue(IMAGE_TOKEN));
  }

  /**
   * The theme's `--sd-bg-effect` declaration (or its `--hug-bg-effect` runtime
   * twin), parsed. The first token that HAS a value decides — the twins are emitted
   * together by the generator, so consulting the second is only ever a fallback for
   * a hand-written theme that set one and not the other.
   */
  private themeEffectToken(): ThemeBackgroundEffect | null {
    if (typeof document === 'undefined' || typeof getComputedStyle !== 'function') return null;
    const style = getComputedStyle(document.documentElement);
    for (const token of THEME_EFFECT_TOKENS) {
      const raw = style.getPropertyValue(token);
      if (raw && raw.trim()) return parseThemeBackgroundEffect(raw);
    }
    return null;
  }

  /**
   * Where to start: the visitor's stored pick when the operator enabled the picker,
   * otherwise the operator's configured preset. A stored value is ignored outright
   * when the picker is off, so turning the picker back off restores the operator's
   * choice for everyone instead of leaving old picks stuck in browsers.
   */
  private initialPreset(config: BackgroundConfig): BackgroundPresetId {
    if (!config.picker) return config.preset;
    try {
      const stored = parseBackgroundPreset(localStorage.getItem(PRESET_STORAGE_KEY));
      if (stored) {
        // A remembered pick is the visitor's, so the theme may not override it.
        this.presetPinned = true;
        return stored;
      }
      return config.preset;
    } catch {
      return config.preset;
    }
  }

  // ── rendering ─────────────────────────────────────────────────────────────────

  /** Render whatever `activePreset()` now says, tearing down what was there. */
  private async applyPreset(): Promise<void> {
    if (!this.viewReady) return;
    this.stopEffect();
    this.clearImage();

    const preset = this.activePreset();
    if (preset === 'image') {
      await this.applyImage();
      return;
    }
    if (isBackgroundEffect(preset)) {
      await this.startEffect(preset);
    }
    // 'static' needs nothing: the gradient is CSS and has been painted since load.
  }

  /**
   * Start one Vanta effect, or quietly stay on the gradient.
   *
   * Runs OUTSIDE the Angular zone in full — including the dynamic import. Vanta
   * drives a requestAnimationFrame loop and binds pointer listeners; inside the zone
   * each of those would schedule a change-detection pass, so a decorative backdrop
   * would re-render the login form 60 times a second.
   */
  private async startEffect(id: BackgroundEffectId): Promise<void> {
    if (this.reducedMotion()) return;
    // Cheap probe first: without WebGL the animation chunks (154 KB gzipped of
    // three.js, plus the effect) would be downloaded only for Vanta's own init to
    // fail behind its internal catch.
    if (!this.hasWebgl()) return;

    const token = ++this.startToken;
    const element = this.stage().nativeElement;

    await this.zone.runOutsideAngular(async () => {
      try {
        const { factory, three } = await this.loadEffect(id);
        // The visitor may have switched preset (or asked for reduced motion) while
        // the chunk was in flight; starting now would attach an orphan GL context.
        if (token !== this.startToken || this.activePreset() !== id || this.reducedMotion()) return;

        // Options are read AFTER the await so an effect that started during a theme
        // change opens on the new palette rather than on a frame of the old one.
        const options = vantaOptionsFor(id, this.palette());
        const instance = factory({ ...options, el: element, THREE: three });
        this.instance = instance;
        this.instanceEffect = id;
        this.watchContextLoss(element);
        this.zone.run(() => this.effectRunning.set(true));
      } catch {
        // Chunk fetch failed, WebGL died, Vanta threw: the themed gradient is
        // already on screen and stays there. The login form is untouched either way.
        this.instance = null;
        this.instanceEffect = null;
        this.zone.run(() => this.effectRunning.set(false));
      }
    });
  }

  private stopEffect(): void {
    this.startToken++;
    const instance = this.instance;
    this.instance = null;
    this.instanceEffect = null;
    this.effectRunning.set(false);
    if (!instance) return;
    try {
      instance.destroy();
    } catch {
      // Vanta's destroy() removes its canvas from the element it believes it owns and
      // can throw if its own init bailed early. Nothing left to clean up either way.
    }
  }

  /**
   * A lost GL context (GPU reset, driver crash, a tab backgrounded too long) fires
   * once and leaves a frozen canvas behind. Tear the effect down so the themed
   * gradient shows through rather than a stale last frame.
   */
  private watchContextLoss(element: HTMLElement): void {
    const canvas = element.querySelector('canvas');
    if (!canvas) return;
    const onLost = () => this.zone.run(() => this.stopEffect());
    canvas.addEventListener('webglcontextlost', onLost, { once: true });
    this.teardown.push(() => canvas.removeEventListener('webglcontextlost', onLost));
  }

  // ── operator background image ─────────────────────────────────────────────────

  /**
   * Paint the operator's background file, after checking the PIXELS as well as the
   * string.
   *
   * The URL already passed an allowlist (scheme + raster type + no CSS-breakout
   * characters). What a string cannot answer is whether the bytes are an image at
   * all and whether they are big enough to be one: a 1x1 pixel stretched across the
   * viewport is a solid colour with a tracking beacon attached, and a 404 is a blank
   * page. Decoding first answers both — anything that fails either check falls back
   * to the themed gradient, same as every other failure here.
   */
  private async applyImage(): Promise<void> {
    const url = this.imageUrl();
    if (!url) {
      this.activePreset.set('static');
      return;
    }
    // Same staleness guard the effect path uses, for the same reason: decoding is
    // async, and the visitor can pick another preset while it is in flight.
    // `stopEffect()` bumps this token at the top of every applyPreset(), so a
    // changed token means "this render was superseded". Without it a slow decode
    // could paint the image over the preset that replaced it — or, worse, take the
    // failure branch below and stomp activePreset back to 'static' while a freshly
    // started effect kept running underneath it.
    const token = this.startToken;
    const superseded = () => token !== this.startToken || this.activePreset() !== 'image';

    const usable = await this.decodeImage(url);
    if (superseded()) return;
    if (!usable) {
      this.activePreset.set('static');
      return;
    }
    // Set imperatively, not through a template style binding: the value went through
    // safeBackgroundImageUrl() above, and doing it here keeps the one place that can
    // write a url() into CSS adjacent to the check that authorised it.
    this.renderer.setStyle(this.stage().nativeElement, 'background-image', `url("${url}")`);
  }

  private clearImage(): void {
    if (!this.viewReady) return;
    this.renderer.removeStyle(this.stage().nativeElement, 'background-image');
  }

  private decodeImage(url: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const probe = new Image();
      probe.decoding = 'async';
      probe.onload = () =>
        resolve(
          probe.naturalWidth >= BACKGROUND_IMAGE_MIN_WIDTH &&
            probe.naturalHeight >= BACKGROUND_IMAGE_MIN_HEIGHT,
        );
      probe.onerror = () => resolve(false);
      probe.src = url;
    });
  }

  // ── watchers ──────────────────────────────────────────────────────────────────

  /**
   * Reduced motion is watched, not just read once: the preference can be toggled
   * mid-session (an OS setting, or a user who reaches for it BECAUSE the page is
   * moving), and the animation must stop the moment it flips.
   */
  private watchReducedMotion(): void {
    if (typeof matchMedia !== 'function') return;
    const query = matchMedia('(prefers-reduced-motion: reduce)');
    this.reducedMotion.set(query.matches);
    const onChange = (event: MediaQueryListEvent) => {
      this.zone.run(() => {
        this.reducedMotion.set(event.matches);
        if (event.matches) this.stopEffect();
        else void this.applyPreset();
      });
    };
    query.addEventListener('change', onChange);
    this.teardown.push(() => query.removeEventListener('change', onChange));
  }

  /**
   * Watch every mechanism that can change the theme, then decide by VALUE.
   *
   * The theme arrives as CSS, and CSS can change in ways that share no single
   * notification: the injected `snap-theme.css` finishing its load, a `:root` inline
   * style or `data-theme` attribute from a future switcher, a stylesheet being
   * swapped in `<head>`, or the OS flipping colour scheme. Rather than guess which
   * one a given deployment uses, all of them are observed and the palette is re-read;
   * a fingerprint comparison then throws away the (very many) notifications that
   * changed no colour, so the expensive part runs only on a real theme change.
   *
   * Registered outside the Angular zone because zone.js patches MutationObserver and
   * media-query listeners — otherwise every stylesheet Angular itself injects at boot
   * would schedule a change-detection pass.
   */
  private watchTheme(): void {
    if (typeof document === 'undefined') return;
    const refresh = () => this.schedulePaletteRead();

    this.zone.runOutsideAngular(() => {
      if (typeof MutationObserver === 'function') {
        const root = new MutationObserver(refresh);
        root.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ['style', 'class', 'data-theme'],
        });
        const head = new MutationObserver(refresh);
        head.observe(document.head, { childList: true, subtree: true });
        this.observers.push(root, head);
      }

      if (typeof matchMedia === 'function') {
        const scheme = matchMedia('(prefers-color-scheme: dark)');
        scheme.addEventListener('change', refresh);
        this.teardown.push(() => scheme.removeEventListener('change', refresh));
      }

      window.addEventListener(THEME_CHANGE_EVENT, refresh);
      this.teardown.push(() => window.removeEventListener(THEME_CHANGE_EVENT, refresh));

      // The runtime theme is a <link> that may still be in flight when the app
      // boots; without this the background would render the compiled fallback brand
      // until something else happened to mutate the DOM.
      for (const link of Array.from(document.querySelectorAll('link[rel="stylesheet"]'))) {
        link.addEventListener('load', refresh, { once: true });
      }
    });
  }

  /** Coalesce a burst of mutations into one palette read per frame. */
  private schedulePaletteRead(): void {
    if (this.paletteFrame) return;
    this.paletteFrame = requestAnimationFrame(() => {
      this.paletteFrame = 0;
      this.refreshPalette();
    });
  }

  /**
   * Re-read the tokens; publish only what actually moved.
   *
   * Two independent outcomes ride the same notification: a COLOUR change restyles a
   * running effect in place (via the palette signal → setOptions), while a
   * `--sd-bg-effect` change swaps the preset — the old instance is destroyed (Vanta
   * leaks its WebGL context otherwise) and the new effect starts through the same
   * lazy-load path as at boot.
   */
  private refreshPalette(): void {
    const nextPalette = readThemePalette();
    const nextEffect = this.themeEffectToken();
    const paletteChanged =
      paletteFingerprint(nextPalette) !== paletteFingerprint(this.palette());
    const effectChanged = nextEffect !== this.themeEffect;
    if (!paletteChanged && !effectChanged) return;

    this.zone.run(() => {
      if (paletteChanged) this.palette.set(nextPalette);
      if (effectChanged) {
        this.themeEffect = nextEffect;
        this.applyThemeEffect();
      }
    });
  }

  /**
   * The theme (re)declared its background effect: honour it, unless the preset is
   * pinned by something more specific (env, or the visitor's own pick).
   *
   * Switching goes through applyPreset(), which destroys the running Vanta instance
   * BEFORE starting the next one — two instances on one element is a leaked WebGL
   * context and a doubled render loop — and whose start token already makes a slow
   * chunk load lose to a faster subsequent switch.
   */
  private applyThemeEffect(): void {
    if (this.presetPinned) return;
    const next = resolveBackgroundPreset(
      themeEffectPreset(this.themeEffect, !!this.imageUrl()),
      !!this.imageUrl(),
    );
    if (next === this.activePreset()) return;
    this.activePreset.set(next);
    void this.applyPreset();
  }
}
