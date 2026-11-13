/**
 * WCAG 1.4.11: the login page is its own document, so the shell's field rule never
 * reached it; its fields were browser-default white boxes and the MFA field's
 * --hug-border edge was 1.21:1. Reads the compiled global stylesheet.
 */
export {};

type RGB = [number, number, number];
const lum = ([r, g, b]: RGB): number => {
  const c = (v: number): number => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); };
  return 0.2126 * c(r) + 0.7152 * c(g) + 0.0722 * c(b);
};
const ratio = (a: RGB, b: RGB): number => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const rgb = (css: string): RGB => css.match(/[\d.]+/g)!.slice(0, 3).map(Number) as RGB;

describe('login field edges (WCAG 1.4.11)', () => {
  let host: HTMLElement;
  beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); });
  afterEach(() => host.remove());

  for (const html of ['<input type="text">', '<input type="password">', '<input inputmode="numeric">']) {
    it(`${html} has a >= 3:1 edge on the page and card surfaces, and a themed fill`, () => {
      host.innerHTML = html;
      const s = getComputedStyle(host.firstElementChild as HTMLElement);
      expect(s.borderTopStyle).toBe('solid');
      for (const surface of [[0x0a, 0x0a, 0x12], [0x12, 0x12, 0x1e]] as RGB[]) {
        expect(ratio(rgb(s.borderTopColor), surface)).toBeGreaterThanOrEqual(3);
      }
      // Not the UA's white box on the dark page.
      expect(s.backgroundColor).toBe('rgb(18, 18, 30)');
    });
  }

  it('a theme that derives --sd-field-border drives the edge', () => {
    document.documentElement.style.setProperty('--sd-field-border', 'rgb(1, 2, 3)');
    try {
      host.innerHTML = '<input type="text">';
      expect(getComputedStyle(host.firstElementChild as HTMLElement).borderTopColor).toBe('rgb(1, 2, 3)');
    } finally {
      document.documentElement.style.removeProperty('--sd-field-border');
    }
  });
});
