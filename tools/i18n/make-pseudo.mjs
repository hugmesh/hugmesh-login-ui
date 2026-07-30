/**
 * Generate the `en-XA` PSEUDO-LOCALE catalog from the extracted template.
 *
 *   node tools/i18n/make-pseudo.mjs     (or: npm run i18n:pseudo)
 *
 * WHY A PSEUDO-LOCALE EXISTS AT ALL
 * ---------------------------------
 * Real translations are CONTENT, not engineering: this repo will not invent 131
 * German strings and pass them off as translations nobody can stand behind.
 * `en-XA` is the standard, honest alternative (Android and Chrome ship the same
 * convention): every message is MECHANICALLY derived from its English source by
 * accenting Latin letters and padding the result ~30%. It is not a translation
 * and cannot be mistaken for one — `⟦Sîgn în tö snåpdrågön.sýstéms⟧` reads as
 * obviously synthetic.
 *
 * It earns its place by being genuinely useful, not just demonstrable:
 *   • it is COMPLETE by construction, so it is the one locale that can prove the
 *     whole runtime pipeline (xlf -> json -> loadTranslations -> $localize) and
 *     the Studio's `web_locales` knob end to end, with real shipped bytes;
 *   • any UI text that renders UNACCENTED under `?lang=en-XA` is a string
 *     somebody forgot to mark up — the pseudo-locale is a visual test for the
 *     exact half-localization failure this design is built to prevent;
 *   • the ~30% padding surfaces layout that breaks on longer languages (German
 *     runs long) before a real translator is ever paid.
 *
 * Placeholders (`{$INTERPOLATION}`, `{$START_LINK}`, …) and XML entities are
 * left untouched — accenting them would corrupt the message or the file.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TEMPLATE = join(ROOT, 'src', 'locale', 'messages.xlf');
const OUT = join(ROOT, 'src', 'locale', 'messages.en-XA.xlf');
const PSEUDO_LOCALE = 'en-XA';

/** Latin -> accented Latin. Same glyph shape, unmistakably not English. */
const ACCENTS = {
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'î', j: 'ĵ',
  k: 'ķ', l: 'ļ', m: 'ɱ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'ü', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Î', J: 'Ĵ',
  K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Ü', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

/** Accent the letters of a bare text run. */
const accent = (s) => s.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c);

/**
 * Pseudo-localize one XML fragment (the inner content of a `<source>`).
 *
 * The fragment is split so three things are preserved verbatim:
 *   • XML TAGS (`<pc …>`, `<ph …/>`) — accenting a tag name or attribute would
 *     produce invalid XML or a placeholder the runtime cannot resolve;
 *   • XML ENTITIES (`&amp;`) — `&` … `;` wraps letters that must not be touched,
 *     or the file stops parsing;
 *   • `{$PLACEHOLDER}` markers — the runtime substitutes these by exact name.
 * Everything else is real user-visible text and gets accented.
 */
function pseudoFragment(xml) {
  return xml
    .split(/(<[^>]*>|&[a-zA-Z#0-9]+;|\{\$[A-Z_0-9]+\})/g)
    .map((part, i) => (i % 2 === 1 ? part : accent(part)))
    .join('');
}

/** Visible expansion so long-language layout bugs show up now, not after a
 *  translator is paid. Bracketed so truncation is obvious at a glance. */
function pad(fragment) {
  const letters = (fragment.match(/[A-Za-zÀ-ž]/g) ?? []).length;
  return `⟦${fragment}${'·'.repeat(Math.max(1, Math.round(letters * 0.3)))}⟧`;
}

const template = readFileSync(TEMPLATE, 'utf8');

let count = 0;
// Give every unit a <target> derived from its <source>. The template has no
// targets at all (it is the extraction output), so this is a pure addition.
let out = template.replace(
  /<source>([\s\S]*?)<\/source>/g,
  (_m, inner) => {
    count++;
    return `<source>${inner}</source>\n        <target>${pad(pseudoFragment(inner))}</target>`;
  },
);

// xlf2 carries the target language on the <file>'s parent <xliff> element.
out = out.replace(
  /<xliff ([^>]*?)srcLang="([^"]+)"([^>]*)>/,
  (_m, before, src, after) => `<xliff ${before}srcLang="${src}" trgLang="${PSEUDO_LOCALE}"${after}>`,
);

const banner = `<!-- GENERATED — DO NOT EDIT, DO NOT TRANSLATE.
     Pseudo-locale "${PSEUDO_LOCALE}", produced from messages.xlf by
     tools/i18n/make-pseudo.mjs (npm run i18n:pseudo). Every target here is the
     English source with its letters accented and padded ~30%. These are NOT
     translations and must never be presented as any real language: en-XA exists
     to prove the catalog pipeline end to end and to make unmarked strings and
     long-language layout breaks visible. Regenerate after any i18n:extract. -->
`;
out = out.replace(/(<\?xml[^>]*\?>\n?)/, `$1${banner}`);

writeFileSync(OUT, out);
console.log(`[i18n] wrote ${OUT} — ${count} pseudo-localized messages (locale ${PSEUDO_LOCALE})`);
