// Fetching through a real Chrome (Playwright), for the GitHub Actions runner. Same contract as fetch() with
// redirect: 'manual', so crawler/fetcher.js keeps its pacing, redirect chains, robots rules and stop-on-challenge.
//  * Each GET is a real page visit (images, media and fonts skipped). The raw server HTML is read from the network
//    response, not from the page after scripts ran; the browser renders separately (render.js).
//  * Redirects: Chrome follows them; every hop is recorded and handed back one hop per call, as fetch() would.
//  * A challenge that the browser passes by itself (a short "checking your browser" page) is given a few seconds to
//    finish, as it would for any visitor. Nothing is done to solve or get around a challenge; if one remains, it is
//    returned as-is and the crawler logs it and, after several, stops.
const SKIP = new Set(['image', 'media', 'font']);
const NO_BODY = new Set([101, 103, 204, 205, 304]);

function toResponse({ status, headers, body }) {
  const h = new Headers();
  for (const [k, v] of Object.entries(headers || {})) { try { h.append(k, v); } catch { /* skip odd header values */ } }
  const s = status >= 200 && status <= 599 ? status : 599;
  return new Response(NO_BODY.has(s) || body == null ? null : body, { status: s, headers: h });
}
const looksChallenged = (status, html) => (status === 403 || status === 503 || status === 429 || status === 200)
  && /challenge-platform|cf-chl|challenge-running|_Incapsula_Resource|px-captcha|\/_sec\/cp_challenge|Checking (if the site connection is secure|your browser)/i.test(String(html || '').slice(0, 60000));

export function browserFetch(context, { timeoutMs = 45000, challengeWaitMs = 12000 } = {}) {
  const pending = new Map(); // later redirect hops already seen, keyed by URL
  let routed = null;
  const route = () => (routed ||= context.route('**/*', (r) => (SKIP.has(r.request().resourceType()) ? r.abort() : r.continue())));

  async function viaRequest(url, method) {
    const r = await context.request.fetch(url, { method, maxRedirects: 0, failOnStatusCode: false, timeout: timeoutMs });
    return toResponse({ status: r.status(), headers: r.headers(), body: method === 'HEAD' ? null : await r.body() });
  }

  return async function fetchImpl(url, { method = 'GET' } = {}) {
    url = String(url);
    if (pending.has(url)) { const hop = pending.get(url); pending.delete(url); return toResponse(hop); }
    if (method !== 'GET') return viaRequest(url, method);
    await route();
    const page = await context.newPage();
    try {
      let last = null;
      page.on('response', (r) => { try { if (r.request().isNavigationRequest() && r.frame() === page.mainFrame()) last = r; } catch { /* ignore */ } });
      let resp;
      try { resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs }); }
      catch (e) {
        if (/download is starting|net::ERR_ABORTED/i.test(e.message)) return viaRequest(url, 'GET'); // .gz sitemaps, PDFs
        throw e;
      }
      if (!resp) return viaRequest(url, 'GET');
      let body = await resp.body().catch(() => null);
      if (looksChallenged(resp.status(), body && body.toString('utf8'))) {
        // a browser check that clears itself navigates to the real page; wait for that like any visitor would
        await page.waitForLoadState('networkidle', { timeout: challengeWaitMs }).catch(() => {});
        await page.waitForTimeout(Math.min(3000, challengeWaitMs));
        if (last && last !== resp) { const b = await last.body().catch(() => null); if (b) { resp = last; body = b; } }
      }
      // the redirect chain, oldest first
      const hops = [];
      for (let req = resp.request().redirectedFrom(); req; req = req.redirectedFrom()) {
        const r = await req.response();
        hops.unshift({ url: req.url(), status: r ? r.status() : 302, headers: r ? await r.allHeaders().catch(() => r.headers()) : {} });
      }
      const final = { url: resp.url(), status: resp.status(), headers: await resp.allHeaders().catch(() => resp.headers()), body };
      if (!hops.length) return toResponse(final);
      hops.forEach((h, i) => { h.headers = { ...h.headers, location: i + 1 < hops.length ? hops[i + 1].url : final.url }; });
      for (const h of hops.slice(1)) pending.set(h.url, h);
      pending.set(final.url, final);
      return toResponse(hops[0]);
    } finally { await page.close().catch(() => {}); }
  };
}
