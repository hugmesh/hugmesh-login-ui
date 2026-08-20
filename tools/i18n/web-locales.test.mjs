/**
 * Pins the DUAL READ of the web-locales build arg (rename phase 1).
 *
 *   node --test tools/i18n/          (or: npm run i18n:test)
 *
 * WHY THIS FILE EXISTS. `HUG_WEB_LOCALES` / `SNAP_WEB_LOCALES` crosses a repo
 * boundary: hugmesh-generator sets it (Makefile -> compose build arg -> this
 * image's ARG), this repo consumes it. Every failure on that path is SILENT —
 * BuildKit only warns about an undeclared build arg, and an empty locale list is
 * the legitimate default ("ship zero catalogs, English only"). So a broken dual
 * read does not fail a build; it ships a green image that serves English to
 * every user who asked for German.
 *
 * The specific trap this pins is the third case below. The Dockerfile writes
 * `ENV HUG_WEB_LOCALES=` for an unpassed build arg, so the NEW name is always
 * DEFINED inside the build. A `??`-based fallback would therefore always pick
 * the new name's empty string and never consult SNAP_WEB_LOCALES — which is
 * precisely the un-flipped producer's spelling. Emptiness, not definedness, has
 * to select the fallback.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { webLocalesEnv } from './emit-shipped-locales.mjs';

test('neither name set => empty (English-only, the shipped default)', () => {
  assert.equal(webLocalesEnv({}), '');
});

test('OLD name only => honoured (an un-flipped producer keeps working)', () => {
  assert.equal(webLocalesEnv({ SNAP_WEB_LOCALES: 'de,fr' }), 'de,fr');
});

test('NEW name DEFINED BUT EMPTY + old name set => old name wins', () => {
  // This is what the image actually looks like today: the Dockerfile always
  // materialises ENV HUG_WEB_LOCALES=, while compose still passes SNAP_*.
  assert.equal(
    webLocalesEnv({ HUG_WEB_LOCALES: '', SNAP_WEB_LOCALES: 'de,fr' }),
    'de,fr',
  );
  // Whitespace is not a value either — a `--build-arg HUG_WEB_LOCALES=" "` must
  // not shadow a real list.
  assert.equal(
    webLocalesEnv({ HUG_WEB_LOCALES: '   ', SNAP_WEB_LOCALES: 'de' }),
    'de',
  );
});

test('NEW name only => honoured (the post-flip producer works today)', () => {
  assert.equal(webLocalesEnv({ HUG_WEB_LOCALES: 'en-XA' }), 'en-XA');
});

test('BOTH set non-empty => NEW name wins', () => {
  assert.equal(
    webLocalesEnv({ HUG_WEB_LOCALES: 'en-XA', SNAP_WEB_LOCALES: 'de,fr' }),
    'en-XA',
  );
});
