import { ComponentFixture, TestBed } from '@angular/core/testing';

import { OtherDomainsComponent } from './other-domains.component';
import { OtherDomainsService } from './other-domains.service';

describe('OtherDomainsComponent', () => {
  let fixture: ComponentFixture<OtherDomainsComponent>;

  const render = async (domains: { name: string; title: string; url: string }[]) => {
    await TestBed.configureTestingModule({
      imports: [OtherDomainsComponent],
      providers: [{ provide: OtherDomainsService, useValue: { load: async () => domains } }],
    }).compileComponents();
    fixture = TestBed.createComponent(OtherDomainsComponent);
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  };

  it('draws nothing when the mesh lists no other domain', async () => {
    const el = await render([]);
    expect(el.querySelector('[data-testid="other-domains"]')).toBeNull();
    expect(el.textContent?.trim()).toBe('');
  });

  it('draws a labelled list of links, one per domain', async () => {
    const el = await render([
      { name: 'acme.localhost', title: 'Acme', url: 'https://acme.localhost:8488/login/' },
      { name: 'example.localhost', title: 'Example', url: 'https://example.localhost:8488/login/' },
    ]);
    const nav = el.querySelector('[data-testid="other-domains"]') as HTMLElement;
    expect(nav.getAttribute('aria-labelledby')).toBe('hug-other-domains-heading');
    expect(el.querySelector('#hug-other-domains-heading')?.textContent?.trim())
      .toBe('Sign in to another domain');
    const links = Array.from(el.querySelectorAll('a'));
    expect(links.map((a) => a.textContent?.trim())).toEqual(['Acme', 'Example']);
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      'https://acme.localhost:8488/login/', 'https://example.localhost:8488/login/']);
  });

  it('shows a title as text, never as markup', async () => {
    const el = await render([{ name: 'a.example', title: '<img src=x onerror=alert(1)>',
      url: 'https://a.example/login/' }]);
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('a')?.textContent).toContain('<img');
  });
});
