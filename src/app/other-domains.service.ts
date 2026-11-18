import { Injectable } from '@angular/core';

/** One other domain this mesh serves, ready to link to. */
export interface OtherDomain {
  /** The host name (no port): what the sign-in page of that domain is reached on. */
  name: string;
  /** What a person calls it (its wordmark when it has one, else its name). */
  title: string;
  /** The absolute link to its sign-in page, on this page's scheme and port. */
  url: string;
}

/** The list the HTTPS door serves (generator look_serving writes it with the looks). */
export const DOMAINS_PATH = '/hug-domains.json';

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_DOMAINS = 24;
const MAX_TITLE = 60;
const TIMEOUT_MS = 3000;

/**
 * Turn the door's document into links. Defensive on purpose: the sign-in page is the one
 * page every visitor sees, so a missing, malformed or hostile document yields NO links
 * rather than an error or a link somewhere unexpected. Only host names that look like host
 * names get a link, titles are cut and stripped of control characters (they are rendered
 * with interpolation, never as HTML), and the current host is left out.
 */
export function otherDomainsFrom(
  doc: unknown,
  here: { protocol: string; hostname: string; port: string },
): OtherDomain[] {
  const rows = (doc as { domains?: unknown } | null)?.domains;
  if (!Array.isArray(rows)) return [];
  const out: OtherDomain[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const name = String((row as { name?: unknown })?.name ?? '').trim().toLowerCase();
    if (!name || name.length > 253 || !HOST.test(name) || name === here.hostname.toLowerCase()
        || seen.has(name)) {
      continue;
    }
    seen.add(name);
    const raw = String((row as { title?: unknown })?.title ?? '');
    // eslint-disable-next-line no-control-regex
    const title = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE) || name;
    const port = here.port ? `:${here.port}` : '';
    out.push({ name, title, url: `${here.protocol}//${name}${port}/login/` });
    if (out.length >= MAX_DOMAINS) break;
  }
  return out;
}

/**
 * Reads the list of the mesh's other domains from the HTTPS door: public, anonymous (no
 * credentials, no Authorization), same origin. A mesh with no list answers 404 and this
 * returns []: no choice is drawn. Never throws, never waits more than a few seconds.
 */
@Injectable({ providedIn: 'root' })
export class OtherDomainsService {
  async load(): Promise<OtherDomain[]> {
    if (typeof fetch !== 'function') return [];
    const ctl = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = ctl ? setTimeout(() => ctl.abort(), TIMEOUT_MS) : null;
    try {
      const res = await fetch(DOMAINS_PATH, {
        credentials: 'omit',
        cache: 'no-store',
        headers: { Accept: 'application/json' },
        signal: ctl?.signal,
      });
      if (!res.ok) return [];
      return otherDomainsFrom(await res.json(), {
        protocol: globalThis.location.protocol,
        hostname: globalThis.location.hostname,
        port: globalThis.location.port,
      });
    } catch {
      return [];
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
