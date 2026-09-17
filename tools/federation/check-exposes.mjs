/**
 * THE FEDERATION-SURFACE BUILD GATE.  `npm run federation:check`  (exit 1 == fail)
 *
 * This remote publishes TWO modules over native federation — `./routes` (the
 * login/registration surface the hugmesh.net host mounts at /login) and
 * `./mfa-step-up` (the one MFA step-up challenge forum, mod and wiki load in
 * place; hugmesh-generator#347 decision 21). Both are CROSS-REPO contracts whose
 * failure modes are silent at build time and ugly at runtime, in somebody else's
 * console. Each one below has cost this fleet a debugging session already.
 *
 *   GATE A  A MISSING OR RENAMED EXPOSE
 *     `exposes` is the whole public surface. Drop a key and every consumer's
 *     `loadRemoteModule` throws at runtime with a perfectly healthy build here.
 *     Point a key at a file that does not exist and the failure moves to the
 *     image build, long after review.
 *
 *   GATE B  AN EXPOSED ENTRY WITH NO `$localize`
 *     Every exposed module is an INDEPENDENT entry into this bundle. A consumer
 *     that loads only `./mfa-step-up` never imports `./routes`, so whatever
 *     installs `globalThis.$localize` must be reachable from EACH entry — and a
 *     compiled i18n template whose `consts` factory runs with `$localize`
 *     undefined is a hard ReferenceError, not a quiet English fallback. The
 *     i18n gate (GATE 3 of check-catalogs.mjs) pins that exactly ONE module
 *     imports '@angular/localize/init'; this one pins that every entry point
 *     actually reaches it.
 *
 *   GATE C  ANYTHING THAT NAVIGATES INSIDE THE EMBEDDED STEP-UP GRAPH
 *     `./mfa-step-up` is rendered INSIDE another remote, under the HOST SHELL's
 *     router, which is rooted at `/`. An absolute `routerLink`, any
 *     `router.navigate` at all, a raw `location.href = …` or a plain
 *     `<a href="/…">` therefore moves the consumer's whole page — the second of
 *     the four federated-remote URL traps this fleet has already paid for
 *     (`project_hugmesh_federated_remote_url_traps`: "links bounce to /user").
 *     It is invisible in this repo, because standalone the remote IS the page.
 *     So, for everything reachable from that entry point:
 *       C1  no module may import '@angular/router';
 *       C2  no template may carry a routerLink — INLINE `template:` literals
 *           included, not just `templateUrl:` files (an inline template is in
 *           the graph exactly as much as a linked one, and checking only the
 *           linked ones let a `template: '<a routerLink="/">'` through);
 *       C3  no module may call a raw navigation primitive — `location.href =`,
 *           `location.assign/replace`, `window.open`, `history.pushState/
 *           replaceState`. `@angular/router` is not the only way to move a page,
 *           and the component docstring's claim ("IT NAVIGATES NOWHERE, BY
 *           CONSTRUCTION") is only worth what this gate enforces;
 *       C4  no template may carry an ABSOLUTE `href` ("/…" or "http…"), which
 *           is a full page load out of the consumer's view.
 *     C2/C3/C4 exist because a skeptic pass proved C1-as-shipped exited 0 on
 *     both `template: '<a routerLink="/">bounce</a>'` and
 *     `window.location.href = '/'` inside the embedded component.
 *
 *   GATE E  AN EXPOSED ENTRY THAT IS NOT IN THE TYPESCRIPT PROGRAM
 *     The Angular compiler only sees files reachable from a program ROOT. The
 *     dev shell's `src/main.ts` is the root, and `./routes` happens to be
 *     reachable from it — which is why the first expose never needed a line in
 *     tsconfig.app.json. `./mfa-step-up` is not reachable from it at all: its
 *     consumers are OTHER REPOS, so nothing in this app renders it. Miss that and
 *     the build dies with "File 'src/app/mfa-step-up.ts' not found in TypeScript
 *     compilation" — loud, but only at image-build time, after review.
 *
 *   GATE D  A REMOTE NAME THAT DISAGREES WITH ITSELF
 *     native-federation registers a remote under the `name` declared inside its
 *     OWN remoteEntry.json — never under the key a consumer's manifest uses. A
 *     mismatch registers fine and then throws "Remote 'x' is not initialized" at
 *     loadRemoteModule time with NO failed network request to point at (that was
 *     the character-studio/character-forge failure of 2026-08-12). So the
 *     remoteName/exposedModule pair this repo PUBLISHES to consumers, in
 *     `MFA_STEP_UP_REMOTE`, must equal what federation.config.js actually
 *     declares.
 *
 * WHERE THIS RUNS, AND WHY THAT MATTERS. `pretest` and `prebuild` in package.json
 * both invoke it, so `npm test` and `npm run build` — the two commands a
 * contributor actually types — fail on a contract break. `build:image` and the
 * Dockerfile RUN invoke it too. That wiring is load-bearing and was added after a
 * skeptic pass measured the alternative: with the gate reachable ONLY from
 * `build:image`, a component that re-acquired a Router AND called
 * `router.navigateByUrl('/login/security')` on the success path produced
 * `TOTAL: 467 SUCCESS` from `npx ng test` and `Application bundle generation
 * complete` from `npx ng build`. No unit spec can close that hole — Angular's
 * Router is root-providable (`ɵprov` on the class), so `inject(Router)` resolves
 * in a TestBed with no `provideRouter` and throws nothing. THIS FILE IS THE
 * ENFORCEMENT. Do not unwire it from pretest/prebuild.
 *
 * The walker below follows RELATIVE imports only (a bare specifier is a package,
 * not our code) plus each component's `templateUrl`. It FAILS on an import it
 * cannot resolve rather than skipping it: a gate that silently ignores what it
 * cannot read is a gate that passes for the wrong reason.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(import.meta.url);

/** Every expose this repo's consumers depend on. Adding one is fine; losing one
 *  is a broken cross-repo contract, so they are named here explicitly. */
const REQUIRED_EXPOSES = ['./routes', './mfa-step-up'];

/** The module that installs `globalThis.$localize` (see i18n/localize-init.ts).
 *  Every exposed entry point must reach it. */
const LOCALIZE_INIT = join(ROOT, 'src', 'app', 'i18n', 'localize-init.ts');

/** The exposed module that is rendered inside ANOTHER remote's page, and must
 *  therefore navigate nowhere at all. */
const EMBEDDED_EXPOSE = './mfa-step-up';

/** Where the published remoteName/exposedModule pair lives. */
const CONTRACT_FILE = join(ROOT, 'src', 'app', 'mfa-step-up.ts');

const failures = [];
const fail = (gate, msg) => failures.push(`[${gate}] ${msg}`);
const rel = (p) => relative(ROOT, p);

/** Strip comments so a spec mentioned in prose is never a hit. Keeps newlines so
 *  reported line numbers stay honest. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '');
}

/** Every module specifier `file` imports or re-exports. */
function specifiersOf(code) {
  const out = [];
  // `import x from 's'` / `import 's'` / `export … from 's'` / `import('s')`
  const patterns = [
    /(?:^|\n)\s*import\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*import\s*['"]([^'"]+)['"]/g,
    /(?:^|\n)\s*export\s+[^'";]*?from\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ];
  for (const re of patterns) for (const m of code.matchAll(re)) out.push(m[1]);
  return out;
}

/** Resolve a RELATIVE specifier to a real .ts file, or null if it is a package. */
function resolveRelative(fromFile, spec) {
  if (!spec.startsWith('.')) return null;
  const base = resolve(dirname(fromFile), spec);
  for (const cand of [base, `${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand) && !cand.endsWith('/')) {
      try {
        if (readFileSync(cand).length >= 0 && cand.endsWith('.ts')) return cand;
      } catch { /* fall through to the failure below */ }
    }
  }
  return undefined; // distinguishable from "it is a package" (null)
}

/**
 * Walk the import graph of one entry point.
 * Returns { ts: Set<abs .ts>, html: Set<abs .html>, packages: Set<string> }.
 */
function walk(entry) {
  const ts = new Set();
  const html = new Set();
  const inline = [];
  const packages = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (ts.has(file)) continue;
    ts.add(file);
    if (!existsSync(file)) {
      fail('A', `${rel(file)} is imported but does not exist.`);
      continue;
    }
    const code = stripComments(readFileSync(file, 'utf8'));
    for (const spec of specifiersOf(code)) {
      if (!spec.startsWith('.')) {
        packages.add(spec);
        continue;
      }
      const target = resolveRelative(file, spec);
      if (target === undefined) {
        fail('A', `${rel(file)} imports '${spec}', which resolves to no .ts file. ` +
          `This gate refuses to skip what it cannot resolve.`);
        continue;
      }
      queue.push(target);
    }
    for (const m of code.matchAll(/templateUrl\s*:\s*['"]([^'"]+)['"]/g)) {
      const t = resolve(dirname(file), m[1]);
      if (!existsSync(t)) {
        fail('A', `${rel(file)} names templateUrl '${m[1]}', which does not exist.`);
        continue;
      }
      html.add(t);
    }
    // An INLINE `template:` literal is markup in this graph exactly as much as a
    // linked .html file is. Checking only templateUrl let a routerLink through.
    // `\btemplate` cannot match inside `templateUrl` (the ':' would have to
    // follow 'template' directly), so the two collectors do not overlap.
    for (const m of code.matchAll(/\btemplate\s*:\s*(['"`])([\s\S]*?)\1/g)) {
      inline.push({ file, markup: m[2] });
    }
  }
  return { ts, html, inline, packages };
}

// ---------------------------------------------------------------- GATE A
const config = require(join(ROOT, 'federation.config.js'));
const exposes = config?.exposes ?? {};
const graphs = new Map();

for (const key of REQUIRED_EXPOSES) {
  // withNativeFederation() normalises each value to `{ file: './src/...' }`; a
  // hand-written config may still carry the bare string, so accept both rather
  // than depending on an internal shape.
  const raw = exposes[key];
  const target = typeof raw === 'string' ? raw : raw?.file;
  if (!target) {
    fail('A', `federation.config.js exposes no '${key}'. Consumers load it by that ` +
      `exact string; removing or renaming it breaks them at runtime with a green build here. ` +
      `Declared: ${JSON.stringify(Object.keys(exposes))}.`);
    continue;
  }
  const entry = resolve(ROOT, target);
  if (!existsSync(entry)) {
    fail('A', `federation.config.js maps '${key}' -> '${target}', which does not exist.`);
    continue;
  }
  graphs.set(key, { entry, ...walk(entry) });
}

// ---------------------------------------------------------------- GATE B
for (const [key, graph] of graphs) {
  if (!graph.ts.has(LOCALIZE_INIT)) {
    fail('B', `the exposed '${key}' entry never reaches ${rel(LOCALIZE_INIT)}, so a consumer ` +
      `that loads ONLY this module renders compiled i18n templates with globalThis.$localize ` +
      `undefined — a ReferenceError, not an English fallback. Import it from the entry point.`);
  }
}

// ---------------------------------------------------------------- GATE C
const embedded = graphs.get(EMBEDDED_EXPOSE);
if (embedded) {
  for (const spec of embedded.packages) {
    if (spec === '@angular/router' || spec.startsWith('@angular/router/')) {
      const importer = [...embedded.ts].find((f) =>
        specifiersOf(stripComments(readFileSync(f, 'utf8'))).includes(spec));
      fail('C', `${rel(importer ?? EMBEDDED_EXPOSE)} imports '${spec}', and it is reachable from ` +
        `the embedded '${EMBEDDED_EXPOSE}' entry. Under the host shell the injected Router is the ` +
        `SHELL's, rooted at '/', so navigating from inside an embedded dialog moves the ` +
        `consumer's whole page. Navigation belongs to the caller.`);
    }
  }
  // C2 + C4 — every template in the graph, linked OR inline.
  const templates = [
    ...[...embedded.html].map((t) => ({ where: rel(t), markup: readFileSync(t, 'utf8') })),
    ...embedded.inline.map((t) => ({ where: `${rel(t.file)} (inline template)`, markup: t.markup })),
  ];
  for (const { where, markup: raw } of templates) {
    const markup = raw.replace(/<!--[\s\S]*?-->/g, '');
    if (/\brouterLink\b/.test(markup)) {
      fail('C', `${where} carries a routerLink and is reachable from the embedded ` +
        `'${EMBEDDED_EXPOSE}' entry. Under the host shell that link resolves against the SHELL's ` +
        `router, not the consumer's view — the "links bounce to /user" trap.`);
    }
    const href = markup.match(/\bhref\s*=\s*['"](\/[^'"]*|https?:\/\/[^'"]*)['"]/);
    if (href) {
      fail('C', `${where} carries an absolute href ${JSON.stringify(href[1])} and is reachable ` +
        `from the embedded '${EMBEDDED_EXPOSE}' entry. A plain absolute link is a FULL PAGE LOAD ` +
        `out of the consumer's view — the same trap as a routerLink, without the router. ` +
        `Emit an output and let the caller decide where to go.`);
    }
  }

  // C3 — a router is not the only way to move a page.
  const NAVIGATION_PRIMITIVES = [
    [/\blocation\s*\.\s*href\s*=(?!=)/, 'location.href = …'],
    [/\blocation\s*\.\s*(?:assign|replace)\s*\(/, 'location.assign()/location.replace()'],
    [/\bwindow\s*\.\s*location\s*=(?!=)/, 'window.location = …'],
    [/\bwindow\s*\.\s*open\s*\(/, 'window.open()'],
    [/\bhistory\s*\.\s*(?:pushState|replaceState)\s*\(/, 'history.pushState()/replaceState()'],
  ];
  for (const f of embedded.ts) {
    if (!existsSync(f)) continue;
    const code = stripComments(readFileSync(f, 'utf8'));
    for (const [re, name] of NAVIGATION_PRIMITIVES) {
      if (re.test(code)) {
        fail('C', `${rel(f)} calls ${name}, and it is reachable from the embedded ` +
          `'${EMBEDDED_EXPOSE}' entry. That moves the consumer's whole page just as surely as a ` +
          `Router does — and leaves this remote's own bundle behind. Navigation belongs to the ` +
          `caller: emit an output instead.`);
      }
    }
  }
}

// ---------------------------------------------------------------- GATE E
const APP_TSCONFIG = join(ROOT, 'tsconfig.app.json');
if (!existsSync(APP_TSCONFIG)) {
  fail('E', `${rel(APP_TSCONFIG)} is missing — cannot tell whether the exposed entries are in the ` +
    `TypeScript program.`);
} else {
  // tsconfig files are JSON-with-comments; strip them the same way as source.
  const tsconfig = JSON.parse(stripComments(readFileSync(APP_TSCONFIG, 'utf8')));
  const roots = (tsconfig.files ?? []).map((f) => resolve(ROOT, f));
  if (roots.length === 0) {
    fail('E', `${rel(APP_TSCONFIG)} declares no "files" roots.`);
  }
  const inProgram = new Set();
  for (const r of roots) for (const f of walk(r).ts) inProgram.add(f);
  for (const [key, graph] of graphs) {
    if (!inProgram.has(graph.entry)) {
      fail('E', `the exposed '${key}' entry ${rel(graph.entry)} is not reachable from any ` +
        `${rel(APP_TSCONFIG)} "files" root, so the Angular compiler never sees it: ` +
        `"File '...' not found in TypeScript compilation". Add it to "files".`);
    }
  }
}

// ---------------------------------------------------------------- GATE D
if (!existsSync(CONTRACT_FILE)) {
  fail('D', `${rel(CONTRACT_FILE)} is missing — it is what publishes the remoteName/exposedModule ` +
    `pair consumers copy.`);
} else {
  const contract = stripComments(readFileSync(CONTRACT_FILE, 'utf8'));
  const declaredName = config?.name;
  const publishedName = contract.match(/remoteName\s*:\s*['"]([^'"]+)['"]/)?.[1];
  const publishedModule = contract.match(/exposedModule\s*:\s*['"]([^'"]+)['"]/)?.[1];
  if (publishedName !== declaredName) {
    fail('D', `MFA_STEP_UP_REMOTE.remoteName is ${JSON.stringify(publishedName)} but ` +
      `federation.config.js declares name ${JSON.stringify(declaredName)}. native-federation ` +
      `registers a remote under ITS OWN declared name; a mismatch throws ` +
      `"Remote '...' is not initialized" with no failed request to point at.`);
  }
  if (publishedModule !== EMBEDDED_EXPOSE) {
    fail('D', `MFA_STEP_UP_REMOTE.exposedModule is ${JSON.stringify(publishedModule)} but the ` +
      `exposed key is ${JSON.stringify(EMBEDDED_EXPOSE)}.`);
  }
}

// ----------------------------------------------------------------
if (failures.length > 0) {
  console.error('\nfederation check FAILED:\n');
  for (const f of failures) console.error('  ' + f + '\n');
  process.exit(1);
}
console.log(
  `[federation] check passed — exposes ${JSON.stringify(Object.keys(exposes))}; ` +
  `every entry installs $localize and is in the TS program; '${EMBEDDED_EXPOSE}' imports no ` +
  `router, carries no routerLink or absolute href (linked AND inline templates) and calls no ` +
  `raw navigation primitive; remote name agrees.`,
);
