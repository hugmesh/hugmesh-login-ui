// Pins the .dockerignore SEMANTICS the #21 fix depends on. Every case here is a
// rule where .dockerignore differs from .gitignore or from plain globbing, and
// getting any of them wrong turns check-context.mjs into a guard that passes on
// a broken tree.
//
//   node --test "tools/docker/*.test.mjs"      (npm run docker:test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { parseDockerignore, isExcluded, cleanPattern, compilePattern } from './dockerignore.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ex = (text, path) => isExcluded(parseDockerignore(text), path);

test('a pattern with no slash matches ONLY at the root — the trap this fix exists for', () => {
  // .gitignore would exclude both. .dockerignore matches the whole relative
  // path, so a bare `node_modules` leaves e2e/node_modules in the image.
  assert.equal(ex('node_modules\n', 'node_modules/left-pad/index.js'), true);
  assert.equal(ex('node_modules\n', 'e2e/node_modules/left-pad/index.js'), false);
  // which is why the repo's file has to say **/node_modules:
  assert.equal(ex('**/node_modules\n', 'e2e/node_modules/left-pad/index.js'), true);
  assert.equal(ex('**/node_modules\n', 'node_modules/left-pad/index.js'), true);
});

test('* does not cross a separator; ** does', () => {
  assert.equal(ex('*.log\n', 'karma.log'), true);
  assert.equal(ex('*.log\n', 'node_modules/karma/local.log'), false);
  assert.equal(ex('**/*.log\n', 'node_modules/karma/local.log'), true);
});

test('excluding a directory excludes everything under it', () => {
  assert.equal(ex('dist\n', 'dist/login/browser/main.js'), true);
  assert.equal(ex('dist\n', 'src/dist-helper.ts'), false);
});

test('the LAST matching line wins, and ! is an exception', () => {
  assert.equal(ex('.env.*\n!.env.example\n', '.env.example'), false);
  assert.equal(ex('.env.*\n!.env.example\n', '.env.local'), true);
  // order matters: reversed, the exception is overridden again
  assert.equal(ex('!.env.example\n.env.*\n', '.env.example'), true);
});

test('comments and blank lines are not patterns', () => {
  assert.equal(ex('# node_modules\n\n', 'node_modules/x'), false);
});

test('leading slash and ./ are stripped, like filepath.Clean', () => {
  assert.equal(cleanPattern('/dist/'), 'dist');
  assert.equal(cleanPattern('./src/app'), 'src/app');
  assert.equal(ex('/dist\n', 'dist/login/main.js'), true);
});

test('regex metacharacters in a pattern are literal', () => {
  assert.ok(compilePattern('a.b').test('a.b'));
  assert.ok(!compilePattern('a.b').test('axb'));
});

test('this repo HAS a .dockerignore, and it keeps node_modules out at every depth', () => {
  const file = join(ROOT, '.dockerignore');
  assert.ok(existsSync(file), '.dockerignore is missing: `COPY . .` would ship the developer\'s node_modules (#21)');
  const pats = parseDockerignore(readFileSync(file, 'utf8'));
  for (const p of [
    'node_modules/@angular/core/index.js',
    'e2e/node_modules/@playwright/test/index.js',
    '.angular/cache/22.0.4/x.pack',
    'dist/login/browser/main.js',
    '.git/HEAD',
    'test-results/results.xml',
    '.env.local',
  ]) assert.equal(isExcluded(pats, p), true, `${p} should be excluded from the build context`);
});

test('and it still carries everything the image build reads', () => {
  const pats = parseDockerignore(readFileSync(join(ROOT, '.dockerignore'), 'utf8'));
  for (const p of [
    'package.json', 'package-lock.json', 'angular.json', 'tsconfig.app.json',
    'federation.config.js', 'federation-base.js', 'nginx.conf',
    'src/main.ts', 'src/index.html', 'src/app/app.component.ts',
    'src/locale/messages.xlf', 'tools/i18n/check-catalogs.mjs',
    'docker-entrypoint.d/40-snap-config.sh', 'docker-entrypoint.d/50-hug-theme.sh',
  ]) assert.equal(isExcluded(pats, p), false, `${p} must stay in the build context`);
});

test('check-context.mjs exits 0 on this tree and 1 with the rules removed', () => {
  const script = join(ROOT, 'tools', 'docker', 'check-context.mjs');
  execFileSync(process.execPath, [script], { stdio: 'pipe' });       // throws on non-zero
  assert.throws(
    () => execFileSync(process.execPath, [script, '--no-ignore'], { stdio: 'pipe' }),
    /status|Command failed/i,
    'with no ignore rules the checker must FAIL — otherwise it proves nothing',
  );
});
