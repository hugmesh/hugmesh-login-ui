// A faithful port of Docker's .dockerignore matcher (moby/patternmatcher), so
// this repo can enumerate the build CONTEXT — i.e. what `COPY . .` actually
// puts in the image — without running a build.
//
// WHY A PORT AND NOT A GLOB LIBRARY: .dockerignore is NOT .gitignore and is not
// plain glob. The differences below are the ones that decide whether a fix for
// #21 is real, and every one of them is pinned by tools/docker/context.test.mjs:
//
//   * a pattern is matched against the WHOLE relative path, so a bare
//     `node_modules` excludes only the ROOT one — `e2e/node_modules` survives.
//     (.gitignore would exclude both. This is the trap the fleet's existing
//     .dockerignore files sit on.)
//   * `*` does not cross `/`; `**` does.
//   * LAST matching pattern wins, and `!` lines are exceptions, not comments.
//   * a file is excluded when the pattern matches the file OR ANY ANCESTOR
//     directory — that is why `dist` on its own removes the whole tree.
//
// Reference: moby/patternmatcher — Pattern.compile() and
// PatternMatcher.MatchesOrParentMatches().

const SEP = '/';

/** filepath.Clean, restricted to the slash-separated relative paths we see. */
export function cleanPattern(p) {
  const rooted = p.startsWith(SEP);
  const out = [];
  for (const part of p.split(SEP)) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!rooted) out.push('..');
      continue;
    }
    out.push(part);
  }
  return out.length ? out.join(SEP) : '.';
}

/** moby Pattern.compile(): translate one dockerignore pattern to a RegExp. */
export function compilePattern(pattern) {
  let reg = '';
  const chars = [...pattern];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (ch === '*') {
      if (chars[i + 1] === '*') {
        i++;                               // consume the second '*'
        if (chars[i + 1] === SEP) i++;     // "**/" is treated as "**"
        if (i + 1 >= chars.length) {
          reg += '.*';                     // trailing "**" accepts everything
        } else {
          reg += '((.*\\/)|([^\\/]*))';    // "**" spans zero or more segments
        }
      } else {
        reg += '[^\\/]*';                  // "*" never crosses a separator
      }
    } else if (ch === '?') {
      reg += '.';
    } else {
      reg += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${reg}$`);
}

export function parseDockerignore(text) {
  const patterns = [];
  for (const raw of text.split('\n')) {
    let line = raw.replace(/\r$/, '');
    if (line.trim() === '') continue;
    if (line.startsWith('#')) continue;
    let exclusion = false;
    if (line.startsWith('!')) { exclusion = true; line = line.slice(1); }
    line = line.trim();
    if (line === '') continue;
    const cleaned = cleanPattern(line);
    if (cleaned === '.') continue;
    patterns.push({ source: raw, pattern: cleaned, exclusion, re: compilePattern(cleaned) });
  }
  return patterns;
}

/**
 * moby PatternMatcher.MatchesOrParentMatches(): true == the path is EXCLUDED
 * from the build context.
 */
export function isExcluded(patterns, relPath) {
  const parts = relPath.split(SEP);
  let matched = false;
  for (const p of patterns) {
    let hit = p.re.test(relPath);
    if (!hit) {
      for (let i = 1; i < parts.length; i++) {
        if (p.re.test(parts.slice(0, i).join(SEP))) { hit = true; break; }
      }
    }
    if (hit) matched = !p.exclusion;
  }
  return matched;
}

/**
 * Could an `!` exception line ever re-include something UNDER this excluded
 * directory? If not, the walk may skip the directory outright, exactly as
 * BuildKit does — which is what keeps this check off node_modules.
 */
export function mayContainException(patterns, dirRel) {
  for (const p of patterns) {
    if (!p.exclusion) continue;
    if (p.pattern.startsWith('*')) return true;     // could match anywhere
    if (p.pattern.startsWith(`${dirRel}${SEP}`)) return true;
  }
  return false;
}
