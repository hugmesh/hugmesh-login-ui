#!/usr/bin/env node
/**
 * The `hug.session` FLEET-MIRROR CENSUS — the guard for hugmesh-login-ui #18.
 *
 *   npm run mirror:census     full census over the sibling checkouts (local / pre-push)
 *   npm run mirror:check      --self: THIS repo only; runs inside the image build
 *   npm run mirror:test       the guard's own tests (node --test)
 *
 * WHAT IT GUARDS. This remote writes `localStorage['hug.session']`
 * (src/app/session.service.ts: FLEET_MIRROR_KEY / publishMirror) for the fleet
 * remotes that still load their WHOLE session from that key. Retiring that
 * write once (PR #17, 2026-09-02) signed every role-home out immediately after a
 * successful sign-in, because the readers live in OTHER repos and nothing in
 * this repo could see them; PR #19 put the write back. readers.json is the
 * MEASURED list of those readers, and this script keeps it honest both ways:
 *
 *   FULL CENSUS (default)  scans every repo in readers.json#repos — at its
 *     origin/<default> tree, so a stale or switched checkout cannot skew it —
 *     for the key literal. A PRODUCTION file (anything that is not a spec / e2e
 *     / doc path, see classify()) that readers.json does not acknowledge is a
 *     NEW READER -> exit 1. An acknowledged file that no longer matches is
 *     reported as MIGRATED (exit 0; --strict turns it into exit 1 so
 *     readers.json gets pruned). Spec / e2e / doc mentions are listed, never
 *     failed: nothing in them runs in a user's browser. A repo that is not
 *     checked out is a BLIND SPOT -> exit 2 (fail closed; --allow-missing
 *     downgrades it to a warning). --org asks `gh` for the org's repository
 *     list and fails on any repo readers.json never scans.
 *
 *   SELF CHECK (--self)  needs no sibling checkout, so it runs in the image
 *     build AND — since 2026-09-17 — in `pretest`/`prebuild`, so a PULL REQUEST
 *     is where it fires, not the post-merge image build (see package.json and
 *     README "It is wired into pretest and prebuild"). While readers.json still
 *     acknowledges a BLOCKING reader (role "reader" or "reader+hydrates"),
 *     src/app/session.service.ts must still write the mirror, and the write must
 *     be LIVE: the source is comment-stripped first, and the function holding
 *     the setItem must actually be called. Measured 2026-09-17 — against a
 *     text-only check, commenting out `localStorage.setItem(FLEET_MIRROR_KEY,
 *     next)` OR commenting out its `this.publishMirror(s)` call site both left
 *     the writer "present" and exited 0 while the mirror was never written.
 *     Deleting publishMirror() before that list is empty is exactly the #17
 *     regression, and this is the check #17 did not have.
 *
 * WHY `git grep --text`. GNU grep skips a file that contains a NUL byte and
 * exits 1 — indistinguishable from a genuine miss — so a grep-based audit fails
 * OPEN on one binary-looking file. `git grep --text` searches it anyway. Only
 * TRACKED files of the named tree are searched (node_modules / dist never are),
 * so this is a census of what each repo SHIPS, not of what sits in a checkout.
 *
 * LIMITS, stated. The scan is a literal search for the key: a reader that
 * assembles it from pieces ('hug' + '.session') is invisible, and so is a
 * reader in a repo readers.json does not list (--org covers the org, not a
 * clone someone made outside it). Comment-only mentions in production paths
 * match too — in the CENSUS direction they are acknowledged with role "comment"
 * rather than stripped, because there an over-strip HIDES a reader (fails open).
 * The --self direction is the mirror image — there an over-strip only raises a
 * false alarm — so it does strip, see stripComments(). The census also reads
 * each sibling's LOCAL origin/<default> ref and never fetches: a sibling whose
 * origin ref is stale narrows the scan while still printing an authoritative
 * SHA, so fetch the fleet before trusting a census (measured 2026-09-17:
 * 39/39 local origin refs equalled the true remote head on that box, which is a
 * property of that box on that day, not of this tool).
 *
 * Exit codes: 0 clean · 1 drift (new reader; with --strict any drift; --self
 * writer missing while readers remain) · 2 usage / environment error (a
 * missing checkout, a git failure, a malformed readers.json, a FAILED CANARY —
 * see checkCanary: a scan that matches nothing is not a migrated fleet).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, '..', '..');
export const DEFAULT_MANIFEST = join(HERE, 'readers.json');
export const DEFAULT_WRITER = join(REPO_ROOT, 'src', 'app', 'session.service.ts');
export const DEFAULT_ORG = 'hugmesh';

/** Every role readers.json may assign, and which of them BLOCK the retirement. */
export const ROLES = Object.freeze({
  /** Loads its whole session from the key; no `/bff/session` read at all. */
  'reader': { blocking: true },
  /** Seeds from / falls back to the key, but also hydrates from `/bff/session`. */
  'reader+hydrates': { blocking: true },
  /** Writes the key (besides login-ui). Does not need login-ui's write to exist. */
  'writer': { blocking: false },
  /** The literal appears in a production path but only inside a comment. */
  'comment': { blocking: false },
  /** Build, CI or guard files of the writer repo that name the key as text. */
  'tooling': { blocking: false },
  /** A committed BUILD ARTEFACT (compiled bundle) that embeds the literal. */
  'artifact': { blocking: false },
});

export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, ERROR: 2 });

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly).

/**
 * Where does a matching path sit? Only 'production' can be a runtime reader.
 * Path-based on purpose: a spec, an e2e step or a README never executes in a
 * user's browser, whatever it says. Everything else is production until
 * readers.json says otherwise — the guard errs towards a false NEW READER,
 * never towards a missed one.
 */
export function classify(path) {
  const p = path.replace(/\\/g, '/');
  if (/(^|\/)e2e\//.test(p)) return 'test';
  if (/\.(spec|test)\.[cm]?[jt]sx?$/.test(p)) return 'test';
  if (/\.feature$/.test(p)) return 'test';
  if (/\.md$/i.test(p)) return 'doc';
  if (/(^|\/)(README|SECURITY|CHANGELOG|CONTRIBUTING)(\.[^/]*)?$/i.test(p)) return 'doc';
  if (/(^|\/)(docs?|content)\//.test(p)) return 'doc';
  return 'production';
}

/** Parse `git grep --text -n -z` output into {file, line, text} records. */
export function parseGrep(stdout, refPrefix) {
  const out = [];
  for (const rec of stdout.split('\n')) {
    if (rec === '') continue;
    const a = rec.indexOf('\0');
    const b = a < 0 ? -1 : rec.indexOf('\0', a + 1);
    if (a < 0 || b < 0) continue; // not a match record (cannot happen with -z; skip, never throw)
    let file = rec.slice(0, a);
    if (refPrefix && file.startsWith(refPrefix)) file = file.slice(refPrefix.length);
    const line = Number(rec.slice(a + 1, b));
    const text = rec.slice(b + 1);
    out.push({ file, line, text });
  }
  return out;
}

/** Group grep records into per-file summaries: {file, kind, lines:[{line,text}]}. */
export function groupByFile(records) {
  const byFile = new Map();
  for (const r of records) {
    if (!byFile.has(r.file)) byFile.set(r.file, { file: r.file, kind: classify(r.file), lines: [] });
    byFile.get(r.file).lines.push({ line: r.line, text: r.text });
  }
  return [...byFile.values()].sort((x, y) => (x.file < y.file ? -1 : x.file > y.file ? 1 : 0));
}

/** Does an acknowledged entry cover this (repo, file)? */
function covers(entry, repo, file) {
  if (entry.repo !== repo) return false;
  return entry.file ? entry.file === file : file.startsWith(entry.prefix);
}

/** Validate readers.json and normalise it. Throws on a malformed manifest. */
export function loadManifest(path) {
  let m;
  try { m = JSON.parse(readFileSync(path, 'utf8')); }
  catch (e) { throw new Error(`readers.json unreadable at ${path}: ${e.message}`); }
  if (typeof m.key !== 'string' || !m.key) throw new Error('readers.json: "key" must be a non-empty string');
  if (!Array.isArray(m.repos) || m.repos.some((r) => typeof r !== 'string' || !r)) {
    throw new Error('readers.json: "repos" must be an array of repo names');
  }
  if (!Array.isArray(m.acknowledged)) throw new Error('readers.json: "acknowledged" must be an array');
  const repos = new Set(m.repos);
  m.acknowledged.forEach((e, i) => {
    const where = `readers.json: acknowledged[${i}]`;
    if (!e || typeof e !== 'object') throw new Error(`${where} is not an object`);
    if (!repos.has(e.repo)) throw new Error(`${where}: repo "${e.repo}" is not in "repos" — a reader the census would never scan`);
    if (!(e.role in ROLES)) throw new Error(`${where}: unknown role "${e.role}" (known: ${Object.keys(ROLES).join(', ')})`);
    // Boolean(), not the bare `&&`: `typeof e.file === 'string' && e.file`
    // evaluates to the STRING 'f', so `hasFile === hasPrefix` compared 'f' to
    // 'p' and an entry carrying BOTH keys validated clean — covers() then reads
    // `file` and silently ignores `prefix`, so a prefix acknowledgement would
    // cover exactly one path and the rest of the tree would read as NEW READERs.
    const hasFile = typeof e.file === 'string' && e.file.length > 0;
    const hasPrefix = typeof e.prefix === 'string' && e.prefix.length > 0;
    if (hasFile === hasPrefix) throw new Error(`${where}: exactly one of "file" or "prefix" is required`);
    // A prefix acknowledgement is the one entry shape that can NEVER be
    // re-flagged: every future file under it is covered in advance. "src/"
    // would blanket-acknowledge a whole repo's production tree, so a prefix
    // must name a directory BELOW a top level one and end in '/'.
    if (hasPrefix) {
      const segs = e.prefix.split('/').filter(Boolean);
      if (!e.prefix.endsWith('/') || segs.length < 2) {
        throw new Error(`${where}: prefix "${e.prefix}" is too broad — a prefix must end with "/" and name at least two path segments (e.g. "dist/chunks/"), because everything under it is acknowledged in advance and can never be re-flagged as a NEW READER. List the files individually instead.`);
      }
    }
  });
  m.ignoredRepos = m.ignoredRepos && typeof m.ignoredRepos === 'object' ? m.ignoredRepos : {};
  const c = m.canary;
  if (!c || typeof c !== 'object' || typeof c.repo !== 'string' || typeof c.file !== 'string' || !c.repo || !c.file) {
    throw new Error('readers.json: "canary" must be {repo, file} — the file that PROVES the scan works (see checkCanary)');
  }
  if (!repos.has(c.repo)) throw new Error(`readers.json: canary repo "${c.repo}" is not in "repos"`);
  if (!m.acknowledged.some((e) => covers(e, c.repo, c.file))) {
    throw new Error(`readers.json: canary ${c.repo}/${c.file} is not acknowledged — it must be, or the canary itself reads as a NEW READER`);
  }
  return m;
}

/**
 * THE CANARY. A census that matches NOTHING looks exactly like a fleet that has
 * finished migrating: every acknowledged entry reports MIGRATED and the default
 * run exits 0. Measured 2026-09-17 — a one-character typo in `key` turned the
 * real census into `newReaders=0 migrated=22 ... -> exit 0`, a clean green over
 * a scan that had searched for a string nothing contains. The same shape comes
 * from a wrong --fleet-root full of unrelated clones, or a git grep that stops
 * working.
 *
 * So the manifest names one file that MUST match — this repo's own
 * session.service.ts, the writer whose presence --self already depends on. If
 * the canary's repo was scanned and that file did not match, the SCAN is broken;
 * that is an environment error (exit 2), never fleet progress. Returns null when
 * the canary held, or a message when it did not.
 */
export function checkCanary(census, manifest, missing = []) {
  const { repo, file } = manifest.canary;
  const scanned = census.find((r) => r.repo === repo);
  // Not checked out AND known to be missing: --allow-missing would otherwise
  // downgrade that to a warning and the run would report a green census over
  // nothing. Measured 2026-09-17: `--fleet-root /tmp/empty --allow-missing`
  // gave `repos=0 missing=39 newReaders=0 ... -> exit 0`. Without the canary
  // there is no evidence the scan works at all, so that is exit 2.
  if (!scanned && missing.includes(repo)) {
    return `CANARY NOT SCANNED: ${repo} is not checked out, so nothing proves this census can find '${manifest.key}' at all. Every "MIGRATED" line below is an artefact of a scan that searched nothing. --allow-missing may not skip the canary repo.`;
  }
  if (!scanned) return null; // not checked out: already reported as a blind spot
  if (scanned.files.some((f) => f.file === file)) return null;
  return `CANARY FAILED: ${repo}/${file} does not contain '${manifest.key}' at ${scanned.ref} ${scanned.sha ? scanned.sha.slice(0, 12) : '-'}. That file is the fleet's writer and must always match, so the SCAN is broken — a wrong "key" in readers.json, a --fleet-root that is not the fleet, or a git grep that failed. Every "MIGRATED" line below is an artefact of that, not progress.`;
}

/**
 * Compare a census (per-repo grouped files) against readers.json.
 *   newReaders  production files nobody acknowledged     -> DRIFT
 *   migrated    acknowledged entries that matched nothing -> info (strict: DRIFT)
 *   mentions    spec / e2e / doc files                     -> info
 */
export function diff(census, manifest) {
  const newReaders = [];
  const mentions = [];
  const seen = new Set();
  for (const repo of census) {
    for (const f of repo.files) {
      const hit = manifest.acknowledged.find((e) => covers(e, repo.repo, f.file));
      if (hit) seen.add(hit);
      if (f.kind !== 'production') { mentions.push({ repo: repo.repo, ...f }); continue; }
      if (!hit) newReaders.push({ repo: repo.repo, ...f });
    }
  }
  const scanned = new Set(census.map((r) => r.repo));
  const migrated = manifest.acknowledged.filter((e) => !seen.has(e) && scanned.has(e.repo));
  return { newReaders, migrated, mentions };
}

/** Which of the org's repos does readers.json neither scan nor knowingly ignore? */
export function orgDiff(orgRepoNames, manifest) {
  const known = new Set([...manifest.repos, ...Object.keys(manifest.ignoredRepos ?? {})]);
  return orgRepoNames.filter((n) => !known.has(n)).sort();
}

/**
 * Strip line and block comments, leaving string and template literals intact.
 *
 * DIRECTION OF ERROR, deliberately opposite to the census. In the CENSUS an
 * over-strip HIDES a reader — it fails open — which is why the census does not
 * strip and acknowledges comment matches with a role instead. In --self an
 * over-strip can only delete a marker the guard needs, i.e. raise a FALSE
 * ALARM, and an UNDER-strip is the measured fail-open: commented-out code read
 * as a live write. So here we strip, and we strip greedily.
 *
 * Newlines inside a stripped comment are kept so byte offsets stay on their
 * own lines. KNOWN LIMIT: a comment inside a template literal's interpolation
 * survives (the whole template is treated as one string) — that
 * is the under-strip direction, so state it rather than guess at a parser.
 */
export function stripComments(src) {
  let out = '';
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue; // the '\n' itself is copied by the next iteration
    }
    if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src.slice(i, i + 2); i += 2; continue; }
        out += src[i];
        const done = src[i] === c;
        i++;
        if (done) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** Statement keywords whose `(...) {` head is a BLOCK, never a function. */
const NOT_A_FUNCTION = new Set(['if', 'for', 'while', 'switch', 'catch', 'do', 'with', 'return']);
/** `name(args) {`, `private name(args): T {`, `function name(args) {`. */
const METHOD_HEAD = /([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*(?::[^(){}]*)?\s*$/;
/** `const name = (args) => {`, `name = async (args): T => {`. */
const ARROW_HEAD = /([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?\([^()]*\)\s*(?::[^(){}=]*)?=>\s*$/;

/**
 * The name of the innermost function or method whose body encloses `index`, or
 * null when `index` sits at module top level (or in a shape neither head
 * matches). Walks backwards balancing braces: a '}' opens a sibling block, a
 * '{' at depth 0 is an enclosing body, and a head that is a class body or an
 * `if`/`for` block is skipped and the walk continues outwards.
 *
 * Only ever used on comment-stripped source. A brace inside a string literal
 * would skew the walk; the consequence is a wrong or null name, which makes the
 * liveness check below either raise a false alarm or fall back to "top level" —
 * never a silent pass over a deleted call site, because a deleted setItem is
 * caught by its own marker regardless.
 */
export function enclosingFunctionName(src, index) {
  let depth = 0;
  for (let i = index; i >= 0; i--) {
    const c = src[i];
    if (c === '}') { depth++; continue; }
    if (c !== '{') continue;
    if (depth > 0) { depth--; continue; }
    const head = src.slice(Math.max(0, i - 400), i);
    const m = ARROW_HEAD.exec(head) ?? METHOD_HEAD.exec(head);
    if (m && !NOT_A_FUNCTION.has(m[1])) return m[1];
    // a class body, an object literal, an `if`/`for` block: keep walking out
  }
  return null;
}

/** The markers that prove this repo still writes the mirror. Either spelling of
 *  the key in the setItem call counts, so a refactor that inlines the constant
 *  does not trip the guard while the write is still there. */
const WRITER_MARKERS = [
  { name: 'the key constant', re: /(['"])hug\.session\1/ },
  { name: 'a localStorage.setItem of the key', re: /localStorage\s*\.\s*setItem\s*\(\s*(FLEET_MIRROR_KEY|(['"])hug\.session\2)/ },
];

const SET_ITEM = /localStorage\s*\.\s*setItem\s*\(\s*(?:FLEET_MIRROR_KEY|(['"])hug\.session\1)/;

/**
 * IS THE WRITE LIVE? A marker match only proves the bytes are in the file. The
 * measured hole (2026-09-17, both mutations green against the text-only check):
 * comment out the `this.publishMirror(s)` CALL SITE and publishMirror becomes
 * dead code — the mirror is never written, every marker still matches, exit 0.
 *
 * So: find the setItem, find the function that holds it, and require that
 * function to be CALLED somewhere else in the file. Its own declaration is one
 * occurrence of `name(`, so a live writer has at least two. A setItem at module
 * top level runs on import and needs no call site.
 */
export function writerLiveness(strippedSource) {
  const m = SET_ITEM.exec(strippedSource);
  if (!m) return { live: false, fn: null, reason: 'there is no localStorage.setItem of the key at all' };
  const fn = enclosingFunctionName(strippedSource, m.index);
  if (!fn) return { live: true, fn: null, reason: 'the write is module-level code' };
  const escaped = fn.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const calls = strippedSource.match(new RegExp(`\\b${escaped}\\s*\\(`, 'g')) ?? [];
  if (calls.length < 2) {
    return { live: false, fn, reason: `${fn}() holds the write but nothing calls it — the only occurrence of "${fn}(" is its own declaration, so the mirror is never written` };
  }
  return { live: true, fn, reason: `${fn}() holds the write and is called ${calls.length - 1} time(s)` };
}

/**
 * SELF CHECK: the write may not be deleted while readers.json still holds a
 * blocking reader. Pure: takes the writer source text and the manifest.
 * Comments are stripped first — see stripComments() for why that is the right
 * direction here and the wrong one in the census.
 */
export function selfCheck(writerSource, manifest) {
  const src = stripComments(writerSource);
  const missing = WRITER_MARKERS.filter((m) => !m.re.test(src)).map((m) => m.name);
  const liveness = writerLiveness(src);
  if (missing.length === 0 && !liveness.live) missing.push(`a live write (${liveness.reason})`);
  const writerPresent = missing.length === 0;
  const blocking = manifest.acknowledged.filter((e) => ROLES[e.role].blocking);
  if (!writerPresent && blocking.length > 0) {
    return {
      ok: false, writerPresent, blocking, liveness,
      message: `the hug.session write is GONE from session.service.ts (missing: ${missing.join('; ')}) while readers.json still acknowledges ${blocking.length} blocking reader(s). This is the PR #17 regression: every one of them would see an anonymous session after a successful sign-in. Migrate them (hugmesh-login-ui #18) and prune readers.json BEFORE deleting the write.`,
    };
  }
  if (writerPresent && blocking.length === 0) {
    return {
      ok: true, writerPresent, blocking, liveness,
      message: 'readers.json acknowledges NO blocking reader: the hug.session write in session.service.ts may now be deleted (hugmesh-login-ui #18, final box). Run the full census first to confirm the list is current.',
    };
  }
  if (!writerPresent) {
    return { ok: true, writerPresent, blocking, liveness, message: 'the hug.session write is gone and no blocking reader remains — the retirement is complete.' };
  }
  return { ok: true, writerPresent, blocking, liveness, message: `writer present and live (${liveness.reason}); ${blocking.length} blocking reader(s) still acknowledged — the write stays.` };
}

// ---------------------------------------------------------------------------
// git plumbing.

function git(dir, args, opts = {}) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  if (r.error) throw new Error(`git ${args[0]} in ${dir}: ${r.error.message}`);
  return r;
}

/** The tree to census: origin/<default> (never the checkout's own branch). */
export function resolveRef(dir) {
  const warnings = [];
  const sym = git(dir, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD']);
  let ref = sym.status === 0 ? sym.stdout.trim() : '';
  if (!ref) {
    warnings.push('no refs/remotes/origin/HEAD — falling back to origin/main');
    ref = 'origin/main';
  }
  let sha = git(dir, ['rev-parse', '-q', '--verify', `${ref}^{commit}`]);
  if (sha.status !== 0) {
    warnings.push(`${ref} does not exist — falling back to HEAD (this checkout's own branch, NOT the remote default)`);
    ref = 'HEAD';
    sha = git(dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']);
    if (sha.status !== 0) throw new Error(`${dir}: no commits at all`);
  }
  return { ref, sha: sha.stdout.trim(), warnings };
}

/** Census ONE repo checkout. mode 'origin' greps the remote default tree; mode
 *  'worktree' greps the working tree INCLUDING untracked files (a pre-push
 *  check of what you are about to commit). */
export function scanRepo(dir, key, mode = 'origin') {
  let ref = null, sha = null, warnings = [];
  const args = ['grep', '--text', '-n', '-z', '-F', '-e', key];
  if (mode === 'worktree') {
    args.push('--untracked');
    sha = git(dir, ['rev-parse', '-q', '--verify', 'HEAD^{commit}']).stdout.trim() || null;
  } else {
    ({ ref, sha, warnings } = resolveRef(dir));
    args.push(ref);
  }
  args.push('--', '.');
  const r = git(dir, args);
  if (r.status !== 0 && r.status !== 1) {
    throw new Error(`git grep failed in ${dir} (exit ${r.status}): ${r.stderr.trim()}`);
  }
  const records = parseGrep(r.stdout, ref ? `${ref}:` : '');
  return { ref: ref ?? 'worktree', sha, warnings, files: groupByFile(records) };
}

// ---------------------------------------------------------------------------
// CLI.

function usage() {
  return [
    'usage: node tools/fleet-mirror/census.mjs [options]',
    '',
    '  (default)            full census of every repo in readers.json at origin/<default>',
    '  --self               this repo only: the writer must stay while blocking readers remain',
    '  --fleet-root <dir>   where the sibling checkouts live (default: $HUGMESH_FLEET_ROOT, else ../)',
    '  --ref origin|worktree  origin/<default> tree (default) or each working tree incl. untracked',
    '  --strict             any drift fails, including migrated (vanished) readers',
    '  --allow-missing      a repo that is not checked out is a warning, not exit 2',
    '  --org [name]         also ask `gh repo list <org>` and fail on a repo readers.json never scans',
    '  --json               machine-readable report on stdout',
    '  --verbose            list spec/e2e/doc mentions line by line',
    '  --manifest <file>    readers.json to use (tests)      --writer <file>  session.service.ts to check (tests)',
  ].join('\n');
}

export function parseArgs(argv) {
  const o = {
    self: false, fleetRoot: process.env.HUGMESH_FLEET_ROOT || resolve(REPO_ROOT, '..'), ref: 'origin',
    strict: false, allowMissing: false, org: null, json: false, verbose: false,
    manifest: DEFAULT_MANIFEST, writer: DEFAULT_WRITER, help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    switch (a) {
      case '--self': o.self = true; break;
      case '--fleet-root': o.fleetRoot = resolve(next()); break;
      case '--ref': o.ref = next(); if (!['origin', 'worktree'].includes(o.ref)) throw new Error('--ref must be origin or worktree'); break;
      case '--strict': o.strict = true; break;
      case '--allow-missing': o.allowMissing = true; break;
      case '--org': o.org = (argv[i + 1] && !argv[i + 1].startsWith('--')) ? argv[++i] : DEFAULT_ORG; break;
      case '--json': o.json = true; break;
      case '--verbose': o.verbose = true; break;
      case '--manifest': o.manifest = resolve(next()); break;
      case '--writer': o.writer = resolve(next()); break;
      case '-h': case '--help': o.help = true; break;
      default: throw new Error(`unknown option ${a}\n${usage()}`);
    }
  }
  return o;
}

function orgRepoNames(org) {
  const r = spawnSync('gh', ['repo', 'list', org, '--limit', '500', '--json', 'name', '--jq', '.[].name'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    throw new Error(`gh repo list ${org} failed (${r.error ? r.error.message : r.stderr.trim()}). Under the ambient fine-grained token gh cannot see the private repos: run with env -u GH_TOKEN -u GITHUB_TOKEN.`);
  }
  return r.stdout.split('\n').map((s) => s.trim()).filter(Boolean);
}

export function runSelf(o, log) {
  const manifest = loadManifest(o.manifest);
  const src = readFileSync(o.writer, 'utf8');
  const res = selfCheck(src, manifest);
  if (o.json) log(JSON.stringify({ mode: 'self', ...res, blocking: res.blocking.map((b) => ({ repo: b.repo, file: b.file ?? b.prefix, role: b.role })) }, null, 2));
  else {
    log(`[mirror:self] ${res.ok ? 'OK' : 'FAIL'} — ${res.message}`);
    if (!res.ok) for (const b of res.blocking) log(`  blocking: ${b.repo}/${b.file ?? b.prefix} (${b.role})`);
  }
  return res.ok ? EXIT.OK : EXIT.DRIFT;
}

export function runCensus(o, log) {
  const manifest = loadManifest(o.manifest);
  const census = [];
  const missing = [];
  for (const repo of manifest.repos) {
    const dir = join(o.fleetRoot, repo);
    const isRepo = existsSync(join(dir, '.git')) || (existsSync(dir) && statSync(dir).isDirectory() && git(dir, ['rev-parse', '--git-dir']).status === 0);
    if (!isRepo) { missing.push(repo); continue; }
    const scan = scanRepo(dir, manifest.key, o.ref);
    census.push({ repo, dir, ...scan });
  }
  const d = diff(census, manifest);
  const canaryError = checkCanary(census, manifest, missing);
  let unlisted = [];
  if (o.org) unlisted = orgDiff(orgRepoNames(o.org), manifest);

  const failMissing = missing.length > 0 && !o.allowMissing;
  const drift = d.newReaders.length > 0 || unlisted.length > 0 || (o.strict && d.migrated.length > 0);
  const code = (canaryError || failMissing) ? EXIT.ERROR : drift ? EXIT.DRIFT : EXIT.OK;

  if (o.json) {
    log(JSON.stringify({
      mode: 'census', key: manifest.key, ref: o.ref, fleetRoot: o.fleetRoot, exit: code, canaryError,
      repos: census.map((r) => ({ repo: r.repo, ref: r.ref, sha: r.sha, warnings: r.warnings, files: r.files })),
      missing, unlistedOrgRepos: unlisted,
      newReaders: d.newReaders, migrated: d.migrated,
      mentions: d.mentions.map((m) => ({ repo: m.repo, file: m.file, kind: m.kind, count: m.lines.length })),
    }, null, 2));
    return code;
  }

  log(`[mirror:census] key='${manifest.key}' ref=${o.ref} fleet-root=${o.fleetRoot}`);
  for (const r of census) {
    const prod = r.files.filter((f) => f.kind === 'production');
    const other = r.files.length - prod.length;
    log(`\n## ${r.repo} @ ${r.ref} ${r.sha ? r.sha.slice(0, 12) : '-'}  production=${prod.length} mentions=${other}`);
    for (const w of r.warnings) log(`  WARN ${w}`);
    for (const f of prod) {
      const ack = manifest.acknowledged.find((e) => covers(e, r.repo, f.file));
      const tag = ack ? `[${ack.role}]` : '[NEW READER]';
      for (const l of f.lines) log(`  ${tag} ${f.file}:${l.line}: ${l.text.trim().slice(0, 160)}`);
    }
    if (o.verbose) {
      for (const f of r.files.filter((x) => x.kind !== 'production')) {
        for (const l of f.lines) log(`  [${f.kind}] ${f.file}:${l.line}: ${l.text.trim().slice(0, 160)}`);
      }
    }
  }
  log('');
  if (canaryError) log(`ERROR ${canaryError}`);
  for (const m of missing) log(`${o.allowMissing ? 'WARN' : 'ERROR'} ${m}: not checked out under ${o.fleetRoot} — the census is BLIND to it${o.allowMissing ? '' : ' (clone it, or pass --allow-missing to accept the blind spot)'}`);
  for (const u of unlisted) log(`ERROR org repo "${u}" is neither in readers.json#repos nor #ignoredRepos — the census never scans it`);
  for (const n of d.newReaders) log(`ERROR NEW READER ${n.repo}/${n.file} (${n.lines.length} line(s)) — acknowledge it in tools/fleet-mirror/readers.json with a role, and add its migration to hugmesh-login-ui #18`);
  for (const m of d.migrated) log(`${o.strict ? 'ERROR' : 'INFO'} MIGRATED ${m.repo}/${m.file ?? m.prefix} (${m.role}) no longer matches — prune it from readers.json`);
  const blocking = manifest.acknowledged.filter((e) => ROLES[e.role].blocking && !d.migrated.includes(e));
  log(`summary: repos=${census.length} missing=${missing.length} newReaders=${d.newReaders.length} migrated=${d.migrated.length} mentions=${d.mentions.length} blockingReadersRemaining=${blocking.length} -> exit ${code}`);
  return code;
}

export function main(argv = process.argv.slice(2), log = (s) => process.stdout.write(s + '\n')) {
  let o;
  try { o = parseArgs(argv); }
  catch (e) { process.stderr.write(`${e.message}\n`); return EXIT.ERROR; }
  if (o.help) { log(usage()); return EXIT.OK; }
  try { return o.self ? runSelf(o, log) : runCensus(o, log); }
  catch (e) { process.stderr.write(`[mirror] ERROR ${e.message}\n`); return EXIT.ERROR; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main();
}
