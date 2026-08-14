/**
 * RUNTIME i18n for the login remote: locale resolution + catalog loading.
 *
 * WHY RUNTIME AND NOT ANGULAR'S DEFAULT BUILD-TIME i18n
 * ----------------------------------------------------
 * Build-time i18n emits ONE BUNDLE PER LOCALE. This repo is a native-federation
 * REMOTE: the hugmesh.net host resolves remotes through a flat
 * `remoteName -> URL` map (its `resolveFederationSource()` + `initFederation()`,
 * with `{ path: 'login', remoteName: 'login', exposed: './routes' }`). That map
 * has NO locale axis, and the fe-gateway routes `/login/**` (StripPrefix=1) to a
 * single container with no locale in the path. Per-locale bundles would mean
 * locale-aware remoteEntry URLs — a change to the host, to the federation-api
 * manifest schema, and to the contract every sibling remote shares. Runtime
 * translation keeps ONE bundle and needs no host change at all.
 *
 * WHY THIS IS SAFE — THE TIMING ARGUMENT
 * --------------------------------------
 * The Angular compiler emits `$localize` tagged strings inside a component's
 * `consts: () => { ... }` LAZY ARROW FACTORY, evaluated at first RENDER, not at
 * module import. So importing `login.routes.ts` (which statically imports every
 * component) does NOT evaluate any `$localize`. That leaves a legal window:
 * a `canMatch` guard runs after import but before component instantiation, so
 * awaiting the catalog there guarantees every template string is translated.
 *
 * THE ONE RULE THAT KEEPS IT TRUE: **no `$localize` at module scope.** A
 * module-level `const X = $localize\`...\`` evaluates at IMPORT — before any
 * guard can run — and would be permanently, silently English. Use a lazy getter
 * or a function instead (see login.component.ts / appeal.component.ts, which
 * both used to hold module-level copy). `npm run i18n:check` fails the build on
 * a module-scope `$localize`, so this cannot rot silently.
 *
 * KNOWN, ACCEPTED LIMITATION: because `consts` is memoised per component
 * definition, switching locale after a component has rendered requires a PAGE
 * RELOAD. That is acceptable here — login is the entry surface, and the locale
 * is resolved before the login routes first render. It is documented rather
 * than worked around.
 *
 * SOVEREIGNTY: catalogs are served by this remote's OWN nginx container from
 * bytes baked into the image at build time. No CDN, no third-party host, no
 * CLDR/locale-data download, no webfont. Air-gap safe.
 */
import { loadTranslations } from '@angular/localize';
import { SHIPPED_LOCALES } from './shipped-locales';

/** The source language: its text is compiled into the bundle, so it has no
 *  catalog and needs no load. */
export const SOURCE_LOCALE = 'en';

/** Query param / storage key an operator or user can pin the locale with. */
const LANG_PARAM = 'lang';
const LANG_STORAGE_KEY = 'snap.login.lang';

/**
 * The catalog URL for a locale, resolved against THIS REMOTE'S OWN bundle URL.
 *
 * This is load-bearing and easy to get wrong. Remote code executes inside the
 * HOST'S page, so a document-relative `fetch('i18n/de.json')` would resolve
 * against the host origin (hugmesh.net) — where it 404s, or worse, hits
 * the systems-web host and returns an HTML 200. `import.meta.url` is the URL of
 * this module's own chunk, so the catalog is always fetched from the container
 * that shipped it — correct whether the remote is loaded cross-origin directly
 * or same-origin through the fe-gateway's `/login/**` route.
 */
export function catalogUrl(locale: string): string {
  return new URL(`./i18n/${locale}.json`, import.meta.url).href;
}

/** Read a candidate locale from `?lang=`, falling back to a stored preference. */
function preferredLocale(): string | null {
  try {
    const fromQuery = new URLSearchParams(globalThis.location?.search ?? '').get(LANG_PARAM);
    if (fromQuery) {
      globalThis.localStorage?.setItem(LANG_STORAGE_KEY, fromQuery);
      return fromQuery;
    }
    return globalThis.localStorage?.getItem(LANG_STORAGE_KEY) ?? null;
  } catch {
    // A sandboxed/partitioned context can throw on localStorage. Never fatal:
    // locale detection degrades to navigator.language, then to English.
    return null;
  }
}

/**
 * Pick the best SHIPPED locale for this browser, or `SOURCE_LOCALE` when none
 * matches. Precedence: explicit `?lang=` / stored preference, then
 * `navigator.language(s)`, then English.
 *
 * Matching is exact first, then by primary subtag, so a `de-AT` browser gets the
 * shipped `de` catalog. The candidate is ALWAYS checked against
 * {@link SHIPPED_LOCALES} — we never request a catalog this build did not emit,
 * which is what makes the default (`web_locales=()`) path issue zero requests.
 */
export function resolveLocale(shipped: readonly string[] = SHIPPED_LOCALES): string {
  if (shipped.length === 0) return SOURCE_LOCALE;

  const candidates: string[] = [];
  const preferred = preferredLocale();
  if (preferred) candidates.push(preferred);
  candidates.push(...(globalThis.navigator?.languages ?? []));
  const single = globalThis.navigator?.language;
  if (single) candidates.push(single);

  for (const raw of candidates) {
    const tag = raw.trim();
    if (!tag) continue;
    const exact = shipped.find((l) => l.toLowerCase() === tag.toLowerCase());
    if (exact) return exact;
    const primary = tag.split('-')[0].toLowerCase();
    const byPrimary = shipped.find((l) => l.toLowerCase().split('-')[0] === primary);
    if (byPrimary) return byPrimary;
  }
  return SOURCE_LOCALE;
}

/** The catalog shape `@angular/localize`'s `loadTranslations()` consumes —
 *  exactly what `SimpleJsonTranslationSerializer` emits from our xlf. */
interface Catalog {
  locale?: string;
  translations: Record<string, string>;
}

/** The locale whose catalog is currently loaded (or the source locale). */
let activeLocale = SOURCE_LOCALE;

/** The active locale. Read AFTER {@link installLocale} has resolved. */
export function currentLocale(): string {
  return activeLocale;
}

/**
 * Resolve the locale and load its catalog into `$localize`. Resolves to the
 * locale that ended up active.
 *
 * NEVER THROWS AND NEVER BLOCKS LOGIN. A missing/corrupt/unreachable catalog
 * logs a warning and resolves to English — login is the door to the platform
 * and must not be gated on a translation file. Note the graceful degradation is
 * layered: with no catalog at all `$localize.translate` stays unset and every
 * message renders its compiled English source; with a catalog that is merely
 * INCOMPLETE, `@angular/localize` catches the per-message
 * `MissingTranslationError`, warns, and renders the English source for just that
 * message. English-only is therefore not a degraded path — it is the zero-config
 * path.
 *
 * Re-running this is deliberate and cheap (see the guard): it re-asserts our
 * catalog if a sibling federated remote re-imported `@angular/localize/init` and
 * clobbered `globalThis.$localize` after we loaded.
 */
export async function installLocale(
  shipped: readonly string[] = SHIPPED_LOCALES,
): Promise<string> {
  const locale = resolveLocale(shipped);
  if (locale === SOURCE_LOCALE) {
    activeLocale = SOURCE_LOCALE;
    return SOURCE_LOCALE;
  }
  try {
    const res = await fetch(catalogUrl(locale), { credentials: 'omit' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const catalog = (await res.json()) as Catalog;
    const translations = catalog?.translations;
    if (!translations || typeof translations !== 'object') {
      throw new Error('catalog has no translations map');
    }
    loadTranslations(translations);
    activeLocale = locale;
    return locale;
  } catch (err) {
    console.warn(
      `[hug-login] locale "${locale}" catalog unavailable; falling back to English.`,
      err,
    );
    activeLocale = SOURCE_LOCALE;
    return SOURCE_LOCALE;
  }
}
