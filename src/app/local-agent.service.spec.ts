import { TestBed } from '@angular/core/testing';
import { LocalAgentService } from './local-agent.service';

/** Minimal fetch Response stub (mirrors bff.service.spec's helper). */
function jsonResponse(body: unknown, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    json: async () => body,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

describe('LocalAgentService', () => {
  let service: LocalAgentService;
  let fetchSpy: jasmine.Spy;

  const AGENT = 'http://127.0.0.1:27621';

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [LocalAgentService] });
    service = TestBed.inject(LocalAgentService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  function lastUrl(): string {
    return String(fetchSpy.calls.mostRecent().args[0]);
  }
  function lastInit(): RequestInit {
    return (fetchSpy.calls.mostRecent().args[1] ?? {}) as RequestInit;
  }
  function headersOf(init: RequestInit): Record<string, string> {
    return (init.headers ?? {}) as Record<string, string>;
  }

  // ── GET /v1/roles ───────────────────────────────────────────────────────────

  it('probes EXACTLY http://127.0.0.1:27621/v1/roles with the required custom header and NO cookies', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ agent: 'hugmesh-local-login', version: 1, roles: [] }));
    await service.roles();
    expect(lastUrl()).toBe(`${AGENT}/v1/roles`);
    const init = lastInit();
    expect(init.method).toBe('GET');
    // Never send cookies to the loopback agent (the agent sets no Allow-Credentials).
    expect(init.credentials).toBe('omit');
    // The custom header is REQUIRED (forces the CORS preflight the agent depends on).
    expect(headersOf(init)['X-HugMesh-Local']).toBe('1');
  });

  it('returns the advertised roles on a 200', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse({
        agent: 'hugmesh-local-login',
        version: 1,
        roles: [
          { id: 'brandowner', label: 'Brand Owner', brand: 'acme' },
          { id: 'moderator', label: 'Moderator', brand: 'acme' },
        ],
      }),
    );
    const roles = await service.roles();
    expect(roles).toEqual([
      { id: 'brandowner', label: 'Brand Owner', brand: 'acme' },
      { id: 'moderator', label: 'Moderator', brand: 'acme' },
    ]);
  });

  it('defaults a missing brand to an empty string', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ roles: [{ id: 'x', label: 'X' }] }));
    expect(await service.roles()).toEqual([{ id: 'x', label: 'X', brand: '' }]);
  });

  it('drops malformed entries (missing id/label) rather than rendering them', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse({
        roles: [
          { id: 'ok', label: 'Ok', brand: 'b' },
          { id: '', label: 'no id' },
          { label: 'no id field' },
          { id: 'no-label' },
          'not-an-object',
          null,
        ],
      }),
    );
    expect(await service.roles()).toEqual([{ id: 'ok', label: 'Ok', brand: 'b' }]);
  });

  it('returns [] when the agent is absent (fetch rejects) — NEVER throws', async () => {
    fetchSpy.and.rejectWith(new TypeError('Failed to fetch'));
    await expectAsync(service.roles()).toBeResolvedTo([]);
  });

  it('returns [] on a non-2xx (e.g. 403 Origin rejected)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 403 }));
    expect(await service.roles()).toEqual([]);
  });

  it('returns [] on a malformed body or a non-array roles field', async () => {
    fetchSpy.and.resolveTo({ ok: true, status: 200, json: async () => { throw new Error('bad'); } } as unknown as Response);
    expect(await service.roles()).toEqual([]);
    fetchSpy.and.resolveTo(jsonResponse({ roles: 'nope' }));
    expect(await service.roles()).toEqual([]);
    fetchSpy.and.resolveTo(jsonResponse({}));
    expect(await service.roles()).toEqual([]);
  });

  // ── POST /v1/handoff ──────────────────────────────────────────────────────────

  it('POSTs EXACTLY http://127.0.0.1:27621/v1/handoff with the roleId, the custom header, and NO cookies', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse({
        roleId: 'brandowner',
        username: 'brandowner@acme.local',
        secret: 's3cr3t',
        expiresAt: '2026-07-08T12:00:30Z',
      }),
    );
    await service.handoff('brandowner');
    expect(lastUrl()).toBe(`${AGENT}/v1/handoff`);
    const init = lastInit();
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('omit');
    expect(headersOf(init)['X-HugMesh-Local']).toBe('1');
    expect(JSON.parse(String(init.body))).toEqual({ roleId: 'brandowner' });
  });

  it('does NOT set an explicit content-type header (the agent only allow-lists X-HugMesh-Local)', async () => {
    // An explicit `content-type: application/json` would make the CORS preflight
    // ask for a header the agent does not allow, blocking the call. The default
    // safelisted text/plain carries the JSON string fine.
    fetchSpy.and.resolveTo(jsonResponse({ username: 'u', secret: 's' }));
    await service.handoff('brandowner');
    const h = headersOf(lastInit());
    const names = Object.keys(h).map((k) => k.toLowerCase());
    expect(names).toContain('x-hugmesh-local');
    expect(names).not.toContain('content-type');
  });

  it('returns the single-use handoff (roleId/username/secret/expiresAt) on a 200', async () => {
    fetchSpy.and.resolveTo(
      jsonResponse({
        roleId: 'brandowner',
        username: 'brandowner@acme.local',
        secret: 's3cr3t',
        expiresAt: '2026-07-08T12:00:30Z',
      }),
    );
    expect(await service.handoff('brandowner')).toEqual({
      roleId: 'brandowner',
      username: 'brandowner@acme.local',
      secret: 's3cr3t',
      expiresAt: '2026-07-08T12:00:30Z',
    });
  });

  it('falls back to the requested roleId + a blank expiresAt when the body omits them', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ username: 'brandowner@acme.local', secret: 's3cr3t' }));
    expect(await service.handoff('brandowner')).toEqual({
      roleId: 'brandowner',
      username: 'brandowner@acme.local',
      secret: 's3cr3t',
      expiresAt: '',
    });
  });

  it('returns null when the body lacks a username or secret (no credential to submit)', async () => {
    fetchSpy.and.resolveTo(jsonResponse({ roleId: 'brandowner', username: 'u' }));
    expect(await service.handoff('brandowner')).toBeNull();
    fetchSpy.and.resolveTo(jsonResponse({ roleId: 'brandowner', secret: 's' }));
    expect(await service.handoff('brandowner')).toBeNull();
  });

  it('returns null on a non-2xx or a fetch rejection — NEVER throws', async () => {
    fetchSpy.and.resolveTo(jsonResponse({}, { ok: false, status: 404 }));
    expect(await service.handoff('brandowner')).toBeNull();
    fetchSpy.and.rejectWith(new TypeError('Failed to fetch'));
    await expectAsync(service.handoff('brandowner')).toBeResolvedTo(null);
  });
});
