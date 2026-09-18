#!/usr/bin/env node
// WHAT THIS PROVES (hugmesh-login-ui #21)
//
// The defect is invisible from a build that SUCCEEDS: with no .dockerignore the
// image still builds, it is just built from whatever node_modules the developer
// had on disk. So the assertion has to be about what the image CONTAINS, not
// about an exit code — and the thing the image contains, at the `COPY . .`
// layer, IS the build context with .dockerignore applied.
//
// This enumerates that context under Docker's own matching rules (the port in
// ./dockerignore.mjs) and checks BOTH directions:
//
//   1. FORBIDDEN — no node_modules (at any depth), .git, .angular, dist,
//      out-tsc, coverage, test-results, *.log or .env* other than .env.example
//      reaches the image. These are the paths that silently replace the tree
//      `npm install` resolved from the lockfile.
//   2. REQUIRED — every path the image actually reads is still there: each
//      non-`--from` COPY source in the Dockerfile (parsed out of the Dockerfile,
//      not restated here, so a new COPY cannot be forgotten), plus the entry
//      points the in-image `npm run build:login` + i18n pipeline load. An
//      over-broad ignore line breaks the image exactly as hard as a missing one,
//      and that failure DOES show up as a red build — but only after a push.
//
// It is not a substitute for `docker build`. It cannot see anything the
// Dockerfile does after the COPY. What it does see — which files exist in the
// context and which do not — is decided entirely by the rules ported here, and
// those rules are pinned by tools/docker/context.test.mjs.
//
// Usage: node tools/docker/check-context.mjs [--json] [--list]
//                                            [--context <dir>] [--no-ignore]
//
// --context <dir> applies THIS repo's .dockerignore to a different tree. That
//   is how the fix gets measured at all: a fresh worktree has no node_modules,
//   so the defect is invisible there — point --context at a developer checkout
//   that HAS one (which is the only configuration where #21 is observable).
// --no-ignore enumerates the same tree with NO ignore rules, i.e. what `COPY .
//   .` shipped before this file existed. The difference between the two runs is
//   the evidence.

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDockerignore, isExcluded, mayContainException, compilePattern } from './dockerignore.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const IGNORE_FILE = join(REPO, '.dockerignore');
const DOCKERFILE = join(REPO, 'Dockerfile');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const wantList = args.includes('--list');
const noIgnore = args.includes('--no-ignore');
const ctxArg = args.indexOf('--context');
// The tree whose files are uploaded. Defaults to this repo; --context lets the
// same rules be measured against a checkout that actually has node_modules.
const ROOT = ctxArg >= 0 ? resolve(args[ctxArg + 1]) : REPO;

const problems = [];
const fail = (code, message) => problems.push({ code, message });

// ---------------------------------------------------------------- 0. the file
// .dockerignore excludes BOTH itself and the Dockerfile, so a tree with neither
// is the inside of the image this Dockerfile builds, not a checkout. Wiring
// this check into an in-image step would otherwise fail on its own success.
if (!existsSync(DOCKERFILE) && !existsSync(IGNORE_FILE)) {
  console.log(
    `no Dockerfile and no .dockerignore under ${REPO} — this is not a checkout ` +
    'of this repo (most likely the inside of the image it builds, where both ' +
    'are excluded by design). Nothing to check.',
  );
  process.exit(0);
}
if (!existsSync(IGNORE_FILE) && !noIgnore) {
  fail(
    'no-dockerignore',
    'there is no .dockerignore, so `COPY . .` ships the developer\'s own ' +
      'node_modules/.angular/dist into the image, ON TOP of the tree npm ' +
      'install just resolved from package-lock.json. The image is then built ' +
      'from whatever happened to be on that disk. See #21.',
  );
}
const patterns = noIgnore || !existsSync(IGNORE_FILE)
  ? []
  : parseDockerignore(readFileSync(IGNORE_FILE, 'utf8'));

// ------------------------------------------------- 1. enumerate the context
/** @returns {string[]} every path Docker would upload, repo-relative. */
function walk(dirRel) {
  const out = [];
  const abs = dirRel === '.' ? ROOT : join(ROOT, dirRel);
  let entries;
  try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const rel = dirRel === '.' ? e.name : `${dirRel}/${e.name}`;
    const excluded = isExcluded(patterns, rel);
    if (e.isDirectory()) {
      // BuildKit skips an excluded directory unless an `!` line could
      // re-include something inside it. Doing the same is what keeps this
      // check from walking node_modules.
      if (excluded && !mayContainException(patterns, rel)) continue;
      out.push(...walk(rel));
      if (!excluded) out.push(`${rel}/`);
    } else if (!excluded) {
      out.push(rel);
    }
  }
  return out;
}
const context = walk('.').sort();
const contextFiles = context.filter((p) => !p.endsWith('/'));
const inContext = new Set(context.map((p) => p.replace(/\/$/, '')));

// --------------------------------------------------------- 2. FORBIDDEN half
const FORBIDDEN = [
  ['node_modules', (p) => p.split('/').includes('node_modules'),
    'the host\'s installed tree would overwrite the one npm install resolved from the lockfile — the #21 defect itself'],
  ['.git', (p) => p.split('/').includes('.git'),
    'tens of MB of context upload, and repository history has no business in an image layer'],
  ['.angular', (p) => p.split('/').includes('.angular'),
    'a stale Angular build cache from the developer\'s disk'],
  ['dist', (p) => p.split('/')[0] === 'dist',
    'a stale build output; the image builds its own into /app/dist'],
  ['out-tsc', (p) => p.split('/')[0] === 'out-tsc', 'stale tsc output'],
  ['coverage', (p) => p.split('/')[0] === 'coverage', 'local coverage output'],
  ['test-results', (p) => p.split('/').includes('test-results'), 'local test output'],
  ['*.log', (p) => p.endsWith('.log'), 'local log files'],
  ['.env*', (p) => /(^|\/)\.env($|\.)/.test(p) && !p.endsWith('.env.example'),
    'local secrets must never enter an image layer'],
];
for (const [label, hit, why] of FORBIDDEN) {
  const found = contextFiles.filter(hit);
  if (found.length) {
    fail('forbidden-in-context',
      `${found.length} path(s) matching ${label} are still in the build context ` +
      `(e.g. ${found.slice(0, 3).join(', ')}) — ${why}.`);
  }
}

// ---------------------------------------------------------- 3. REQUIRED half
// Parsed out of the Dockerfile so a COPY added later is covered without editing
// this list. `COPY --from=<stage>` reads the earlier STAGE, not the context.
const dockerfile = existsSync(DOCKERFILE) ? readFileSync(DOCKERFILE, 'utf8') : '';
const copySources = [];
for (const m of dockerfile.matchAll(/^\s*COPY\s+(.+)$/gim)) {
  let line = m[1].trim();
  if (/(^|\s)--from=/.test(line)) continue;
  const flags = [];
  line = line.replace(/(^|\s)--\S+/g, (s) => { flags.push(s.trim()); return ' '; });
  const words = line.split(/\s+/).filter(Boolean);
  if (words.length < 2) continue;
  copySources.push(...words.slice(0, -1));      // last word is the destination
}
// What the in-image RUN actually loads. These are read off package.json's
// build:login / i18n:* scripts and angular.json's esbuild target; if the build
// pipeline moves, this list has to move with it.
const BUILD_INPUTS = [
  'package.json', 'package-lock.json', 'angular.json',
  'tsconfig.json', 'tsconfig.app.json',
  'federation.config.js', 'federation-base.js',
  'src/main.ts', 'src/index.html', 'src/favicon.ico', 'src/styles.scss',
  'src/app', 'src/locale', 'src/locale/messages.xlf',
  'tools/i18n/check-catalogs.mjs', 'tools/i18n/emit-shipped-locales.mjs',
  'tools/i18n/build-catalogs.mjs', 'tools/i18n/xlf.mjs',
];

function contextMatches(glob) {
  const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
  if (g === '.' || g === '') return context.length ? ['.'] : [];
  if (inContext.has(g)) return [g];
  const re = compilePattern(g);
  return [...inContext].filter((p) => re.test(p));
}
for (const src of copySources) {
  if (!contextMatches(src).length) {
    fail('required-missing',
      `Dockerfile has \`COPY ${src}\` but .dockerignore removes it from the ` +
      `build context — the image build would fail on it.`);
  }
}
for (const req of BUILD_INPUTS) {
  if (!existsSync(join(ROOT, req))) continue;        // optional/moved: not our call
  if (!inContext.has(req)) {
    fail('required-missing',
      `\`${req}\` is read by the in-image build but .dockerignore removes it ` +
      `from the build context.`);
  }
}

// -------------------------------------------------------------- 4. reporting
const summary = {
  contextRoot: ROOT,
  dockerignore: noIgnore ? false : existsSync(IGNORE_FILE),
  patterns: patterns.length,
  contextFiles: contextFiles.length,
  contextBytes: contextFiles.reduce((n, p) => {
    try { return n + statSync(join(ROOT, p)).size; } catch { return n; }
  }, 0),
  copySources,
  problems,
};
if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  if (wantList) for (const p of contextFiles) console.log(p);
  console.log(
    `docker context (${ROOT}${noIgnore ? ', NO .dockerignore' : ''}): ` +
    `${summary.contextFiles} file(s), ` +
    `${(summary.contextBytes / 1048576).toFixed(1)} MiB, ` +
    `${summary.patterns} .dockerignore pattern(s)`,
  );
  for (const p of problems) console.error(`✗ [${p.code}] ${p.message}`);
  if (!problems.length) {
    console.log('✓ build context excludes every installed/derived tree and still carries every COPY source and build input');
  }
}
process.exit(problems.length ? 1 : 0);
