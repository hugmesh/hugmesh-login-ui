/**
 * PRE-BUILD step: bake the selected locale set into the bundle.
 *
 *   SNAP_WEB_LOCALES=de,en-XA node tools/i18n/emit-shipped-locales.mjs
 *   (or: npm run i18n:prepare)
 *
 * Rewrites `src/app/i18n/shipped-locales.ts` from `SNAP_WEB_LOCALES`, which the
 * Dockerfile forwards from the Studio's `web_locales` field. Unset/empty =>
 * English-only, which is the checked-in default, so a plain `npm run build`
 * leaves the working tree clean.
 *
 * WHY THE LIST IS COMPILED IN AND NOT FETCHED: the runtime must decide whether
 * a catalog EXISTS before asking for it. Discovering the set at runtime would
 * mean fetching a manifest — which, on the default English-only image, is a
 * request for a file that was deliberately never shipped. Baking the list in
 * keeps the default path at exactly zero catalog requests, which is what makes
 * it safe for a LAN-only / air-gapped mesh.
 *
 * It also means the knob changes the BUNDLE, not just the file list: a reviewer
 * can grep the built `routes.js` for the locale tag.
 *
 * This step VALIDATES rather than trusts: a requested locale with no catalog
 * fails the build loudly here, instead of shipping an image whose users silently
 * get English.
 */
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LOCALE_DIR = join(ROOT, 'src', 'locale');
const OUT = join(ROOT, 'src', 'app', 'i18n', 'shipped-locales.ts');
const SOURCE_LOCALE = 'en';

/** Locales that HAVE a catalog file on disk (`messages.<locale>.xlf`). */
export function availableLocales() {
  if (!existsSync(LOCALE_DIR)) return [];
  return readdirSync(LOCALE_DIR)
    .map((f) => f.match(/^messages\.(.+)\.xlf$/)?.[1])
    .filter(Boolean)
    .sort();
}

/** Parse the `SNAP_WEB_LOCALES` build arg: comma/space separated, deduped. */
export function parseRequested(raw) {
  return [...new Set((raw ?? '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean))].sort();
}

export function resolveShipped(raw) {
  const requested = parseRequested(raw);
  const available = availableLocales();

  // English is the SOURCE language — its text is compiled into the bundle, so it
  // has no catalog and asking for it is a no-op rather than an error.
  const wanted = requested.filter((l) => l !== SOURCE_LOCALE);
  const missing = wanted.filter((l) => !available.includes(l));
  if (missing.length > 0) {
    throw new Error(
      `SNAP_WEB_LOCALES requested locale(s) with no catalog: ${missing.join(', ')}\n` +
        `  Catalogs present: ${available.length ? available.join(', ') : '(none)'}\n` +
        `  Add src/locale/messages.<locale>.xlf, or drop the locale from web_locales.\n` +
        `  Failing the build here is deliberate: shipping the image anyway would ` +
        `silently serve English to every user who asked for ${missing.join('/')}.`,
    );
  }
  return wanted;
}

/** Only WRITE when invoked directly. `build-catalogs.mjs` imports
 *  {@link resolveShipped} from here so both steps read the same env var through
 *  the same validation — importing must not have the side effect of rewriting a
 *  source file. */
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main();
}

function main() {
const shipped = resolveShipped(process.env.SNAP_WEB_LOCALES);

const body = `/**
 * The translation catalogs this BUILD actually ships — GENERATED, do not edit.
 *
 * Rewritten by \`tools/i18n/emit-shipped-locales.mjs\` (npm run i18n:prepare) from
 * the \`SNAP_WEB_LOCALES\` build arg, which the Dockerfile forwards from the
 * Studio's \`web_locales\` field. The checked-in value is the DEFAULT — an empty
 * list, i.e. English-only.
 *
 * English is the SOURCE language: its text is baked into the bundle by the
 * compiler, so English needs no catalog and never appears here. An empty list
 * therefore means "ship zero catalog files and issue zero catalog requests" —
 * the smallest artifact and the zero-network-surface path that a LAN-only /
 * air-gapped mesh gets by default.
 *
 * This list exists so {@link resolveLocale} can decide against a KNOWN set
 * instead of speculatively fetching a catalog that was never built and eating a
 * 404 on every non-English browser.
 */
export const SHIPPED_LOCALES: readonly string[] = [${shipped.map((l) => `'${l}'`).join(', ')}];
`;

writeFileSync(OUT, body);
console.log(
  `[i18n] shipped locales: ${shipped.length ? shipped.join(', ') : '(none — English only)'}`,
);
}
