/**
 * Shared xlf helpers for the i18n build steps.
 *
 * `@angular/localize/tools` is a NODE-ONLY, BUILD-TIME package — it is one of the
 * three localize subpaths native-federation hard-codes into its NG_SKIP_LIST, and
 * it never reaches a browser bundle. Everything in this directory runs on the
 * build host (or inside the Dockerfile's `node:24-alpine` build stage) and emits
 * plain JSON that the runtime `loadTranslations()` consumes.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import {
  Diagnostics,
  Xliff2TranslationParser,
  SimpleJsonTranslationSerializer,
} from '@angular/localize/tools';

/** Locale tag of a catalog file: `messages.<locale>.xlf` -> `<locale>`. */
export function localeOf(xlfPath) {
  const m = basename(xlfPath).match(/^messages\.(.+)\.xlf$/);
  if (!m) throw new Error(`not a locale catalog filename: ${xlfPath}`);
  return m[1];
}

/**
 * Parse an xlf2 file into `{ locale, translations }`.
 *
 * Angular's own parser is used rather than an ad-hoc XML reader precisely so the
 * placeholder/ICU encoding in the emitted JSON is byte-for-byte what
 * `loadTranslations()` expects — a hand-rolled converter is exactly how you get a
 * catalog that parses but renders `{$INTERPOLATION}` at the user.
 */
export function parseXlf(path) {
  const parser = new Xliff2TranslationParser();
  const contents = readFileSync(path, 'utf8');
  const analysis = parser.analyze(path, contents);
  if (!analysis.canParse) {
    throw new Error(`${path}: not parseable as xlf2 — ${analysis.diagnostics?.formatDiagnostics('') ?? ''}`);
  }
  const bundle = parser.parse(path, contents, analysis.hint);
  if (bundle.diagnostics.hasErrors) {
    throw new Error(bundle.diagnostics.formatDiagnostics(`${path}: parse errors`));
  }
  return bundle;
}

/** Serialize a parsed bundle to the `{locale, translations}` JSON
 *  `loadTranslations()` consumes. */
export function toJson(bundle, locale) {
  const diagnostics = new Diagnostics();
  const serializer = new SimpleJsonTranslationSerializer(locale ?? bundle.locale);
  const messages = Object.entries(bundle.translations).map(([id, message]) => ({
    id,
    text: message.text,
    ...message,
  }));
  const json = serializer.serialize(messages);
  if (diagnostics.hasErrors) throw new Error(diagnostics.formatDiagnostics('serialize errors'));
  return json;
}

/** Read the SOURCE template (messages.xlf) and return the set of message ids the
 *  app actually contains — the completeness gate's reference set. */
export function sourceIds(templatePath) {
  const xml = readFileSync(templatePath, 'utf8');
  return new Set([...xml.matchAll(/<unit id="([^"]+)"/g)].map((m) => m[1]));
}
