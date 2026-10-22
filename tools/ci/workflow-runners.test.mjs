// Guard: pull request code never runs on a self-hosted runner.
//
// WHY. This repository is public. A workflow that triggers on pull_request (or
// pull_request_target) runs the pull request's code: `npm ci` runs package
// install scripts, `docker build` runs the PR's Dockerfile. A pull request from
// a fork is a stranger's code. A self-hosted runner is a real machine that
// belongs to a person, so a job that can be reached from a pull request must
// run on a GitHub-hosted runner, named by a literal label.
//
// What happened before this guard: ci.yml's jobs were switched to
// `runs-on: ${{ fromJSON(vars.RUNS_ON || '"ubuntu-latest"') }}` while the repo
// variable RUNS_ON held ["self-hosted","Linux","X64"]. Every pull request run
// would then have asked for the self-hosted runner. A repository variable can
// be changed without a review, so it is not an acceptable way to pick the
// runner for pull request jobs; this test refuses it.
//
// What it checks, for every file in .github/workflows/:
//   1. If the file triggers on pull_request or pull_request_target, every
//      `runs-on:` is a literal GitHub-hosted label (ubuntu-*, windows-*,
//      macos-*), and the file does not mention `self-hosted` or `vars.RUNS_ON`
//      outside comments.
//   2. release.yml (the publish workflow, which may use a self-hosted runner on
//      main through RUNS_ON_PUBLISH) has no pull_request trigger.
// It also checks that it really parsed ci.yml (five jobs, pull_request seen),
// so a parsing mistake cannot make it pass by finding nothing.
//
// Run: npm run ci:test (wired into pretest and prebuild).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WF_DIR = join(REPO_ROOT, '.github', 'workflows');

const UNTRUSTED_TRIGGERS = ['pull_request', 'pull_request_target'];
const HOSTED_LABEL = /^(ubuntu|windows|macos)-[A-Za-z0-9.]+$/;

/** Drop a YAML comment from one line, leaving `#` inside quotes alone. */
export function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line.replace(/\s+$/, '');
}

/** The text of the top-level `on:` key: its inline value plus its indented block. */
export function triggerText(src) {
  const lines = src.split('\n').map(stripComment);
  const start = lines.findIndex((l) => /^(on|"on"|'on'|true)\s*:/.test(l));
  if (start < 0) return '';
  const out = [lines[start].replace(/^[^:]*:/, '')];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) break; // next top-level key
    out.push(l);
  }
  return out.join('\n');
}

export function untrustedTriggers(src) {
  const text = triggerText(src);
  return UNTRUSTED_TRIGGERS.filter((t) => new RegExp(`(^|[^A-Za-z0-9_])${t}([^A-Za-z0-9_]|$)`, 'm').test(text));
}

/** Every `runs-on:` value in the file (comments removed). A block form yields ''. */
export function runsOnValues(src) {
  return src
    .split('\n')
    .map(stripComment)
    .map((l) => l.match(/^\s*runs-on\s*:\s*(.*)$/))
    .filter(Boolean)
    .map((m) => m[1].trim().replace(/^(["'])(.*)\1$/, '$2'));
}

/** Problems that make a pull-request-triggered workflow unsafe; [] when it is safe. */
export function problems(src) {
  if (untrustedTriggers(src).length === 0) return [];
  const found = [];
  for (const v of runsOnValues(src)) {
    if (!HOSTED_LABEL.test(v)) found.push(`runs-on is "${v}", not a literal GitHub-hosted label`);
  }
  const code = src.split('\n').map(stripComment).join('\n');
  if (/self-hosted/.test(code)) found.push('mentions self-hosted');
  if (/\bvars\.RUNS_ON\b/.test(code)) found.push('reads the RUNS_ON repository variable');
  return found;
}

function workflowFiles() {
  return readdirSync(WF_DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
}

test('the parser reads trigger forms and runs-on forms correctly', () => {
  assert.deepEqual(untrustedTriggers('on: [push, pull_request]\njobs: {}\n'), ['pull_request']);
  assert.deepEqual(untrustedTriggers('on: pull_request_target\n'), ['pull_request_target']);
  assert.deepEqual(untrustedTriggers('on:\n  push:\n  pull_request:\n    branches: [main]\njobs:\n  a:\n'), ['pull_request']);
  assert.deepEqual(untrustedTriggers('on:\n  push:\n    branches: [main]\n# pull_request\njobs:\n  pull_request:\n'), [],
    'a comment, or a job named pull_request, is not a trigger');
  assert.deepEqual(runsOnValues("    runs-on: ubuntu-latest # hosted\n    runs-on: 'ubuntu-24.04'\n    runs-on:\n"),
    ['ubuntu-latest', 'ubuntu-24.04', '']);
  assert.equal(stripComment("  x: 'a # b' # c"), "  x: 'a # b'");
});

test('the guard rejects every way a pull request job could reach a self-hosted runner', () => {
  const pr = 'on:\n  pull_request:\njobs:\n  a:\n';
  assert.deepEqual(problems(pr + '    runs-on: ubuntu-latest\n'), []);
  assert.notDeepEqual(problems(pr + "    runs-on: ${{ fromJSON(vars.RUNS_ON || '\"ubuntu-latest\"') }}\n"), []);
  assert.notDeepEqual(problems(pr + '    runs-on: [self-hosted, Linux, X64]\n'), []);
  assert.notDeepEqual(problems(pr + '    runs-on: self-hosted\n'), []);
  assert.notDeepEqual(problems(pr + '    runs-on:\n      group: Default\n'), [], 'a block runs-on is not a literal label');
  assert.notDeepEqual(problems(pr + '    runs-on: ${{ matrix.os }}\n'), []);
  // A workflow with no pull request trigger is not this guard's business.
  assert.deepEqual(problems('on:\n  push:\njobs:\n  a:\n    runs-on: [self-hosted]\n'), []);
});

test('ci.yml was really read: it triggers on pull_request and has five jobs', () => {
  const src = readFileSync(join(WF_DIR, 'ci.yml'), 'utf8');
  assert.deepEqual(untrustedTriggers(src), ['pull_request']);
  assert.equal(runsOnValues(src).length, 5, 'expected one runs-on per job: gates, unit, build, image, e2e-compile');
});

test('no workflow that pull requests can trigger runs on a self-hosted runner', () => {
  const files = workflowFiles();
  assert.ok(files.includes('ci.yml'), `ci.yml not found in ${WF_DIR}`);
  for (const f of files) {
    const p = problems(readFileSync(join(WF_DIR, f), 'utf8'));
    assert.deepEqual(p, [], `.github/workflows/${f}: ${p.join('; ')}`);
  }
});

test('release.yml (which may use a self-hosted runner) has no pull request trigger', () => {
  const p = join(WF_DIR, 'release.yml');
  assert.ok(existsSync(p), 'release.yml is missing');
  assert.deepEqual(untrustedTriggers(readFileSync(p, 'utf8')), [],
    'release.yml must never be triggered by a pull request: its jobs can run on the self-hosted runner');
});

test('ci:test is wired into pretest AND prebuild, so a pull request runs it', () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
  for (const hook of ['pretest', 'prebuild']) {
    assert.match(pkg.scripts[hook] ?? '', /\bnpm run ci:test\b/, `package.json scripts.${hook} must run ci:test`);
  }
  assert.match(pkg.scripts['ci:test'] ?? '', /tools\/ci\//);
});
