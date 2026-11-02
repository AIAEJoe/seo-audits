// Browser rendering: the page as a phone shows it after JavaScript runs.
//   * renderWithBrowserRun(): Cloudflare Browser Run quick actions (REST /content and /screenshot), used in production.
//   * renderWithPlaywright(): a local Chromium with the same contract, used by the tests.
// Both inject TIMELINE_SCRIPT, which records when each price first appears (milliseconds after navigation start),
// so a price that loads late is measured instead of being mistaken for a missing one.
import { USER_AGENT } from './constants.js';

export const VIEWPORT = { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
export const SETTLE_MS = 6000;

export const TIMELINE_SCRIPT = `(function(){if(window.__aiae)return;window.__aiae=1;var seen={},phones={};
function put(){try{document.documentElement.setAttribute('data-aiae-timeline',JSON.stringify({prices:seen,phones:phones,at:Math.round(performance.now())}))}catch(e){}}
function scan(){var els=document.querySelectorAll('[class*="price" i],[id*="price" i],[data-price],[itemprop="price"]');
for(var i=0;i<els.length;i++){var t=(els[i].textContent||'').replace(/\\s+/g,' ');var m=t.match(/\\$\\s?\\d{1,3}(,\\d{3})+|\\$\\s?\\d{4,6}/g)||[];
for(var j=0;j<m.length;j++){var k=m[j].replace(/\\s/g,'');if(!(k in seen))seen[k]=Math.round(performance.now());}}
var ph=document.querySelectorAll('a[href^="tel:"]');for(var p=0;p<ph.length;p++){var d=ph[p].getAttribute('href').replace(/\\D/g,'').replace(/^1(?=\\d{10}$)/,'');if(d&&!(d in phones))phones[d]=Math.round(performance.now());}
put();}
var mo=new MutationObserver(scan);function go(){scan();mo.observe(document.documentElement,{subtree:true,childList:true,characterData:true});}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',go);else go();setInterval(scan,500);})();`;

/** { prices: {"$52,995": 2510}, phones: {...}, at } from a rendered page, or null. */
export function readTimeline(html) {
  const m = String(html || '').match(/data-aiae-timeline\s*=\s*"([^"]*)"/i) || String(html || '').match(/data-aiae-timeline\s*=\s*'([^']*)'/i);
  if (!m) return null;
  try { return JSON.parse(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#39;/g, "'")); } catch { return null; }
}
/** Our own marker must never be mistaken for the site's markup. */
export const stripTimeline = (html) => String(html || '').replace(/\sdata-aiae-timeline\s*=\s*("[^"]*"|'[^']*')/i, '');

export function renderWithBrowserRun(env, fetchImpl = fetch) {
  const base = `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/browser-run`;
  const headers = { authorization: `Bearer ${env.BROWSER_RUN_TOKEN}`, 'content-type': 'application/json' };
  const common = (url) => ({
    url, userAgent: USER_AGENT, viewport: VIEWPORT, gotoOptions: { waitUntil: 'networkidle2', timeout: 45000 },
    addScriptTag: [{ content: TIMELINE_SCRIPT }], waitForTimeout: SETTLE_MS, bestAttempt: true, rejectResourceTypes: ['media', 'font'],
  });
  return async function render(url, { screenshot = false } = {}) {
    const started = Date.now();
    const res = await fetchImpl(`${base}/content?cacheTTL=0`, { method: 'POST', headers, body: JSON.stringify(common(url)) });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data || !data.success) {
      const msg = data && data.errors && data.errors[0] ? data.errors[0].message : `Browser Run answered ${res.status}`;
      return { url, error: msg, renderedAt: new Date(started).toISOString() };
    }
    let shot = null;
    if (screenshot) {
      const s = await fetchImpl(`${base}/screenshot?cacheTTL=0`, { method: 'POST', headers,
        body: JSON.stringify({ ...common(url), addScriptTag: undefined, screenshotOptions: { type: 'jpeg', quality: 70, fullPage: false } }) });
      if (s.ok && /^image\//.test(s.headers.get('content-type') || '')) shot = new Uint8Array(await s.arrayBuffer());
    }
    const html = data.result || '';
    return { url, status: data.meta && data.meta.status ? data.meta.status : null, html: stripTimeline(html), timeline: readTimeline(html), screenshot: shot,
      screenshotType: 'image/jpeg', renderedAt: new Date(started).toISOString(), ms: Date.now() - started };
  };
}

/** Same contract with a local Playwright browser (tests). */
export function renderWithPlaywright(browser, { settleMs = SETTLE_MS } = {}) {
  return async function render(url, { screenshot = false } = {}) {
    const started = Date.now();
    const ctx = await browser.newContext({ userAgent: USER_AGENT, viewport: { width: VIEWPORT.width, height: VIEWPORT.height }, deviceScaleFactor: VIEWPORT.deviceScaleFactor, isMobile: true, hasTouch: true });
    try {
      await ctx.addInitScript(TIMELINE_SCRIPT);
      const page = await ctx.newPage();
      let status = null;
      try {
        const resp = await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        status = resp ? resp.status() : null;
      } catch (e) { return { url, error: `couldn't load (${e.message.split('\n')[0]})`, renderedAt: new Date(started).toISOString() }; }
      await page.waitForTimeout(settleMs);
      const html = await page.content();
      const shot = screenshot ? new Uint8Array(await page.screenshot({ type: 'jpeg', quality: 70 })) : null;
      return { url, status, html: stripTimeline(html), timeline: readTimeline(html), screenshot: shot, screenshotType: 'image/jpeg', renderedAt: new Date(started).toISOString(), ms: Date.now() - started };
    } finally { await ctx.close(); }
  };
}
