// Pins the Content-Security-Policy that nginx.conf SERVES on the document that
// runs login-ui (issue #31). `ng serve` sends no CSP at all, so the unit and e2e
// suites cannot see this header; it is only checked here, against the file that
// is baked into the image.
//
//   node --test "tools/csp/*.test.mjs"      (npm run csp:test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const AGENT_ORIGIN = 'http://127.0.0.1:27621';

// Pulled from the code, not retyped, so the test follows the service if the
// pinned origin ever moves.
const service = readFileSync(join(ROOT, 'src/app/local-agent.service.ts'), 'utf8');
const origin = /const AGENT_ORIGIN = '([^']+)'/.exec(service);

/** Every `add_header Content-Security-Policy "..."` in nginx.conf, comments excluded. */
function servedPolicies(conf) {
  const code = conf.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
  return [...code.matchAll(/add_header\s+Content-Security-Policy\s+"([^"]*)"/g)].map((m) => m[1]);
}

function directive(policy, name) {
  const d = policy.split(';').map((s) => s.trim().split(/\s+/)).find((t) => t[0] === name);
  return d ? d.slice(1) : null;
}

const conf = readFileSync(join(ROOT, 'nginx.conf'), 'utf8');
const policies = servedPolicies(conf);

test('LocalAgentService still probes exactly the origin this test pins', () => {
  assert.ok(origin, 'AGENT_ORIGIN constant not found in local-agent.service.ts');
  assert.equal(origin[1], AGENT_ORIGIN);
});

test('nginx.conf serves at least one Content-Security-Policy header', () => {
  assert.ok(policies.length >= 1);
});

test('every served policy admits the loopback agent origin in connect-src', () => {
  for (const p of policies) {
    const cs = directive(p, 'connect-src');
    assert.ok(cs, `no connect-src in: ${p}`);
    assert.ok(cs.includes(AGENT_ORIGIN), `connect-src lacks ${AGENT_ORIGIN}: ${cs.join(' ')}`);
  }
});

test('connect-src admits that origin and nothing wider: no http: scheme, no wildcard, no other http origin', () => {
  for (const p of policies) {
    const cs = directive(p, 'connect-src');
    assert.ok(!cs.includes('http:'), 'bare http: scheme admits every plaintext origin');
    assert.ok(!cs.includes('*'), 'wildcard source');
    const plaintext = cs.filter((t) => t.startsWith('http://'));
    assert.deepEqual(plaintext, [AGENT_ORIGIN]);
  }
});

test('the pre-existing connect-src sources are still there', () => {
  for (const p of policies) {
    const cs = directive(p, 'connect-src');
    for (const t of ["'self'", 'blob:', 'https:', 'wss:']) assert.ok(cs.includes(t), `lost ${t}`);
  }
});

test('the change did not loosen script-src', () => {
  for (const p of policies) {
    const ss = directive(p, 'script-src');
    assert.ok(!ss.includes("'unsafe-inline'"));
    assert.ok(!ss.includes('http://127.0.0.1:27621'));
  }
});
