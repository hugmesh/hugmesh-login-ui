/**
 * POST-BUILD step: emit the selected locales' JSON catalogs into the browser
 * dist, where the existing Dockerfile `COPY --from=build /app/dist/login/browser
 * /usr/share/nginx/html` carries them into the image.
 *
 *   SNAP_WEB_LOCALES=en-XA node tools/i18n/build-catalogs.mjs
 *   (or: npm run i18n:catalogs)
 *
 * `angular.json`'s esbuild target has `assets: []` — nothing is auto-copied — so
 * a catalog exists in the image ONLY because this step put it there. That is the
 * whole point: `web_locales` maps to real, listable bytes.
 *
 *   web_locales = ()        -> dist/login/browser/i18n/ DOES NOT EXIST
 *   web_locales = ("en-XA") -> dist/login/browser/i18n/en-XA.json
 *
 * A reviewer needs no source access to check it:
 *   docker run --rm <image> ls -R /usr/share/nginx/html/i18n
 *
 * Runs AFTER `ng build` (the dist dir must exist) and pairs with the pre-build
 * `emit-shipped-locales.mjs`, which bakes the same list into the bundle so the
 * runtime knows what to ask for. Both read the SAME env var, so the file set and
 * the compiled set cannot drift.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseXlf, toJson } from './xlf.mjs';
import { resolveShipped } from './emit-shipped-locales.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALE_DIR = join(ROOT, 'src', 'locale');
const DIST = join(ROOT, 'dist', 'login', 'browser');
const OUT_DIR = join(DIST, 'i18n');

const shipped = resolveShipped(process.env.SNAP_WEB_LOCALES);

if (!existsSync(DIST)) {
  throw new Error(`${DIST} does not exist — run \`npm run build:login\` first.`);
}

// Start from a clean slate so a rebuild with FEWER locales cannot leave a stale
// catalog behind in the image. Without this, flipping web_locales from ("de")
// back to () would still ship de.json — a knob that only ever adds is a knob
// that lies.
rmSync(OUT_DIR, { recursive: true, force: true });

if (shipped.length === 0) {
  console.log('[i18n] no locales selected — shipping zero catalogs (English only)');
  process.exit(0);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const locale of shipped) {
  const bundle = parseXlf(join(LOCALE_DIR, `messages.${locale}.xlf`));
  const out = join(OUT_DIR, `${locale}.json`);
  writeFileSync(out, toJson(bundle, locale));
  console.log(`[i18n] ${locale}: ${Object.keys(bundle.translations).length} messages -> ${out}`);
}
