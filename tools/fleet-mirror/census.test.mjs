/**
 * The census guard's own tests — a MUTATION BATTERY, not a happy path.
 *
 *   node --test tools/fleet-mirror/        (or: npm run mirror:test)
 *
 * Every case builds a throw-away "fleet" of tiny git repositories under a temp
 * dir (each with an origin/main ref, the way a real checkout has one), points
 * census.mjs at it with its own readers.json, and asserts the EXIT CODE and the
 * message. The cases are the ways the guard could fail open:
 *   - a new reader in a production path                  -> must exit 1
 *   - a new reader hidden behind a NUL byte               -> must still exit 1
 *   - a new reader in an UNTRACKED file (--ref worktree)  -> must exit 1
 *   - a repo that is not checked out                      -> must exit 2 (blind spot)
 *   - a spec/e2e/doc mention                              -> info only (exit 0)
 *   - an acknowledged reader that migrated away           -> info; --strict exit 1
 *   - the writer deleted while readers remain             -> --self exit 1
 *   - the writer COMMENTED OUT while readers remain        -> --self exit 1
 *   - the writer's CALL SITE removed (dead code)           -> --self exit 1
 *   - --allow-missing over a fleet-root with no canary     -> must exit 2
 *   - a prefix acknowledgement broad enough to hide readers-> must exit 2
 *   - mirror:check unwired from pretest/prebuild           -> must fail
 * plus the pure classify()/diff()/orgDiff()/selfCheck() rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  classify, groupByFile, diff, orgDiff, selfCheck, parseGrep, loadManifest, scanRepo, checkCanary, ROLES, EXIT,
  DEFAULT_MANIFEST, DEFAULT_WRITER, stripComments, enclosingFunctionName, writerLiveness,
} from './census.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CENSUS = join(HERE, 'census.mjs');
const REPO_ROOT = join(HERE, '..', '..');
const KEY = 'hug.session';

// ---------------------------------------------------------------------------
// fixture helpers

function git(dir, ...args) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

/** A git repo with `files` committed on main and an origin/main ref pointing at it. */
function mkRepo(root, name, files) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main', '.');
  git(dir, 'config', 'user.email', 'census@test');
  git(dir, 'config', 'user.name', 'census');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeFiles(dir, files);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'fixture');
  publish(dir);
  return dir;
}

function writeFiles(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

/** Make HEAD the "remote default": origin/main + origin/HEAD, as a real clone has. */
function publish(dir) {
  git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
  git(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}

function commitAll(dir, msg) {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
  publish(dir);
}

const READER_SRC = `import { Injectable } from '@angular/core';\n@Injectable() export class SessionService {\n  private readonly key = '${KEY}';\n  load() { return localStorage.getItem(this.key); }\n}\n`;
const MIGRATED_SRC = `import { Injectable } from '@angular/core';\n@Injectable() export class SessionService {\n  async hydrate() { return fetch('/bff/session', { credentials: 'include' }); }\n}\n`;

/** A fleet: a writer repo, one acknowledged reader, one clean repo. */
function mkFleet() {
  const root = mkdtempSync(join(tmpdir(), 'fleet-mirror-'));
  mkRepo(root, 'login', { 'src/app/session.service.ts': `const FLEET_MIRROR_KEY = '${KEY}';\nlocalStorage.setItem(FLEET_MIRROR_KEY, 'x');\n` });
  mkRepo(root, 'reader', { 'src/app/session.service.ts': READER_SRC, 'README.md': `reads ${KEY}\n` });
  mkRepo(root, 'clean', { 'src/main.ts': 'console.log(1);\n' });
  const manifest = {
    key: KEY, repos: ['login', 'reader', 'clean'], ignoredRepos: { '.github': 'templates' },
    canary: { repo: 'login', file: 'src/app/session.service.ts' },
    acknowledged: [
      { repo: 'login', file: 'src/app/session.service.ts', role: 'writer' },
      { repo: 'reader', file: 'src/app/session.service.ts', role: 'reader' },
    ],
  };
  const manifestPath = join(root, 'readers.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { root, manifest, manifestPath, writer: join(root, 'login', 'src', 'app', 'session.service.ts') };
}

function run(fleet, ...args) {
  const r = spawnSync(process.execPath, [CENSUS, '--fleet-root', fleet.root, '--manifest', fleet.manifestPath, '--writer', fleet.writer, ...args], { encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

// ---------------------------------------------------------------------------
// pure rules

test('classify: only non-spec, non-e2e, non-doc paths are production', () => {
  assert.equal(classify('src/app/session.service.ts'), 'production');
  assert.equal(classify('projects/host/src/app/session.service.ts'), 'production');
  assert.equal(classify('.gitlab-ci.yml'), 'production');
  assert.equal(classify('tests/stack/.uidist/chunk-ABC.js'), 'production');
  assert.equal(classify('src/app/session.service.spec.ts'), 'test');
  assert.equal(classify('tools/i18n/web-locales.test.mjs'), 'test');
  assert.equal(classify('e2e/tests/helpers/roles.ts'), 'test');
  assert.equal(classify('e2e/features/auth/session-cookie.feature'), 'test');
  assert.equal(classify('README.md'), 'doc');
  assert.equal(classify('SECURITY.md'), 'doc');
  assert.equal(classify('content/reference/admin-ui.md'), 'doc');
  assert.equal(classify('docs/session.txt'), 'doc');
  // a production file whose NAME merely contains "e2e" or "spec" is still production
  assert.equal(classify('src/app/e2e-bridge.service.ts'), 'production');
  assert.equal(classify('src/app/spectrum.ts'), 'production');
});

test('parseGrep: -z records parse, the ref prefix is stripped, a colon in a path survives', () => {
  const out = `origin/main:src/a:b/s.ts\u0000` + `2\u0000const k = 'hug.session';\n` + `origin/main:src/n.ts\u0000` + `7\u0000x\n`;
  assert.deepEqual(parseGrep(out, 'origin/main:'), [
    { file: 'src/a:b/s.ts', line: 2, text: "const k = 'hug.session';" },
    { file: 'src/n.ts', line: 7, text: 'x' },
  ]);
  assert.deepEqual(parseGrep('', 'origin/main:'), []);
});

test('diff: new production file fails, mentions and migrated are informational', () => {
  const manifest = {
    key: KEY, repos: ['a', 'b', 'g'], ignoredRepos: {},
    canary: { repo: 'a', file: 'src/s.ts' },
    acknowledged: [
      { repo: 'a', file: 'src/s.ts', role: 'reader' },
      { repo: 'b', file: 'src/old.ts', role: 'reader' },
      { repo: 'g', prefix: 'dist/', role: 'artifact' },
    ],
  };
  const census = [
    { repo: 'a', files: [
      { file: 'src/s.ts', kind: 'production', lines: [{ line: 1, text: '' }] },
      { file: 'src/new.ts', kind: 'production', lines: [{ line: 1, text: '' }] },
      { file: 'src/s.spec.ts', kind: 'test', lines: [{ line: 1, text: '' }] },
    ] },
    { repo: 'b', files: [] },
    { repo: 'g', files: [{ file: 'dist/chunk-XYZ.js', kind: 'production', lines: [{ line: 1, text: '' }] }] },
  ];
  const d = diff(census, manifest);
  assert.deepEqual(d.newReaders.map((n) => `${n.repo}/${n.file}`), ['a/src/new.ts']);
  assert.deepEqual(d.migrated.map((m) => `${m.repo}/${m.file}`), ['b/src/old.ts']);
  assert.deepEqual(d.mentions.map((m) => `${m.repo}/${m.file}`), ['a/src/s.spec.ts']);
});

test('diff: an acknowledged entry in a repo that was NOT scanned is not reported as migrated', () => {
  const manifest = { key: KEY, repos: ['a', 'missing'], ignoredRepos: {}, canary: { repo: 'missing', file: 'src/s.ts' }, acknowledged: [{ repo: 'missing', file: 'src/s.ts', role: 'reader' }] };
  const d = diff([{ repo: 'a', files: [] }], manifest);
  assert.equal(d.migrated.length, 0, 'a blind spot must not read as progress');
});

test('orgDiff: org repos neither scanned nor ignored are reported', () => {
  const manifest = { repos: ['a', 'b'], ignoredRepos: { '.github': 'x' } };
  assert.deepEqual(orgDiff(['b', 'new-ui', 'a', '.github'], manifest), ['new-ui']);
});

test('loadManifest: rejects an acknowledged repo the census never scans, an unknown role, file+prefix', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-manifest-'));
  const CAN = { repo: 'a', file: 'f' };
  const write = (m) => { const p = join(root, 'r.json'); writeFileSync(p, JSON.stringify(m)); return p; };
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: CAN, acknowledged: [{ repo: 'zz', file: 'f', role: 'reader' }] })), /never scan/);
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: CAN, acknowledged: [{ repo: 'a', file: 'f', role: 'consumer' }] })), /unknown role/);
  // BOTH file and prefix: the bare `&&` compared the strings 'f' and 'p', so this validated clean
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: CAN, acknowledged: [{ repo: 'a', file: 'f', prefix: 'p', role: 'reader' }] })), /exactly one/);
  // NEITHER file nor prefix
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: CAN, acknowledged: [{ repo: 'a', role: 'reader' }] })), /exactly one/);
  assert.throws(() => loadManifest(write({ key: '', repos: ['a'], canary: CAN, acknowledged: [] })), /"key"/);
  // the canary itself is validated: absent, unscanned repo, or unacknowledged
  const ack = [{ repo: 'a', file: 'f', role: 'reader' }];
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], acknowledged: ack })), /"canary"/);
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: { repo: 'zz', file: 'f' }, acknowledged: ack })), /canary repo/);
  assert.throws(() => loadManifest(write({ key: KEY, repos: ['a'], canary: { repo: 'a', file: 'other' }, acknowledged: ack })), /not acknowledged/);
  rmSync(root, { recursive: true, force: true });
});

test('selfCheck: writer gone + blocking reader = FAIL; writer gone + none = OK; writer present = OK', () => {
  const blocking = { key: KEY, repos: ['r'], canary: { repo: 'r', file: 'f' }, acknowledged: [{ repo: 'r', file: 'f', role: 'reader' }] };
  const hydrates = { key: KEY, repos: ['r'], canary: { repo: 'r', file: 'f' }, acknowledged: [{ repo: 'r', file: 'f', role: 'reader+hydrates' }] };
  const nonBlocking = { key: KEY, repos: ['r'], canary: { repo: 'r', file: 'f' }, acknowledged: [{ repo: 'r', file: 'f', role: 'comment' }, { repo: 'r', file: 'g', role: 'writer' }, { repo: 'r', prefix: 'dist/chunks/', role: 'artifact' }] };
  const writer = `const FLEET_MIRROR_KEY = 'hug.session';\nlocalStorage.setItem(FLEET_MIRROR_KEY, next);`;
  const inlined = `localStorage.setItem('hug.session', next);`;
  const gone = `// the mirror used to live here`;
  assert.equal(selfCheck(writer, blocking).ok, true);
  assert.equal(selfCheck(inlined, blocking).ok, true, 'an inlined key literal is still a write');
  assert.equal(selfCheck(gone, blocking).ok, false);
  assert.match(selfCheck(gone, blocking).message, /PR #17 regression/);
  assert.equal(selfCheck(gone, hydrates).ok, false, 'reader+hydrates still blocks');
  assert.equal(selfCheck(gone, nonBlocking).ok, true, 'comment/writer/artifact entries never block');
  assert.equal(selfCheck(writer, nonBlocking).ok, true);
  assert.match(selfCheck(writer, nonBlocking).message, /may now be deleted/);
  // a getItem alone is not a write
  assert.equal(selfCheck(`const k = 'hug.session'; localStorage.getItem(k);`, blocking).ok, false);
});

test('ROLES: exactly reader and reader+hydrates block', () => {
  assert.deepEqual(Object.entries(ROLES).filter(([, v]) => v.blocking).map(([k]) => k).sort(), ['reader', 'reader+hydrates']);
});

// ---------------------------------------------------------------------------
// the guard end to end against a throw-away fleet

test('baseline fleet: exit 0, every acknowledged reader seen', () => {
  const f = mkFleet();
  const r = run(f);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /newReaders=0 migrated=0/);
  assert.match(r.out, /blockingReadersRemaining=1/);
  rmSync(f.root, { recursive: true, force: true });
});

test('a NEW production reader in an existing repo -> exit 1 and it is named', () => {
  const f = mkFleet();
  writeFiles(join(f.root, 'clean'), { 'src/app/sneaky.service.ts': READER_SRC });
  commitAll(join(f.root, 'clean'), 'add reader');
  const r = run(f);
  assert.equal(r.code, EXIT.DRIFT, r.out + r.err);
  assert.match(r.out, /NEW READER clean\/src\/app\/sneaky\.service\.ts/);
  rmSync(f.root, { recursive: true, force: true });
});

test('a NEW reader hidden behind a NUL byte is still found (git grep --text)', () => {
  const f = mkFleet();
  // A NUL byte before the match makes GNU grep treat the file as binary and
  // skip it; git grep --text must not. NOTE the \u0000 ESCAPE: writing a
  // literal NUL byte here would make THIS file binary to git (unreviewable
  // diffs) and would make a plain `grep` over this repo skip it entirely —
  // the very failure the test exists to pin. Pinned by the last test below.
  writeFiles(join(f.root, 'clean'), { 'src/app/binaryish.ts': `\u0000\n${READER_SRC}` });
  commitAll(join(f.root, 'clean'), 'add nul reader');
  const r = run(f);
  assert.equal(r.code, EXIT.DRIFT, r.out + r.err);
  assert.match(r.out, /NEW READER clean\/src\/app\/binaryish\.ts/);
  rmSync(f.root, { recursive: true, force: true });
});

test('the census reads origin/<default>, NOT the checkout branch: an unpublished reader is invisible; --ref worktree sees it (and untracked files)', () => {
  const f = mkFleet();
  const clean = join(f.root, 'clean');
  writeFiles(clean, { 'src/app/local-only.ts': READER_SRC });
  git(clean, 'add', '-A');
  git(clean, 'commit', '-q', '-m', 'local branch work (not on origin/main)');
  assert.equal(run(f).code, EXIT.OK, 'origin/main has no reader yet');
  const wt = run(f, '--ref', 'worktree');
  assert.equal(wt.code, EXIT.DRIFT, wt.out + wt.err);
  writeFiles(clean, { 'src/app/untracked.ts': READER_SRC });
  const wt2 = run(f, '--ref', 'worktree');
  assert.match(wt2.out, /NEW READER clean\/src\/app\/untracked\.ts/);
  rmSync(f.root, { recursive: true, force: true });
});

test('a spec / e2e / README mention is reported, never failed', () => {
  const f = mkFleet();
  writeFiles(join(f.root, 'clean'), {
    'src/app/x.spec.ts': `localStorage.setItem('${KEY}', '{}');\n`,
    'e2e/tests/helpers/roles.ts': `export const SESSION_KEY = '${KEY}';\n`,
    'README.md': `mentions ${KEY}\n`,
  });
  commitAll(join(f.root, 'clean'), 'mentions');
  const r = run(f, '--verbose');
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /mentions=4/); // reader/README.md + these three
  assert.match(r.out, /\[test\] e2e\/tests\/helpers\/roles\.ts:1/);
  rmSync(f.root, { recursive: true, force: true });
});

test('an acknowledged reader that migrated away: INFO + exit 0; --strict exit 1', () => {
  const f = mkFleet();
  writeFiles(join(f.root, 'reader'), { 'src/app/session.service.ts': MIGRATED_SRC });
  commitAll(join(f.root, 'reader'), 'migrate to /bff/session');
  const r = run(f);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /INFO MIGRATED reader\/src\/app\/session\.service\.ts \(reader\)/);
  assert.match(r.out, /blockingReadersRemaining=0/);
  const s = run(f, '--strict');
  assert.equal(s.code, EXIT.DRIFT, s.out + s.err);
  assert.match(s.out, /ERROR MIGRATED/);
  rmSync(f.root, { recursive: true, force: true });
});

test('a repo that is not checked out is a blind spot: exit 2; --allow-missing warns and continues', () => {
  const f = mkFleet();
  rmSync(join(f.root, 'clean'), { recursive: true, force: true });
  const r = run(f);
  assert.equal(r.code, EXIT.ERROR, r.out + r.err);
  assert.match(r.out, /ERROR clean: not checked out/);
  const a = run(f, '--allow-missing');
  assert.equal(a.code, EXIT.OK, a.out + a.err);
  assert.match(a.out, /WARN clean: not checked out/);
  rmSync(f.root, { recursive: true, force: true });
});

test('a blind spot never masks drift: missing repo + new reader elsewhere -> exit 2 (not 0), --allow-missing -> exit 1', () => {
  const f = mkFleet();
  rmSync(join(f.root, 'clean'), { recursive: true, force: true });
  writeFiles(join(f.root, 'reader'), { 'src/app/second.ts': READER_SRC });
  commitAll(join(f.root, 'reader'), 'second reader');
  assert.equal(run(f).code, EXIT.ERROR);
  assert.equal(run(f, '--allow-missing').code, EXIT.DRIFT);
  rmSync(f.root, { recursive: true, force: true });
});

test('a prefix acknowledgement covers hashed artefact names', () => {
  const f = mkFleet();
  writeFiles(join(f.root, 'clean'), { 'dist/chunks/chunk-ABC123.js': `x=${JSON.stringify(KEY)};`, 'dist/chunks/chunk-DEF456.js': `y=${JSON.stringify(KEY)};` });
  commitAll(join(f.root, 'clean'), 'artefacts');
  f.manifest.acknowledged.push({ repo: 'clean', prefix: 'dist/chunks/', role: 'artifact' });
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const r = run(f);
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  assert.match(r.out, /\[artifact\] dist\/chunks\/chunk-ABC123\.js:1/);
  rmSync(f.root, { recursive: true, force: true });
});

test('--self: writer present -> 0; writer deleted while a blocking reader remains -> 1; writer deleted with no blocking reader -> 0', () => {
  const f = mkFleet();
  assert.equal(run(f, '--self').code, EXIT.OK);
  writeFileSync(f.writer, '// publishMirror() deleted\n');
  const r = run(f, '--self');
  assert.equal(r.code, EXIT.DRIFT, r.out + r.err);
  assert.match(r.out, /FAIL/);
  assert.match(r.out, /blocking: reader\/src\/app\/session\.service\.ts \(reader\)/);
  f.manifest.acknowledged = f.manifest.acknowledged.filter((e) => e.role !== 'reader');
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  assert.equal(run(f, '--self').code, EXIT.OK);
  rmSync(f.root, { recursive: true, force: true });
});

test('--self never needs a sibling checkout', () => {
  const f = mkFleet();
  rmSync(join(f.root, 'reader'), { recursive: true, force: true });
  rmSync(join(f.root, 'clean'), { recursive: true, force: true });
  assert.equal(run(f, '--self').code, EXIT.OK);
  rmSync(f.root, { recursive: true, force: true });
});

test('checkCanary: holds when the file matched, fails when it did not, silent when the repo was not scanned', () => {
  const manifest = { key: KEY, canary: { repo: 'login', file: 'src/app/session.service.ts' } };
  const hit = [{ repo: 'login', ref: 'origin/main', sha: 'a'.repeat(40), files: [{ file: 'src/app/session.service.ts', kind: 'production', lines: [] }] }];
  const miss = [{ repo: 'login', ref: 'origin/main', sha: 'a'.repeat(40), files: [] }];
  assert.equal(checkCanary(hit, manifest), null);
  assert.match(checkCanary(miss, manifest), /CANARY FAILED/);
  assert.equal(checkCanary([{ repo: 'other', files: [] }], manifest), null, 'a repo that was not scanned is a blind spot, reported elsewhere');
});

test('a key that matches NOTHING is exit 2, not a green "everyone migrated"', () => {
  // The measured fail-open (2026-09-17): one typo in `key` turned the real
  // census into `newReaders=0 migrated=22 -> exit 0` — a clean pass over a scan
  // that searched for a string nothing contains.
  const f = mkFleet();
  f.manifest.key = `${KEY}XYZ`;
  writeFileSync(f.manifestPath, JSON.stringify(f.manifest));
  const r = run(f);
  assert.equal(r.code, EXIT.ERROR, r.out + r.err);
  assert.match(r.out, /CANARY FAILED: login\/src\/app\/session\.service\.ts/);
  // and --strict must not downgrade it to plain drift
  assert.equal(run(f, '--strict').code, EXIT.ERROR);
  rmSync(f.root, { recursive: true, force: true });
});

test('a --fleet-root of unrelated-but-present clones is exit 2, not a green census', () => {
  const f = mkFleet();
  // the canary repo exists and is a git repo, but its writer no longer names the key
  writeFiles(join(f.root, 'login'), { 'src/app/session.service.ts': MIGRATED_SRC });
  commitAll(join(f.root, 'login'), 'writer no longer names the key');
  const r = run(f);
  assert.equal(r.code, EXIT.ERROR, r.out + r.err);
  assert.match(r.out, /CANARY FAILED/);
  rmSync(f.root, { recursive: true, force: true });
});

test('THIS repo: the real canary holds against the real fleet writer', () => {
  const manifest = loadManifest(DEFAULT_MANIFEST);
  assert.equal(manifest.canary.repo, 'hugmesh-login-ui');
  const src = readFileSync(DEFAULT_WRITER, 'utf8');
  assert.ok(src.includes(manifest.key), `the canary file ${manifest.canary.file} must contain '${manifest.key}'`);
  assert.equal(manifest.canary.file, 'src/app/session.service.ts');
});

test('a malformed readers.json is exit 2, never a silent pass', () => {
  const f = mkFleet();
  writeFileSync(f.manifestPath, '{"key":"hug.session","repos":["login"],"acknowledged":[{"repo":"ghost","file":"x","role":"reader"}]}');
  assert.equal(run(f).code, EXIT.ERROR);
  assert.equal(run(f, '--self').code, EXIT.ERROR);
  writeFileSync(f.manifestPath, '{not json');
  assert.equal(run(f, '--self').code, EXIT.ERROR);
  rmSync(f.root, { recursive: true, force: true });
});

test('--json emits the per-repo SHAs and the same verdict', () => {
  const f = mkFleet();
  const r = run(f, '--json');
  assert.equal(r.code, EXIT.OK, r.out + r.err);
  const j = JSON.parse(r.out);
  assert.equal(j.exit, 0);
  assert.equal(j.repos.length, 3);
  assert.ok(j.repos.every((x) => /^[0-9a-f]{40}$/.test(x.sha) && x.ref === 'origin/main'), 'every repo scanned at its origin/main SHA');
  rmSync(f.root, { recursive: true, force: true });
});

test('scanRepo: a checkout with no origin/HEAD falls back with a WARNING, never silently', () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-noorigin-'));
  const dir = mkRepo(root, 'r', { 'src/s.ts': READER_SRC });
  git(dir, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
  const s1 = scanRepo(dir, KEY);
  assert.equal(s1.ref, 'origin/main');
  assert.equal(s1.warnings.length, 1);
  git(dir, 'update-ref', '-d', 'refs/remotes/origin/main');
  const s2 = scanRepo(dir, KEY);
  assert.equal(s2.ref, 'HEAD');
  assert.equal(s2.warnings.length, 2);
  assert.equal(s2.files.length, 1);
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// this repo's real state (no siblings needed)

test('THIS repo: readers.json is valid and the real writer passes --self', () => {
  const manifest = loadManifest(DEFAULT_MANIFEST);
  const src = readFileSync(DEFAULT_WRITER, 'utf8');
  const res = selfCheck(src, manifest);
  assert.equal(res.ok, true, res.message);
  assert.equal(res.writerPresent, true, 'src/app/session.service.ts must still write the fleet mirror while readers.json lists blocking readers');
  assert.ok(manifest.acknowledged.some((e) => e.repo === 'hugmesh-login-ui' && e.role === 'writer'), 'this repo acknowledges itself as the writer');
});

test('THIS repo: every tracked production file naming the key is acknowledged in readers.json', () => {
  // The full census scans this repo too (it is in readers.json#repos). Measured
  // 2026-10-15: the Dockerfile, the CI workflow, census.mjs and readers.json
  // were not acknowledged, so the full census reported four NEW READERs in the
  // guard's own repo. --self cannot see that (it never diffs), and the full
  // census needs the sibling checkouts, so this is the only place it is caught
  // without them.
  const manifest = loadManifest(DEFAULT_MANIFEST);
  const root = join(HERE, '..', '..');
  const r = spawnSync('git', ['grep', '--text', '-n', '-z', '-F', manifest.key], { cwd: root, encoding: 'utf8' });
  assert.ok(r.status === 0 || r.status === 1, `git grep failed: ${r.stderr}`);
  const files = groupByFile(parseGrep(r.stdout, '')).filter((f) => f.kind === 'production');
  assert.ok(files.some((f) => f.file === 'src/app/session.service.ts'), 'the scan must see the writer, or it is blind');
  const mine = manifest.acknowledged.filter((e) => e.repo === 'hugmesh-login-ui');
  const unacknowledged = files
    .filter((f) => !mine.some((e) => (e.file ? e.file === f.file : f.file.startsWith(e.prefix))))
    .map((f) => f.file);
  assert.deepEqual(unacknowledged, [], 'acknowledge these in readers.json with a role');
});

test('the tooling role does not block retiring the mirror', () => {
  assert.equal(ROLES.tooling.blocking, false);
});

test('this test file contains no LITERAL NUL byte (it would blind grep to itself)', () => {
  // Measured: with five literal NULs in it, `git diff` rendered this file as
  // "Bin 0 -> 22768 bytes" and `grep -c 'NEW READER' census.test.mjs` exited 1
  // with no output while `grep -a` found 3 — a plain-grep audit of this repo
  // was silently blind to the fleet-mirror guard's own tests. The NUL the NUL
  // test needs is written as a \u0000 escape instead.
  const raw = readFileSync(fileURLToPath(import.meta.url));
  assert.equal(raw.indexOf(0), -1, 'write NUL as a \\u0000 escape, never as a literal byte');
});

// ---------------------------------------------------------------------------
// LIVENESS — a marker match proves the bytes are in the file, not that the
// write happens. Both cases below were measured green against the text-only
// check that shipped on 2026-09-17, which is why they are here.

/** A writer with the real shape: the setItem sits in a method, called from another. */
const CLASS_WRITER_SRC = [
  "const FLEET_MIRROR_KEY = 'hug.session';",
  'export class SessionService {',
  '  private setSession(s) {',
  '    this.session.set(s);',
  '    this.publishMirror(s);',
  '  }',
  '  /** Publish the session to the {@link FLEET_MIRROR_KEY} mirror. */',
  '  private publishMirror(s) {',
  '    const next = s ? JSON.stringify(s) : null;',
  '    if (next === null) localStorage.removeItem(FLEET_MIRROR_KEY);',
  '    else localStorage.setItem(FLEET_MIRROR_KEY, next);',
  '  }',
  '}',
].join('\n');

test('stripComments: comments go; string and template literals survive intact', () => {
  assert.equal(stripComments('a // gone\nb'), 'a \nb');
  assert.equal(stripComments('a /* gone */ b'), 'a  b');
  assert.equal(stripComments('a /* one\ntwo */ b'), 'a \n b');
  assert.equal(stripComments(`const u = 'http://x//y';`), `const u = 'http://x//y';`, 'a // inside a string is not a comment');
  assert.equal(stripComments('const t = `a /* b */ c`;'), 'const t = `a /* b */ c`;');
  assert.equal(stripComments(`const q = 'it\\'s // fine';`), `const q = 'it\\'s // fine';`, 'an escaped quote does not end the string');
  // line count is preserved so an offset stays on its own line
  assert.equal(stripComments('x\n/* a\nb\nc */\ny').split('\n').length, 5);
});

test('enclosingFunctionName: method, arrow, nested block, class body, top level', () => {
  const src = CLASS_WRITER_SRC;
  assert.equal(enclosingFunctionName(src, src.indexOf('localStorage.setItem')), 'publishMirror');
  assert.equal(enclosingFunctionName(src, src.indexOf('this.publishMirror')), 'setSession');
  assert.equal(enclosingFunctionName(src, src.indexOf('const FLEET_MIRROR_KEY')), null, 'top level');
  // an if/for block is walked THROUGH, not mistaken for the function
  const nested = 'function outer(a) {\n  if (a) {\n    for (const x of a) {\n      HERE;\n    }\n  }\n}';
  assert.equal(enclosingFunctionName(nested, nested.indexOf('HERE')), 'outer');
  // a class body is not a function head
  const cls = 'class Foo {\n  bar() {\n    HERE;\n  }\n}';
  assert.equal(enclosingFunctionName(cls, cls.indexOf('HERE')), 'bar');
  const arrow = 'const publish = (s) => {\n  HERE;\n};';
  assert.equal(enclosingFunctionName(arrow, arrow.indexOf('HERE')), 'publish');
});

test('writerLiveness: a write nothing calls is NOT a live write', () => {
  assert.equal(writerLiveness(stripComments(CLASS_WRITER_SRC)).live, true);
  assert.equal(writerLiveness(stripComments(CLASS_WRITER_SRC)).fn, 'publishMirror');
  const deadCode = CLASS_WRITER_SRC.replace('    this.publishMirror(s);', '    // this.publishMirror(s);');
  const dead = writerLiveness(stripComments(deadCode));
  assert.equal(dead.live, false);
  assert.match(dead.reason, /nothing calls it/);
  // module-level code needs no call site
  assert.equal(writerLiveness("localStorage.setItem('hug.session', v);").live, true);
});

test('--self: the write COMMENTED OUT is not a write (skeptic mutation a)', () => {
  const f = mkFleet();
  writeFileSync(f.writer, CLASS_WRITER_SRC);
  assert.equal(run(f, '--self').code, EXIT.OK, 'baseline: the class-shaped writer passes');
  writeFileSync(f.writer, CLASS_WRITER_SRC.replace(
    '    else localStorage.setItem(FLEET_MIRROR_KEY, next);',
    '    // else localStorage.setItem(FLEET_MIRROR_KEY, next);'));
  const r = run(f, '--self');
  assert.equal(r.code, EXIT.DRIFT, r.out + r.err);
  assert.match(r.out, /FAIL/);
  assert.match(r.out, /localStorage\.setItem/);
  rmSync(f.root, { recursive: true, force: true });
});

test('--self: the CALL SITE commented out leaves dead code, not a write (skeptic mutation b)', () => {
  const f = mkFleet();
  writeFileSync(f.writer, CLASS_WRITER_SRC.replace(
    '    this.publishMirror(s);', '    // this.publishMirror(s);'));
  const r = run(f, '--self');
  assert.equal(r.code, EXIT.DRIFT, r.out + r.err);
  assert.match(r.out, /FAIL/);
  assert.match(r.out, /a live write/);
  assert.match(r.out, /publishMirror\(\) holds the write but nothing calls it/);
  rmSync(f.root, { recursive: true, force: true });
});

test('--allow-missing may NOT skip the canary repo: a fleet-root of nothing is exit 2, not a green census', () => {
  const f = mkFleet();
  const empty = mkdtempSync(join(tmpdir(), 'fleet-empty-'));
  const r = run(f, '--fleet-root', empty, '--allow-missing');
  assert.equal(r.code, EXIT.ERROR, r.out + r.err);
  assert.match(r.out, /CANARY NOT SCANNED/);
  rmSync(empty, { recursive: true, force: true });
  rmSync(f.root, { recursive: true, force: true });
});

test('loadManifest: a prefix broad enough to blanket a source tree is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'manifest-prefix-'));
  const write = (m) => { const fp = join(root, 'm.json'); writeFileSync(fp, JSON.stringify(m)); return fp; };
  const base = (prefix) => ({
    key: KEY, repos: ['a'], canary: { repo: 'a', file: 'f' },
    acknowledged: [{ repo: 'a', file: 'f', role: 'reader' }, { repo: 'a', prefix, role: 'artifact' }],
  });
  assert.throws(() => loadManifest(write(base('src/'))), /too broad/);
  assert.throws(() => loadManifest(write(base('projects/'))), /too broad/);
  assert.throws(() => loadManifest(write(base('dist/chunks'))), /too broad/, 'must end with a slash');
  assert.ok(loadManifest(write(base('tests/stack/.uidist/'))), 'a specific prefix is still allowed');
  rmSync(root, { recursive: true, force: true });
});

test('mirror:check is wired into pretest AND prebuild, not just the image build', () => {
  // THE ENFORCEMENT POINT. Measured 2026-09-17: build:image (and the Dockerfile
  // RUN chain) is reachable only from .gitlab-ci.yml's build:image job, whose
  // rules are `$CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH` or `$CI_COMMIT_TAG` —
  // merge_request_event is absent. So with the check reachable only from there,
  // a pull request shaped exactly like PR #17 (delete the write plus its spec
  // assertions) merges GREEN and the guard first fires in the post-merge image
  // build, after the regression is on main. README.md documents the identical
  // finding for federation:check. Do not unwire these.
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const hook of ['pretest', 'prebuild']) {
    assert.match(pkg.scripts[hook] ?? '', /\bmirror:check\b/, `package.json scripts.${hook} must run mirror:check`);
  }
  assert.match(pkg.scripts['build:image'] ?? '', /\bmirror:check\b/);
  assert.match(pkg.scripts['mirror:check'] ?? '', /--self/);
});

test('THIS repo: the real writer is LIVE, not merely present', () => {
  const src = readFileSync(DEFAULT_WRITER, 'utf8');
  const live = writerLiveness(stripComments(src));
  assert.equal(live.live, true, live.reason);
  assert.equal(live.fn, 'publishMirror', 'the setItem still sits in publishMirror()');
  assert.match(live.reason, /is called \d+ time\(s\)/);
});
