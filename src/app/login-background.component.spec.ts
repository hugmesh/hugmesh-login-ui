import { ComponentFixture, TestBed } from '@angular/core/testing';
import {
  LoginBackgroundComponent,
  THEME_CHANGE_EVENT,
  VANTA_EFFECT_LOADER,
  VANTA_WEBGL_PROBE,
} from './login-background.component';
import { BACKGROUND_SCRIM_ALPHA, BackgroundEffectId } from './background.types';
import { VantaInstance } from './vanta-effects';

/**
 * A stand-in for one Vanta effect. Records what it was constructed with and what was
 * pushed at it afterwards, which is how the "theme changes restyle the background
 * LIVE, without a reload" claim is verified without a GPU.
 */
class FakeVanta implements VantaInstance {
  static created: FakeVanta[] = [];
  readonly updates: Array<Record<string, unknown>> = [];
  destroyed = false;

  constructor(readonly options: Record<string, unknown>) {
    FakeVanta.created.push(this);
    // Vanta appends its renderer's canvas to the element it was given; the
    // context-loss watcher looks for exactly that.
    const el = options['el'] as HTMLElement | undefined;
    el?.appendChild(document.createElement('canvas'));
  }

  setOptions(options: Record<string, unknown>): void {
    this.updates.push(options);
  }

  destroy(): void {
    this.destroyed = true;
  }
}

/**
 * A real, decodable 320x240 PNG (a flat --hug-bg-1 rectangle) as a data: URI —
 * exactly the shape an operator background takes when the theme pipeline embeds it,
 * and exactly at the minimum accepted size.
 */
const VALID_PNG_320x240 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAUAAAADwCAIAAAD+Tyo8AAACD0lEQVR42u3TQQkAAAwDsWqogPmXOQ/7DQJRcHBpB3gqEoCBAQMDBgYDAwYGDAwYGAwMGBgwMBgYMDBgYMDAYGDAwICBAQODgQEDAwYGAwMGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgOrAAYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwICBwcCAgQEDg4EBAwMGBgwMBgYMDBgYDAwYGDAwYGAwMGBgwMCAgcHAgIEBA4OBAQMDBgYMDAYGDAwYGDAwGBgwMGBgMDBgYMDAgIHBwICBAQMDBgYDAwYGDAwGBgwMGBgwMBgYMDBgYDAwYGDAwICBwcCAgQEDAwYGAwMGBgwMBgYMDBgYMDAYGDAwYGDAwGBgwMCAgcHAgIEBAwMGBgMDBgYMDAZWAQwMGBgwMBgYMDBgYMDAYGDAwICBwcCAgQEDAwYGAwMGBgwMGBgMDBgYMDAYGDAwYGDAwGBgwMCAgQEDg4EBAwMGBgMDBgYMDBgYDAwYGDAwGBgwMGBgwMBgYMDAgIEBA4OBAQMDBgYDAwYGDAwYGAwMGBgwMGBgMDBgYMDAYGDAwICBAQODgQEDAwYGDAwGBgwMGBgMDBgYMDBgYDAwYGDAwGBgwMCAgQEDg4EBAwMGBgwMBgYMDNwtohBchCiuNsEAAAAASUVORK5CYII=';

describe('LoginBackgroundComponent', () => {
  let fixture: ComponentFixture<LoginBackgroundComponent>;
  let loaded: BackgroundEffectId[];
  let loader: jasmine.Spy;
  let webgl: jasmine.Spy;

  /** Globals normally written by docker-entrypoint.d/40-snap-config.sh. */
  function setConfig(config: Record<string, unknown>): void {
    for (const [key, value] of Object.entries(config)) {
      (globalThis as Record<string, unknown>)[key] = value;
    }
  }

  function clearConfig(): void {
    for (const key of ['__HUG_BG_EFFECT__', '__HUG_BG_IMAGE__', '__HUG_BG_PICKER__']) {
      delete (globalThis as Record<string, unknown>)[key];
    }
    for (const token of ['--sd-bg-effect', '--hug-bg-effect']) {
      document.documentElement.style.removeProperty(token);
    }
  }

  /** What a theme does: declare its background effect on :root. */
  function setThemeEffect(value: string, token = '--sd-bg-effect'): void {
    document.documentElement.style.setProperty(token, value);
  }

  /**
   * Poll until `predicate` holds. The image path finishes on a real `Image` load or
   * error event, whose timing is the browser's to decide — a fixed sleep would be
   * either flaky or slow, and this is neither.
   */
  async function waitFor(predicate: () => boolean, what: string): Promise<void> {
    for (let i = 0; i < 200 && !predicate(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      fixture.detectChanges();
    }
    expect(predicate()).withContext(`timed out waiting for: ${what}`).toBeTrue();
  }

  /** Mount and let the (async) effect/image start settle. */
  async function mount(): Promise<HTMLElement> {
    fixture = TestBed.createComponent(LoginBackgroundComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => {
    FakeVanta.created = [];
    loaded = [];
    clearConfig();
    localStorage.removeItem('hug.login.background');

    loader = jasmine.createSpy('loadVantaEffect').and.callFake(async (id: BackgroundEffectId) => {
      loaded.push(id);
      return {
        three: { REVISION: 'fake' },
        factory: (options: Record<string, unknown>) => new FakeVanta(options),
      };
    });
    webgl = jasmine.createSpy('webglAvailable').and.returnValue(true);

    TestBed.configureTestingModule({
      imports: [LoginBackgroundComponent],
      providers: [
        { provide: VANTA_EFFECT_LOADER, useValue: loader },
        { provide: VANTA_WEBGL_PROBE, useValue: webgl },
      ],
    });
  });

  afterEach(() => {
    clearConfig();
    localStorage.removeItem('hug.login.background');
  });

  // ── the always-there fallback ────────────────────────────────────────────────

  it('paints the themed layers before any effect exists', async () => {
    webgl.and.returnValue(false);
    const el = await mount();

    // Layer 1 (gradient) + layer 3 (scrim) are CSS and unconditional: this is the
    // state the login page is in if every dynamic path fails.
    expect(el.querySelector('[data-testid="login-background-stage"]')).toBeTruthy();
    expect(el.querySelector('[data-testid="login-background-scrim"]')).toBeTruthy();
  });

  it('hides the decoration from assistive technology', async () => {
    const el = await mount();
    expect(el.querySelector('[data-testid="login-background"]')!.getAttribute('aria-hidden'))
      .toBe('true');
  });

  it('paints the scrim at exactly BACKGROUND_SCRIM_ALPHA', async () => {
    // Pins the TS constant the contrast floor is computed from to the CSS the
    // browser actually paints — the two drifting apart is how a legibility
    // guarantee quietly stops being one.
    const el = await mount();
    const scrim = el.querySelector('[data-testid="login-background-scrim"]')!;
    expect(Number(getComputedStyle(scrim).opacity)).toBeCloseTo(BACKGROUND_SCRIM_ALPHA, 3);
  });

  // ── accessibility: reduced motion ────────────────────────────────────────────

  it('NEVER starts an effect — or even fetches one — under prefers-reduced-motion', async () => {
    // An animated full-viewport background is a vestibular trigger, so the
    // requirement is "not started", not "started and dimmed". Fetching the 154 KB
    // (gzipped) three.js chunk would also be pure waste for this visitor.
    spyOn(window, 'matchMedia').and.callFake(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    setConfig({ __HUG_BG_EFFECT__: 'fog' });

    await mount();

    expect(loader).not.toHaveBeenCalled();
    expect(FakeVanta.created.length).toBe(0);
    expect(fixture.componentInstance.reducedMotion()).toBeTrue();
    expect(fixture.componentInstance.effectRunning()).toBeFalse();
  });

  // ── degradation ──────────────────────────────────────────────────────────────

  it('does not download the animation when the machine has no WebGL', async () => {
    webgl.and.returnValue(false);
    setConfig({ __HUG_BG_EFFECT__: 'waves' });

    await mount();

    expect(loader).not.toHaveBeenCalled();
    expect(fixture.componentInstance.effectRunning()).toBeFalse();
  });

  it('stays on the themed gradient when the effect chunk fails to load', async () => {
    loader.and.returnValue(Promise.reject(new Error('network down')));
    setConfig({ __HUG_BG_EFFECT__: 'fog' });

    const el = await mount();

    expect(fixture.componentInstance.effectRunning()).toBeFalse();
    expect(el.querySelector('[data-testid="login-background-stage"]')).toBeTruthy();
  });

  it('stays on the themed gradient when Vanta itself throws at init', async () => {
    loader.and.resolveTo({
      three: {},
      factory: () => {
        throw new Error('WebGL context creation failed');
      },
    });
    setConfig({ __HUG_BG_EFFECT__: 'net' });

    await mount();

    expect(fixture.componentInstance.effectRunning()).toBeFalse();
  });

  it('tears the effect down when the GL context is lost', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'fog' });
    const el = await mount();
    expect(fixture.componentInstance.effectRunning()).toBeTrue();

    el.querySelector('canvas')!.dispatchEvent(new Event('webglcontextlost'));
    fixture.detectChanges();

    expect(FakeVanta.created[0].destroyed).toBeTrue();
    expect(fixture.componentInstance.effectRunning()).toBeFalse();
  });

  // ── operator configuration ───────────────────────────────────────────────────

  it('starts the operator-configured effect', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'globe' });
    await mount();

    expect(loaded).toEqual(['globe']);
    expect(fixture.componentInstance.activePreset()).toBe('globe');
    expect(fixture.componentInstance.effectRunning()).toBeTrue();
  });

  it('defaults to the gradient effect when nothing is configured', async () => {
    await mount();
    expect(loaded).toEqual(['fog']);
  });

  it('falls back to the default rather than failing on a typo’d effect id', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'waaves' });
    await mount();
    expect(loaded).toEqual(['fog']);
  });

  it('runs NO effect at all for the static preset', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'static' });
    await mount();

    expect(loader).not.toHaveBeenCalled();
    expect(fixture.componentInstance.activePreset()).toBe('static');
  });

  // ── operator background image ────────────────────────────────────────────────

  it('paints an operator image, and starts no animation over it', async () => {
    // Configuring a background FILE and no effect id means the file IS the
    // background — the operator did not point at an image for fog to cover it.
    setConfig({ __HUG_BG_IMAGE__: VALID_PNG_320x240 });
    const el = await mount();
    const stage = el.querySelector<HTMLElement>('[data-testid="login-background-stage"]')!;
    // Wait on the PAINT, not on the preset: the preset is `image` from the first
    // frame, so waiting on it would prove nothing about the decode having happened.
    await waitFor(() => stage.style.backgroundImage !== '', 'the image to be painted');

    expect(fixture.componentInstance.activePreset()).toBe('image');
    expect(stage.style.backgroundImage).toContain('data:image/png;base64,');
    expect(loader).not.toHaveBeenCalled();
  });

  it('rejects an unsafe image URL outright and never reaches the image preset', async () => {
    setConfig({ __HUG_BG_IMAGE__: 'javascript:alert(1)', __HUG_BG_EFFECT__: 'image' });
    await mount();

    expect(fixture.componentInstance.imageUrl()).toBeNull();
    // `image` with no usable file collapses to the themed gradient, never to a blank
    // page and never to the poisoned value.
    expect(fixture.componentInstance.activePreset()).toBe('static');
    const stage = (fixture.nativeElement as HTMLElement).querySelector<HTMLElement>(
      '[data-testid="login-background-stage"]',
    )!;
    expect(stage.style.backgroundImage).toBe('');
  });

  it('falls back to the gradient when the image will not decode (404 / not an image)', async () => {
    setConfig({ __HUG_BG_IMAGE__: '/login/missing.png', __HUG_BG_EFFECT__: 'image' });
    const el = await mount();
    // The probe Image() 404s against the karma server, then the component degrades.
    await waitFor(() => fixture.componentInstance.activePreset() === 'static', 'fallback');

    expect(fixture.componentInstance.activePreset()).toBe('static');
    const stage = el.querySelector<HTMLElement>('[data-testid="login-background-stage"]')!;
    expect(stage.style.backgroundImage).toBe('');
  });

  it('rejects an image that decodes but is too small to be a background', async () => {
    // A 1x1 pixel stretched over the viewport is a solid colour with a tracking
    // beacon attached — the case a string check cannot see.
    const onePixelPng =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    setConfig({ __HUG_BG_IMAGE__: onePixelPng, __HUG_BG_EFFECT__: 'image' });
    const el = await mount();
    await waitFor(() => fixture.componentInstance.activePreset() === 'static', 'size rejection');

    expect(fixture.componentInstance.activePreset()).toBe('static');
    const stage = el.querySelector<HTMLElement>('[data-testid="login-background-stage"]')!;
    expect(stage.style.backgroundImage).toBe('');
  });

  it('does not let an in-flight image decode overwrite a preset picked since', async () => {
    // Decoding is async, so a visitor can switch away mid-flight. The late
    // continuation must not paint the image over the effect that replaced it, and
    // must not drag activePreset back to a stale value while that effect runs.
    setConfig({
      __HUG_BG_IMAGE__: VALID_PNG_320x240,
      __HUG_BG_EFFECT__: 'image',
      __HUG_BG_PICKER__: true,
    });
    const el = await mount();
    const stage = el.querySelector<HTMLElement>('[data-testid="login-background-stage"]')!;

    // Switch to an animated preset immediately, without waiting for the decode.
    fixture.componentInstance.choosePreset('waves');
    await waitFor(() => fixture.componentInstance.effectRunning(), 'waves to start');
    // Give any late decode continuation room to land before asserting it did not.
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.detectChanges();

    expect(fixture.componentInstance.activePreset()).toBe('waves');
    expect(stage.style.backgroundImage).withContext('stale image not painted').toBe('');
  });

  // ── theme reactivity ─────────────────────────────────────────────────────────

  it('opens the effect on the LIVE theme, not on a compiled palette', async () => {
    document.documentElement.style.setProperty('--hug-primary', '#ff0000');
    try {
      setConfig({ __HUG_BG_EFFECT__: 'fog' });
      await mount();
      expect(FakeVanta.created[0].options['highlightColor']).toBe(0xff0000);
    } finally {
      document.documentElement.style.removeProperty('--hug-primary');
    }
  });

  it('restyles a RUNNING effect when the theme changes — no reload, no teardown', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'fog' });
    await mount();
    const instance = FakeVanta.created[0];
    expect(instance.updates.length).toBe(0);

    // What a theme switch does: change the tokens, then say so.
    document.documentElement.style.setProperty('--hug-primary', '#00ff00');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    fixture.detectChanges();

    try {
      expect(instance.destroyed).withContext('restyled in place, not rebuilt').toBeFalse();
      expect(instance.updates.length).toBeGreaterThan(0);
      expect(instance.updates[instance.updates.length - 1]['highlightColor']).toBe(0x00ff00);
    } finally {
      document.documentElement.style.removeProperty('--hug-primary');
    }
  });

  it('ignores DOM churn that changed no colour', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'fog' });
    await mount();
    const instance = FakeVanta.created[0];

    // Angular injects stylesheets, routers add attributes: the watcher is broad on
    // purpose, so it must decide by VALUE or it would thrash a WebGL effect.
    document.documentElement.setAttribute('data-theme', 'dark');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));

    try {
      expect(instance.updates.length).toBe(0);
    } finally {
      document.documentElement.removeAttribute('data-theme');
    }
  });

  // ── the theme-declared effect: --sd-bg-effect ────────────────────────────────

  it('starts the effect the THEME declares via --sd-bg-effect', async () => {
    setThemeEffect('vanta-waves');
    await mount();

    expect(loaded).toEqual(['waves']);
    expect(fixture.componentInstance.activePreset()).toBe('waves');
    expect(fixture.componentInstance.effectRunning()).toBeTrue();
  });

  it('reads the --hug-bg-effect runtime twin when only it is set', async () => {
    // The generator emits every --sd-* token a second time under --hug-*; a
    // hand-written theme may set either half of the pair.
    setThemeEffect('vanta-globe', '--hug-bg-effect');
    await mount();
    expect(loaded).toEqual(['globe']);
  });

  it('degrades an unbundled vanta-<name> declaration to the themed gradient', async () => {
    // The forward-compatibility clause: a future theme naming an effect this build
    // does not bundle gets a clean themed page — and pays for zero chunks.
    setThemeEffect('vanta-birds');
    await mount();

    expect(loader).not.toHaveBeenCalled();
    expect(fixture.componentInstance.activePreset()).toBe('static');
  });

  it('never fetches a chunk for a theme-declared effect under prefers-reduced-motion', async () => {
    // Same guarantee as the env path: for a reduced-motion visitor the theme's
    // declaration must not even cost the download.
    spyOn(window, 'matchMedia').and.callFake(
      (query: string) =>
        ({
          matches: query.includes('prefers-reduced-motion'),
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    setThemeEffect('vanta-fog');

    await mount();

    expect(loader).not.toHaveBeenCalled();
    expect(FakeVanta.created.length).toBe(0);
    expect(fixture.componentInstance.effectRunning()).toBeFalse();
  });

  it('switches effects when the theme changes its declaration — old instance destroyed', async () => {
    setThemeEffect('vanta-net');
    await mount();
    expect(loaded).toEqual(['net']);
    const first = FakeVanta.created[0];

    setThemeEffect('vanta-waves');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await waitFor(
      () => fixture.componentInstance.activePreset() === 'waves' &&
        fixture.componentInstance.effectRunning(),
      'waves to take over',
    );

    // Vanta instances hold a WebGL context; a switch that does not destroy() the
    // old one leaks the context and doubles the render loop.
    expect(first.destroyed).withContext('old instance released').toBeTrue();
    expect(loaded).toEqual(['net', 'waves']);
  });

  it('honours a declaration that only arrives when the theme stylesheet lands late', async () => {
    // snap-theme.css is a <link> that can still be in flight at boot: the page
    // starts on the shipped default and must follow the theme when it lands.
    await mount();
    expect(loaded).toEqual(['fog']);

    setThemeEffect('vanta-globe');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await waitFor(() => fixture.componentInstance.activePreset() === 'globe', 'globe to take over');

    expect(FakeVanta.created[0].destroyed).toBeTrue();
    expect(loaded).toEqual(['fog', 'globe']);
  });

  it('tears the animation down when the theme switches to none', async () => {
    setThemeEffect('vanta-fog');
    await mount();
    expect(fixture.componentInstance.effectRunning()).toBeTrue();

    setThemeEffect('none');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await waitFor(() => fixture.componentInstance.activePreset() === 'static', 'the gradient');

    expect(FakeVanta.created[0].destroyed).toBeTrue();
    expect(fixture.componentInstance.effectRunning()).toBeFalse();
    expect(loaded).withContext('no second chunk fetched').toEqual(['fog']);
  });

  it('lets the env override outrank the theme declaration, on boot and on later changes', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'net' });
    setThemeEffect('vanta-waves');
    await mount();
    expect(loaded).toEqual(['net']);

    setThemeEffect('vanta-globe');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.detectChanges();

    expect(loaded).withContext('env pins the preset').toEqual(['net']);
    expect(fixture.componentInstance.activePreset()).toBe('net');
  });

  it("does not let the field's default 'gradient' suppress the operator image", async () => {
    // The generator emits `gradient` for EVERY theme (it is the field default); the
    // declaration governs the animation axis only, so a configured image survives it.
    setConfig({ __HUG_BG_IMAGE__: VALID_PNG_320x240 });
    setThemeEffect('gradient');
    const el = await mount();
    const stage = el.querySelector<HTMLElement>('[data-testid="login-background-stage"]')!;
    await waitFor(() => stage.style.backgroundImage !== '', 'the image to be painted');

    expect(fixture.componentInstance.activePreset()).toBe('image');
    expect(loader).not.toHaveBeenCalled();
  });

  it("a visitor's pick is not moved by a later theme change", async () => {
    setConfig({ __HUG_BG_PICKER__: true });
    setThemeEffect('vanta-fog');
    await mount();

    fixture.componentInstance.choosePreset('static');
    await fixture.whenStable();
    setThemeEffect('vanta-waves');
    window.dispatchEvent(new Event(THEME_CHANGE_EVENT));
    await new Promise((resolve) => setTimeout(resolve, 50));
    fixture.detectChanges();

    expect(fixture.componentInstance.activePreset()).toBe('static');
    expect(loaded).withContext('the pick pins the preset').toEqual(['fog']);
  });

  // ── the optional picker ──────────────────────────────────────────────────────

  it('hides the preset picker unless the operator switched it on', async () => {
    const el = await mount();
    expect(el.querySelector('[data-testid="login-background-picker"]')).toBeNull();
  });

  it('offers every preset when the picker is on, and switches effect on pick', async () => {
    setConfig({ __HUG_BG_PICKER__: true, __HUG_BG_EFFECT__: 'fog' });
    const el = await mount();

    const select = el.querySelector<HTMLSelectElement>('[data-testid="login-background-select"]')!;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([
      'fog',
      'waves',
      'net',
      'globe',
      'static',
    ]);

    select.value = 'waves';
    select.dispatchEvent(new Event('change'));
    await fixture.whenStable();
    fixture.detectChanges();

    expect(FakeVanta.created[0].destroyed).withContext('old effect released').toBeTrue();
    expect(loaded).toEqual(['fog', 'waves']);
    expect(localStorage.getItem('hug.login.background')).toBe('waves');
  });

  it('honours a stored pick only while the picker is enabled', async () => {
    localStorage.setItem('hug.login.background', 'net');

    setConfig({ __HUG_BG_EFFECT__: 'fog' });
    await mount();
    expect(loaded).withContext('picker off: the operator decides').toEqual(['fog']);

    fixture.destroy();
    loaded.length = 0;
    setConfig({ __HUG_BG_PICKER__: true });
    await mount();
    expect(loaded).withContext('picker on: the visitor decides').toEqual(['net']);
  });

  // ── lifecycle ────────────────────────────────────────────────────────────────

  it('releases the effect when the component goes away', async () => {
    setConfig({ __HUG_BG_EFFECT__: 'fog' });
    await mount();
    const instance = FakeVanta.created[0];

    fixture.destroy();

    expect(instance.destroyed).toBeTrue();
  });
});
