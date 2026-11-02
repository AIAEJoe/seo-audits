// The controlled crawler: polite, honest HTTP fetching.
//  * identifies itself as AIAEAuditBot (USER_AGENT) unless a runner passes a browser identity; never claims to be Googlebot;
//  * one request at a time per MIN_GAP_MS per site, at most MAX_CONCURRENCY in flight;
//  * follows redirects by hand so the whole chain is recorded;
//  * honours Retry-After on 429/503 (up to MAX_RETRY_AFTER_S), and stops after STOP_AFTER_BLOCKS consecutive
//    429s or challenges, instead of pushing on.
import { USER_AGENT, MIN_GAP_MS, MAX_CONCURRENCY, MAX_REDIRECTS, MAX_BYTES, FETCH_TIMEOUT_MS, STOP_AFTER_BLOCKS, MAX_RETRY_AFTER_S } from './constants.js';
import { isPublicTarget, sameSite } from './url.js';
import { detectChallenge } from './challenge.js';

export class CrawlStopped extends Error {
  constructor(reason) { super(reason); this.name = 'CrawlStopped'; }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KEEP_HEADERS = ['content-type', 'content-length', 'cache-control', 'x-robots-tag', 'link', 'location', 'server', 'cf-mitigated', 'cf-ray', 'retry-after',
  'last-modified', 'etag', 'vary', 'x-cache', 'x-powered-by', 'content-language', 'strict-transport-security'];

export function createFetcher({ siteUrl, fetchImpl = fetch, userAgent = USER_AGENT, gapMs = MIN_GAP_MS, concurrency = MAX_CONCURRENCY, allowPrivate = false, now = Date.now, wait = sleep } = {}) {
  let last = 0;
  let active = 0;
  const queue = [];
  let blocks = 0;
  let stopped = null;
  let count = 0;

  async function slot() {
    if (active >= concurrency) await new Promise((r) => queue.push(r));
    active++;
    const t = now();
    const at = Math.max(t, last + gapMs);
    last = at;
    if (at > t) await wait(at - t);
  }
  function release() { active--; const n = queue.shift(); if (n) n(); }

  async function one(url, method) {
    await slot();
    try {
      count++;
      const res = await fetchImpl(url, { method, redirect: 'manual', headers: { 'user-agent': userAgent, accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      return res;
    } finally { release(); }
  }

  /** GET (or HEAD) a URL on the audited site, following redirects. Returns a record; never throws for HTTP errors. */
  async function get(url, { method = 'GET', body = true, offSiteOk = false } = {}) {
    if (stopped) throw new CrawlStopped(stopped);
    if (!isPublicTarget(url, { allowPrivate })) return { url, error: 'not a public web address', chain: [] };
    if (!offSiteOk && !sameSite(url, siteUrl)) return { url, error: 'outside the audited website', chain: [] };
    const chain = [];
    let current = url;
    const fetchedAt = new Date(now()).toISOString();
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let res;
      try { res = await one(current, method); } catch (e) {
        return { url, finalUrl: current, chain, error: e.name === 'TimeoutError' ? 'timed out' : `couldn't connect (${e.message})`, fetchedAt };
      }
      const headers = Object.fromEntries(KEEP_HEADERS.map((h) => [h, res.headers.get(h)]).filter(([, v]) => v !== null));
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        const next = new URL(res.headers.get('location'), current).toString();
        chain.push({ url: current, status: res.status, location: next });
        if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
        if (!isPublicTarget(next, { allowPrivate }) || (!offSiteOk && !sameSite(next, siteUrl))) {
          return { url, finalUrl: next, status: res.status, chain, headers, offSite: true, fetchedAt };
        }
        current = next;
        continue;
      }
      if (res.status === 429 || res.status === 503) {
        const ra = Number(res.headers.get('retry-after'));
        if (Number.isFinite(ra) && ra > 0 && ra <= MAX_RETRY_AFTER_S && hop === 0 && !chain.retried) {
          chain.retried = true;
          await wait(ra * 1000);
          hop--;
          continue;
        }
      }
      let text = '';
      if (body && method !== 'HEAD') {
        const buf = new Uint8Array(await res.arrayBuffer());
        text = new TextDecoder('utf-8', { fatal: false }).decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
      } else if (res.body) { try { await res.body.cancel(); } catch { /* ignore */ } }
      const challenge = detectChallenge({ status: res.status, headers, html: text });
      blocks = res.status === 429 || challenge ? blocks + 1 : 0;
      if (blocks >= STOP_AFTER_BLOCKS) stopped = `The site answered ${blocks} requests in a row with ${res.status === 429 ? '"too many requests"' : 'a security challenge'}, so the crawl stopped instead of pushing on.`;
      return { url, finalUrl: current, status: res.status, chain, headers, body: text, challenge, fetchedAt };
    }
    return { url, finalUrl: current, chain, error: `more than ${MAX_REDIRECTS} redirects`, fetchedAt };
  }

  return { get, get stopped() { return stopped; }, get requests() { return count; } };
}
