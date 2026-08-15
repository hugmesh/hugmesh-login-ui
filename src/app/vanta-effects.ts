/**
 * The LAZY loader for the animated background, and the whole reason the login
 * page's critical path is unchanged by this feature.
 *
 * three.js cannot be tree-shaken here — Vanta takes the module NAMESPACE by
 * injection (`{ THREE }`), so a bundler must keep all of it. Measured on this
 * repo's production build it is a 735 KB chunk, 154 KB over the wire.
 * On the platform's front door that is not acceptable as an eager cost: the sign-in
 * form has to paint and be typeable before a decorative backdrop has downloaded
 * anything. Every import below is therefore DYNAMIC, which is what lets esbuild
 * split three.js and each effect into their own chunks; nothing here is fetched
 * until {@link loadVantaEffect} is actually called, and it is not called at all
 * when the visitor asked for reduced motion, when the operator chose a static or
 * image background, or when the machine has no WebGL.
 *
 * The import map is STATIC (one thunk per id) rather than a template literal,
 * because a bundler can only split what it can see at build time — `import('vanta/'
 * + id)` would either fail to resolve or drag every effect into one chunk.
 */
import { BackgroundEffectId } from './background.types';

/** A live Vanta effect. Mirrors the ambient `VantaEffectInstance` (see vanta.d.ts). */
export interface VantaInstance {
  setOptions?(options: Record<string, unknown>): void;
  destroy(): void;
}

/** What one effect needs to start: its factory plus the three.js namespace to inject. */
export interface LoadedVantaEffect {
  readonly factory: (options: Record<string, unknown>) => VantaInstance;
  readonly three: unknown;
}

/** The signature {@link LoginBackgroundComponent} depends on, so specs can substitute it. */
export type VantaEffectLoader = (id: BackgroundEffectId) => Promise<LoadedVantaEffect>;

const EFFECT_IMPORTS: Readonly<Record<BackgroundEffectId, () => Promise<{ default: unknown }>>> = {
  fog: () => import('vanta/dist/vanta.fog.min'),
  waves: () => import('vanta/dist/vanta.waves.min'),
  net: () => import('vanta/dist/vanta.net.min'),
  globe: () => import('vanta/dist/vanta.globe.min'),
};

/**
 * Fetch three.js and one effect module, in parallel.
 *
 * Both land in the browser's module cache, so switching presets afterwards costs a
 * second ~12KB effect chunk and nothing more — three.js is downloaded once.
 */
export const loadVantaEffect: VantaEffectLoader = async (id) => {
  const [three, effect] = await Promise.all([import('three'), EFFECT_IMPORTS[id]()]);
  return {
    three,
    factory: effect.default as (options: Record<string, unknown>) => VantaInstance,
  };
};

/**
 * Whether this browser can run any of it at all.
 *
 * Checked BEFORE the loader, not after: a machine with WebGL disabled (a locked-down
 * corporate profile, a headless browser, a GPU blocklist) would otherwise download
 * 154 KB (gzipped) to discover that Vanta's own init fails. Creating and dropping a probe
 * canvas costs microseconds; the whole call is wrapped because a browser that has
 * disabled WebGL by policy can THROW from getContext rather than return null.
 */
export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}
