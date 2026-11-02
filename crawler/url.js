// URL rules: normalisation, "same website", and refusing anything that isn't a public web address.

/** Resolve and normalise: drop the fragment, lower-case the host, keep the query (it can matter for duplicates). */
export function normalizeUrl(href, base) {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    u.hash = '';
    u.hostname = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' && u.port === '443') || (u.protocol === 'http:' && u.port === '80')) u.port = '';
    return u.toString();
  } catch { return null; }
}

/** "www.dealer.com" and "dealer.com" are the same site; other subdomains (e.g. a CDN) are not crawled as pages. */
export function siteKey(host) { return String(host || '').toLowerCase().replace(/^www\./, ''); }
export function sameSite(url, siteUrl) {
  try { return siteKey(new URL(url).hostname) === siteKey(new URL(siteUrl).hostname); } catch { return false; }
}

/** Public web addresses only: no IP literals, no localhost or internal names. Tests pass allowPrivate for the fixture. */
export function isPublicTarget(url, { allowPrivate = false } = {}) {
  let u;
  try { u = new URL(url); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (u.username || u.password) return false;
  if (allowPrivate) return true;
  const h = u.hostname.toLowerCase();
  if (h.startsWith('[') || h.includes(':')) return false;                       // IPv6 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return false;                       // no IP literals (public or private)
  if (h === 'localhost' || /\.(local|localhost|internal|lan|home|corp)$/.test(h)) return false;
  return /\.[a-z]{2,}$/.test(h);
}

export const pathOf = (url) => { try { const u = new URL(url); return u.pathname + u.search; } catch { return url; } };
