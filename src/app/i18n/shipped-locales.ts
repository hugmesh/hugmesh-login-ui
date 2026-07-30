/**
 * The translation catalogs this BUILD actually ships — GENERATED, do not edit.
 *
 * Rewritten by `tools/i18n/emit-shipped-locales.mjs` (npm run i18n:prepare) from
 * the `SNAP_WEB_LOCALES` build arg, which the Dockerfile forwards from the
 * Studio's `web_locales` field. The checked-in value is the DEFAULT — an empty
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
export const SHIPPED_LOCALES: readonly string[] = ['en-XA'];
