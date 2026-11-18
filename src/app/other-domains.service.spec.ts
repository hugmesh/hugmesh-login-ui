import { TestBed } from '@angular/core/testing';

import { DOMAINS_PATH, OtherDomainsService, otherDomainsFrom } from './other-domains.service';

const here = { protocol: 'https:', hostname: 'localhost', port: '8488' };

describe('otherDomainsFrom', () => {
  it('links each domain to its sign-in page on this page scheme and port', () => {
    const out = otherDomainsFrom({
      schema: 1,
      domains: [{ name: 'acme.localhost', title: 'Acme' },
                { name: 'example.localhost', title: 'Example' }],
    }, here);
    expect(out).toEqual([
      { name: 'acme.localhost', title: 'Acme', url: 'https://acme.localhost:8488/login/' },
      { name: 'example.localhost', title: 'Example', url: 'https://example.localhost:8488/login/' },
    ]);
  });

  it('leaves out the host the visitor is already on, and repeats', () => {
    const out = otherDomainsFrom({ domains: [
      { name: 'ACME.localhost', title: 'Acme' }, { name: 'acme.localhost', title: 'Again' },
      { name: 'localhost.x.example', title: 'x' },
    ] }, { ...here, hostname: 'acme.localhost' });
    expect(out.map((d) => d.name)).toEqual(['localhost.x.example']);
  });

  it('omits the port when the page has none', () => {
    const out = otherDomainsFrom({ domains: [{ name: 'a.example', title: 'A' }] },
      { protocol: 'https:', hostname: 'b.example', port: '' });
    expect(out[0].url).toBe('https://a.example/login/');
  });

  it('draws no link for a name that is not a plain host name', () => {
    const bad = ['', 'nodots', 'a b.example', 'a/b.example', 'javascript:alert(1)//x.example',
      'evil.example/../x', '-a.example', 'a-.example', 'a..example', 'x'.repeat(64) + '.example',
      '<b>.example', 'a.example:99'];
    const out = otherDomainsFrom({ domains: bad.map((name) => ({ name, title: 't' })) }, here);
    expect(out).toEqual([]);
  });

  it('cuts titles, strips control characters, and falls back to the name', () => {
    const out = otherDomainsFrom({ domains: [
      { name: 'a.example', title: 'x'.repeat(200) },
      { name: 'b.example', title: 'two\nlines\u0007' },
      { name: 'c.example', title: '   ' },
      { name: 'd.example' },
    ] }, here);
    expect(out[0].title.length).toBe(60);
    expect(out[1].title).toBe('two lines');
    expect(out[2].title).toBe('c.example');
    expect(out[3].title).toBe('d.example');
  });

  it('returns [] for anything that is not the document', () => {
    for (const doc of [null, undefined, 3, 'x', [], {}, { domains: 'nope' }, { domains: {} }]) {
      expect(otherDomainsFrom(doc, here)).withContext(JSON.stringify(doc)).toEqual([]);
    }
  });

  it('keeps at most 24 domains', () => {
    const domains = Array.from({ length: 40 }, (_, i) => ({ name: `d${i}.example`, title: `D${i}` }));
    expect(otherDomainsFrom({ domains }, here).length).toBe(24);
  });
});

describe('OtherDomainsService', () => {
  let service: OtherDomainsService;
  let fetchSpy: jasmine.Spy;

  beforeEach(() => {
    service = TestBed.inject(OtherDomainsService);
    fetchSpy = spyOn(globalThis, 'fetch');
  });

  it('asks the door for the list anonymously, never from cache', async () => {
    fetchSpy.and.resolveTo(new Response(JSON.stringify({ domains: [] }), { status: 200 }));
    await service.load();
    const [url, init] = fetchSpy.calls.mostRecent().args as [string, RequestInit];
    expect(url).toBe(DOMAINS_PATH);
    expect(init.credentials).toBe('omit');
    expect(init.cache).toBe('no-store');
    expect(JSON.stringify(init.headers)).not.toMatch(/authorization/i);
  });

  it('turns the answer into links for the other domains', async () => {
    fetchSpy.and.resolveTo(new Response(JSON.stringify({ domains: [
      { name: 'zzz-not-this-host.example', title: 'Zzz' }] }), { status: 200 }));
    const out = await service.load();
    expect(out.map((d) => d.name)).toEqual(['zzz-not-this-host.example']);
  });

  it('is empty on 404 (a mesh with nothing to list), a bad body, and a network failure', async () => {
    fetchSpy.and.resolveTo(new Response('', { status: 404 }));
    expect(await service.load()).toEqual([]);
    fetchSpy.and.resolveTo(new Response('<html>not json</html>', { status: 200 }));
    expect(await service.load()).toEqual([]);
    fetchSpy.and.rejectWith(new TypeError('offline'));
    expect(await service.load()).toEqual([]);
  });
});
