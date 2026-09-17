/**
 * The i18n BUILD GATES.  `npm run i18n:check`  (exit 1 == fail the build)
 *
 * Three failure modes in this design are silent — no error, no warning, just a
 * wrong page — so none of them may be left to review or to runtime. Each gets a
 * gate here.
 *
 *   GATE 1  MODULE-SCOPE $localize
 *     A `const X = $localize\`…\`` at module scope evaluates at IMPORT — when the
 *     host imports the exposed `./routes`, before localeGuard can load a catalog
 *     — so it is permanently, silently English on an otherwise translated page.
 *     Template strings are safe (the compiler defers them into a lazy
 *     `consts: () => {…}` factory evaluated at first render), which is exactly
 *     why this one hazard is invisible: it looks identical to safe code.
 *     login.component.ts and appeal.component.ts BOTH shipped module-level
 *     user-visible copy before this change; this gate is what stops it coming back.
 *
 *   GATE 2  INCOMPLETE CATALOG
 *     A missing message falls back to its English source per-message — which IS
 *     mixed-language output, delivered with only a console warning. Completeness
 *     therefore cannot be a runtime concern: every message in messages.xlf must
 *     have a target in every catalog, or the build fails here.
 *
 *   GATE 3  MULTIPLE `@angular/localize/init` IMPORTERS
 *     `/init` assigns `globalThis.$localize` from its own inlined copy of the
 *     localize chunk (localize is never shared — native-federation hard-codes it
 *     into NG_SKIP_LIST). Two importers race for one global; the loser's catalog
 *     is discarded and `$localize.translate` is `undefined` on the winner, so
 *     translation is skipped WITHOUT even the "No translation found" warning.
 *     Exactly one module in this repo may import it: src/app/i18n/localize-init.ts.
 *     It used to be src/app/login.routes.ts, the single exposed federation entry
 *     point; this remote now exposes TWO (`./routes` and `./mfa-step-up`), and a
 *     consumer that loads only the second never imports the first — so the import
 *     moved to a module BOTH entry points import. That is still ONE copy: the
 *     exposes are bundled by one esbuild pass with code splitting on, so a module
 *     two entry points share is hoisted into one chunk. The race this gate exists
 *     to prevent is the CROSS-BUNDLE one, and it is unchanged.
 *     See federation-base.js for the fleet-wide statement of this invariant.
 *
 *   GATE 4  STALE messages.xlf
 *     Gate 2 only proves the catalogs match the TEMPLATE. If someone marks up a
 *     new string and forgets `npm run i18n:extract`, the template never learns
 *     about it, every catalog is "complete" against a stale template, and the new
 *     string renders English on a translated page — the same silent
 *     half-localization, reached from the other side. Every message carries an
 *     explicit `@@id`, so the ids in the source are authoritative and can be
 *     compared to the template without paying for a full extraction build.
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';
import { sourceIds } from './xlf.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SRC = join(ROOT, 'src');
const LOCALE_DIR = join(ROOT, 'src', 'locale');
const TEMPLATE = join(LOCALE_DIR, 'messages.xlf');
const INIT_OWNER = join(SRC, 'app', 'i18n', 'localize-init.ts');

const failures = [];
const fail = (gate, msg) => failures.push(`[${gate}] ${msg}`);

/** Every .ts file under src/, excluding the generated API client and specs. */
function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'api') continue; // generated ng-openapi-gen client: no UI copy
      out.push(...tsFiles(p));
    } else if (e.name.endsWith('.ts') && !e.name.endsWith('.spec.ts')) {
      out.push(p);
    }
  }
  return out;
}

/** Strip comments and template/string literals so a $localize mentioned in prose
 *  (this file, and the several doc comments that explain the rule) is not a hit. */
function stripNonCode(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

// ---------------------------------------------------------------- GATE 1
for (const file of tsFiles(SRC)) {
  const code = stripNonCode(readFileSync(file, 'utf8'));
  const lines = code.split('\n');
  let depth = 0;
  lines.forEach((line, i) => {
    // A $localize at brace-depth 0 is module scope: not inside a class, function,
    // getter or arrow body, so it runs the moment the module is imported.
    if (depth === 0 && /\$localize\s*`/.test(line)) {
      fail(
        1,
        `${relative(ROOT, file)}:${i + 1} — $localize at MODULE SCOPE. It evaluates at import, ` +
          `before the locale guard loads a catalog, and would be permanently English. ` +
          `Move it into a function, getter, or computed().`,
      );
    }
    depth += (line.match(/[{([]/g) ?? []).length - (line.match(/[})\]]/g) ?? []).length;
    if (depth < 0) depth = 0;
  });
}

// ---------------------------------------------------------------- GATE 2
if (!existsSync(TEMPLATE)) {
  fail(2, `${relative(ROOT, TEMPLATE)} missing — run \`npm run i18n:extract\`.`);
} else {
  const ids = sourceIds(TEMPLATE);
  const catalogs = readdirSync(LOCALE_DIR).filter((f) => /^messages\..+\.xlf$/.test(f));
  for (const f of catalogs) {
    const locale = f.match(/^messages\.(.+)\.xlf$/)[1];
    const xml = readFileSync(join(LOCALE_DIR, f), 'utf8');

    // Which units actually carry a non-empty <target>?
    const translated = new Set(
      [...xml.matchAll(/<unit id="([^"]+)"[\s\S]*?<\/unit>/g)]
        .filter(([unit]) => /<target[^>]*>[\s\S]*?\S[\s\S]*?<\/target>/.test(unit))
        .map((m) => m[1]),
    );

    const missing = [...ids].filter((id) => !translated.has(id));
    const stale = [...translated].filter((id) => !ids.has(id));

    if (missing.length > 0) {
      fail(
        2,
        `${f} (locale ${locale}) is INCOMPLETE: ${missing.length}/${ids.size} messages have no ` +
          `<target> — e.g. ${missing.slice(0, 3).join(', ')}. Shipping it would render those ` +
          `messages in English on a ${locale} page (mixed-language output, warning only). ` +
          `Translate them, or keep ${locale} out of web_locales until it is finished.`,
      );
    }
    if (stale.length > 0) {
      fail(
        2,
        `${f} (locale ${locale}) has ${stale.length} STALE message(s) not in messages.xlf — ` +
          `e.g. ${stale.slice(0, 3).join(', ')}. Re-extract and re-translate.`,
      );
    }
  }
}

// ---------------------------------------------------------------- GATE 3
const importers = tsFiles(SRC).filter((f) =>
  /(^|\n)\s*import\s+['"]@angular\/localize\/init['"]/.test(stripNonCode(readFileSync(f, 'utf8'))),
);
if (importers.length === 0) {
  fail(3, `No module imports '@angular/localize/init' — $localize will be undefined at runtime.`);
} else if (importers.length > 1 || importers[0] !== INIT_OWNER) {
  fail(
    3,
    `'@angular/localize/init' must be imported by EXACTLY ONE module ` +
      `(${relative(ROOT, INIT_OWNER)}, imported in turn by EVERY exposed ` +
      `federation entry point). Found: ` +
      `${importers.map((f) => relative(ROOT, f)).join(', ')}. Two importers race for ` +
      `globalThis.$localize and the loser's catalog is silently discarded.`,
  );
}

// ---------------------------------------------------------------- GATE 4
if (existsSync(TEMPLATE)) {
  const templateIds = sourceIds(TEMPLATE);

  /** Every `@@id` written in a template or a $localize call. Comments stripped
   *  so the several doc comments explaining this scheme are not counted. */
  const declared = new Set();
  const scan = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== 'api') scan(p);
      } else if (/\.(ts|html)$/.test(e.name) && !e.name.endsWith('.spec.ts')) {
        let src = readFileSync(p, 'utf8');
        src = e.name.endsWith('.html')
          ? src.replace(/<!--[\s\S]*?-->/g, '')
          : stripNonCode(src);
        for (const m of src.matchAll(/@@([A-Za-z0-9_.\-]+)/g)) declared.add(m[1]);
      }
    }
  };
  scan(SRC);

  const notExtracted = [...declared].filter((id) => !templateIds.has(id));
  const orphaned = [...templateIds].filter((id) => !declared.has(id));
  if (notExtracted.length > 0) {
    fail(
      4,
      `messages.xlf is STALE — ${notExtracted.length} message(s) exist in the source but not in ` +
        `the template: ${notExtracted.slice(0, 5).join(', ')}. Run \`npm run i18n:extract\` ` +
        `(then \`npm run i18n:pseudo\`) — otherwise they render English in every locale.`,
    );
  }
  if (orphaned.length > 0) {
    fail(
      4,
      `messages.xlf has ${orphaned.length} message(s) no longer in the source: ` +
        `${orphaned.slice(0, 5).join(', ')}. Re-extract to drop them.`,
    );
  }
}

// ----------------------------------------------------------------
if (failures.length > 0) {
  console.error('\ni18n check FAILED:\n');
  for (const f of failures) console.error('  ' + f + '\n');
  process.exit(1);
}
console.log('[i18n] check passed — no module-scope $localize, catalogs complete and current, single init owner.');
