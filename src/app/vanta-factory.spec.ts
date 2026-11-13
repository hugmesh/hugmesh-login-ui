import { EFFECT_IMPORTS, loadVantaEffect, vantaFactory } from './vanta-effects';
import { BACKGROUND_EFFECT_IDS } from './background.types';

/** The login page's Vanta backgrounds never rendered: see vantaFactory(). */
describe('vantaFactory', () => {
  it('unwraps the UMD double default', () => {
    const fn = () => ({ destroy: () => undefined });
    expect(vantaFactory({ default: { default: fn } })).toBe(fn as never);
  });

  it('accepts a module that exports the constructor directly', () => {
    const fn = () => ({ destroy: () => undefined });
    expect(vantaFactory({ default: fn })).toBe(fn as never);
  });

  it('refuses a module with no constructor', () => {
    expect(() => vantaFactory({ default: {} })).toThrowError(/no effect constructor/);
  });

  it('loadVantaEffect unwraps the shape the production (esbuild) build hands it', async () => {
    const fn = () => ({ destroy: () => undefined });
    const original = EFFECT_IMPORTS.waves;
    EFFECT_IMPORTS.waves = () => Promise.resolve({ default: { default: fn } });
    try {
      expect((await loadVantaEffect('waves')).factory).toBe(fn as never);
    } finally {
      EFFECT_IMPORTS.waves = original;
    }
  });

  for (const id of BACKGROUND_EFFECT_IDS) {
    it(`the real '${id}' module yields a callable effect constructor`, async () => {
      expect(typeof (await loadVantaEffect(id)).factory).toBe('function');
    });
  }
});
