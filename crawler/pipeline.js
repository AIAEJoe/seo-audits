// Stage 2 of an audit: preflight → discover → sample → fetch + render + extract every sampled page → link checks.
// Runs inside a Cloudflare Workflow in production (each `step` is durable and retried) and directly in the tests.
// Every step returns small JSON; HTML, screenshots and the full sitemap list go to storage.
import { createFetcher, CrawlStopped } from './fetcher.js';
import { parseRobots, isAllowed } from './robots.js';
import { parseSitemap } from './sitemap.js';
import { normalizeUrl, sameSite, pathOf } from './url.js';
import { classifyUrl, refineType } from './classify.js';
import { samplePages, DISCOVERY_TYPES } from './sample.js';
import { pageFacts, pageLinks, structuredData, vehicleFacts, phones } from './extract.js';
import { renderDiff } from './diff.js';
import { detectChallenge } from './challenge.js';
import { excerpt, metas } from './html.js';
import { BOT_TOKEN, MIN_GAP_MS } from './constants.js';
import { storagePrefix } from '../public/js/audit-model.js';
import { runChecksStep } from './run-checks.js';

const PAGE_BATCH = 3;
const LINK_BATCH = 25;
const MAX_SITEMAP_FILES = 30;
const MAX_SITEMAP_URLS = 20000;
const MAX_LINK_CHECKS = 150;
const SITEMAP_SAMPLE = 40;

const PLATFORMS = [
  ['Dealer Inspire', /dealerinspire|di-uploads|dealer inspire/i], ['Dealer.com', /dealer\.com|ddc-|\bddc\b|ws-inv-data|dealer-com/i],
  ['DealerOn', /dealeron/i], ['Sincro / CDK', /cdkglobal|sincro|cobalt\.com/i], ['Dealer eProcess', /dealereprocess|\bdep-/i],
  ['Team Velocity', /teamvelocity|apollo\.auto/i], ['Fox Dealer', /foxdealer/i], ['DealerFire', /dealerfire/i], ['Jazel', /jazel/i], ['Overfuel', /overfuel/i],
];
export const detectPlatform = (html) => (PLATFORMS.find(([, re]) => re.test(String(html || ''))) || [null])[0];

async function sha256(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const cap = (s, n = 20000) => (s == null ? null : String(s).slice(0, n));

/**
 * deps: { sink, render, fetchImpl, allowPrivate, gapMs, wait }
 * step(name, fn): durable step runner (Workflows) or a plain call (tests).
 */
export async function runAudit({ auditId, deps, step }) {
  const { sink } = deps;
  const gapMs = deps.gapMs ?? MIN_GAP_MS;
  const wait = deps.wait || ((ms) => new Promise((r) => setTimeout(r, ms)));

  const audit = await step('load', async () => {
    const a = await sink.getAudit(auditId);
    if (!a) throw new Error(`audit ${auditId} not found`);
    return a;
  });
  if (!audit.authorized) {
    await step('refuse', () => sink.updateAudit(auditId, { status: 'failed', error: 'This audit is not authorized, so nothing was fetched.' }).then(() => null));
    return { refused: true };
  }
  const site = audit.site_url;
  const prefix = storagePrefix(audit);
  const log = [];
  const stage = async (key, note) => { log.push({ stage: key, done: true, at: new Date().toISOString(), note }); await sink.updateAudit(auditId, { stage_log: log }); };
  const fetcher = () => createFetcher({ siteUrl: site, fetchImpl: deps.fetchImpl, gapMs, allowPrivate: deps.allowPrivate });
  const cancelled = async () => (await sink.getAudit(auditId)).status === 'cancelled';

  await step('start', () => sink.updateAudit(auditId, { status: 'crawling', started_at: new Date().toISOString(), error: null, stage_log: [] }).then(() => null));

  // ---------------------------------------------------------------- 1. preflight
  const pre = await step('preflight', async () => {
    const f = fetcher();
    const robotsUrl = new URL('/robots.txt', site).toString();
    const r = await f.get(robotsUrl);
    const robotsText = r.status === 200 && !r.challenge ? r.body : '';
    const robots = parseRobots(robotsText);
    await sink.addEvidence({ audit_id: auditId, kind: 'robots', url: robotsUrl, content: cap(r.status === 200 ? r.body : `HTTP ${r.status || r.error}${r.challenge ? ' (security challenge)' : ''}`), sha256: await sha256(r.body || '') });

    // sitemaps: from robots.txt, else the usual places
    const queue = robots.sitemaps.length ? robots.sitemaps.map((u) => normalizeUrl(u, site)).filter(Boolean) : [new URL('/sitemap.xml', site).toString(), new URL('/sitemap_index.xml', site).toString()];
    const files = []; const urls = []; const seenFiles = new Set();
    while (queue.length && files.length < MAX_SITEMAP_FILES && urls.length < MAX_SITEMAP_URLS) {
      const sm = queue.shift();
      if (seenFiles.has(sm)) continue;
      seenFiles.add(sm);
      if (!sameSite(sm, site)) { files.push({ url: sm, skipped: 'on another website' }); continue; }
      const res = await f.get(sm);
      const parsed = res.status === 200 && !res.challenge ? parseSitemap(res.body) : null;
      files.push({ url: sm, status: res.status || null, error: res.error || null, challenge: !!res.challenge, type: parsed ? parsed.type : null, count: parsed ? parsed.entries.length : 0, from_robots: robots.sitemaps.includes(sm) });
      if (!parsed) continue;
      if (parsed.type === 'index') parsed.entries.forEach((e) => queue.push(normalizeUrl(e.loc, sm)));
      else for (const e of parsed.entries) { const u = normalizeUrl(e.loc, sm); if (u && urls.length < MAX_SITEMAP_URLS) urls.push({ url: u, lastmod: e.lastmod, sitemap: sm }); }
    }
    await sink.saveFile(`${prefix}sitemap-urls.json`, JSON.stringify(urls), 'application/json');
    const bad = files.filter((x) => x.status && x.status !== 200 || x.error || x.challenge);
    await sink.addEvidence({ audit_id: auditId, kind: 'sitemap', url: files[0] ? files[0].url : robotsUrl,
      content: cap(JSON.stringify({ files, url_count: urls.length, problems: bad }, null, 1)), storage_path: `${prefix}sitemap-urls.json` });

    const home = await f.get(site);
    const homeLinks = home.body ? pageLinks(home.body, home.finalUrl || site, site).filter((l) => l.internal).map((l) => l.to_url) : [];
    return {
      robotsText: cap(robotsText, 100000), robotsStatus: r.status || null, sitemapFiles: files, sitemapCount: urls.length,
      sitemapSample: urls.filter((_, i) => i % Math.max(1, Math.floor(urls.length / SITEMAP_SAMPLE)) === 0).slice(0, SITEMAP_SAMPLE).map((u) => u.url),
      sitemapUrls: urls.slice(0, 3000).map((u) => u.url), homeLinks: [...new Set(homeLinks)].slice(0, 500),
      platform: detectPlatform(home.body), homeStatus: home.status || null, homeChallenge: home.challenge || null, stopped: f.stopped,
    };
  });
  await step('preflight-log', () => stage('preflight', `robots.txt ${pre.robotsStatus || 'unreachable'}; ${pre.sitemapFiles.length} sitemap file(s), ${pre.sitemapCount} URLs; platform: ${pre.platform || 'not recognised'}${pre.homeChallenge ? '; homepage answered with a security challenge' : ''}`).then(() => null));
  const robots = parseRobots(pre.robotsText);

  // ---------------------------------------------------------------- 2. discover vehicle pages from inventory lists
  const discovered = await step('discover', async () => {
    const cands = [{ url: normalizeUrl(site, site), via: 'start', type: 'home' },
      ...pre.homeLinks.map((u) => ({ url: u, via: 'nav' })), ...pre.sitemapUrls.map((u) => ({ url: u, via: 'sitemap' }))];
    const srps = []; const seen = new Set();
    for (const c of cands) {
      const t = c.type || classifyUrl(c.url, site);
      if (DISCOVERY_TYPES.has(t) && !seen.has(t) && isAllowed(robots, BOT_TOKEN, pathOf(c.url)).allowed) { seen.add(t); srps.push(c.url); }
    }
    const f = fetcher();
    const extra = [];
    for (const u of srps) {
      const res = await f.get(u).catch((e) => ({ error: e.message }));
      if (res.body && !res.challenge) for (const l of pageLinks(res.body, res.finalUrl || u, site)) if (l.internal) extra.push({ url: l.to_url, via: 'inventory' });
    }
    return [...cands, ...extra];
  });

  // ---------------------------------------------------------------- 3. sample
  const sample = await step('sample', async () => {
    const skipped = [];
    const allowed = discovered.filter((c) => {
      const ok = isAllowed(robots, BOT_TOKEN, pathOf(c.url));
      if (!ok.allowed) skipped.push({ url: c.url, rule: ok.rule });
      return ok.allowed;
    });
    const picked = samplePages(allowed, { siteUrl: site, plan: audit.sample_plan || {}, budget: audit.page_budget || 100, seed: auditId });
    if (skipped.length) await sink.addEvidence({ audit_id: auditId, kind: 'robots', url: new URL('/robots.txt', site).toString(),
      content: cap(`Not fetched because robots.txt disallows them for our crawler:\n${[...new Map(skipped.map((s) => [s.url, s])).values()].slice(0, 100).map((s) => `${s.url}  (${s.rule})`).join('\n')}`) });
    return picked;
  });
  await step('sample-log', () => stage('sample', `${sample.length} pages sampled: ${Object.entries(sample.reduce((m, p) => ({ ...m, [p.type]: (m[p.type] || 0) + 1 }), {})).map(([k, v]) => `${v} ${k}`).join(', ')}`).then(() => null));

  // ---------------------------------------------------------------- 4. fetch + render + extract, a few pages per step
  const shotTypes = new Set();
  const results = [];
  let stopped = pre.stopped || null;
  for (let i = 0; i < sample.length; i += PAGE_BATCH) {
    const batch = sample.slice(i, i + PAGE_BATCH);
    const wantShots = batch.map((p) => { const w = !shotTypes.has(p.type); shotTypes.add(p.type); return w; });
    const out = await step(`pages-${i / PAGE_BATCH}`, async () => {
      if (stopped) return batch.map((p) => ({ url: p.url, type: p.type, skipped: stopped }));
      if (await cancelled()) return batch.map((p) => ({ url: p.url, type: p.type, skipped: 'cancelled' }));
      await wait(gapMs); // keep the per-site pace across steps
      const f = fetcher();
      const done = [];
      for (let j = 0; j < batch.length; j++) {
        try { done.push(await processPage({ auditId, page: batch[j], n: i + j, site, prefix, f, deps, wait, gapMs, screenshot: wantShots[j] })); }
        catch (e) {
          if (e instanceof CrawlStopped) { done.push({ url: batch[j].url, type: batch[j].type, skipped: e.message, stopped: e.message }); continue; }
          done.push({ url: batch[j].url, type: batch[j].type, error: e.message });
        }
      }
      return done;
    });
    for (const r of out) { results.push(r); if (r.stopped) stopped = r.stopped; }
    if (out.some((r) => r.skipped === 'cancelled')) return { cancelled: true };
  }
  await step('page-statuses', () => sink.setLinkStatuses(auditId, results.filter((r) => r.status).map((r) => ({ url: r.url, status: r.status }))).then(() => null));
  await step('fetch-log', () => stage('fetch', `${results.filter((r) => r.page_id).length} pages fetched and rendered; ${results.filter((r) => r.challenged).length} challenged${stopped ? `; stopped early: ${stopped}` : ''}`).then(() => null));

  // ---------------------------------------------------------------- 5. link and sitemap URL checks (status only)
  const sampled = new Set(sample.map((p) => p.url));
  const targets = [...new Set([...results.flatMap((r) => r.internalLinks || []), ...pre.sitemapSample])]
    .filter((u) => !sampled.has(u) && isAllowed(robots, BOT_TOKEN, pathOf(u)).allowed).slice(0, MAX_LINK_CHECKS);
  for (let i = 0; i < targets.length && !stopped; i += LINK_BATCH) {
    const batch = targets.slice(i, i + LINK_BATCH);
    const r = await step(`links-${i / LINK_BATCH}`, async () => {
      if (await cancelled()) return { cancelled: true };
      await wait(gapMs);
      const f = fetcher();
      const statuses = [];
      for (const u of batch) {
        try {
          // sitemap URLs are read in full (to see a noindex); other links only need their status
          const fromSitemap = pre.sitemapSample.includes(u);
          let res = fromSitemap ? await f.get(u) : await f.get(u, { method: 'HEAD', body: false });
          if (!fromSitemap && ([405, 501].includes(res.status) || res.error)) res = await f.get(u, { body: false });
          if (fromSitemap && res.status === 200 && !res.challenge) {
            const robotsMeta = metas(res.body || '').robots || '';
            const xr = (res.headers && res.headers['x-robots-tag']) || '';
            if (/noindex/i.test(`${robotsMeta} ${xr}`)) await sink.addEvidence({ audit_id: auditId, kind: 'sitemap', url: u, content: `Listed in the sitemap; the page says noindex (${[robotsMeta && `meta robots: ${robotsMeta}`, xr && `X-Robots-Tag: ${xr}`].filter(Boolean).join('; ')}).` });
          }
          statuses.push({ url: u, status: res.status || null, final_url: res.finalUrl || null, hops: res.chain ? res.chain.map((c) => c.status) : [], challenge: !!res.challenge, error: res.error || null });
        } catch (e) { if (e instanceof CrawlStopped) return { statuses, stopped: e.message }; throw e; }
      }
      await sink.setLinkStatuses(auditId, statuses);
      return { statuses };
    });
    if (r.cancelled) return { cancelled: true };
    if (r.stopped) stopped = r.stopped;
    for (const s of r.statuses) if (pre.sitemapSample.includes(s.url) && s.status && s.status !== 200) {
      await step(`sitemap-url-${s.url}`, () => sink.addEvidence({ audit_id: auditId, kind: 'sitemap', url: s.url,
        content: `Listed in the sitemap; answered HTTP ${s.status}${s.hops.length ? ` after ${s.hops.join(' → ')} redirect(s) to ${s.final_url}` : ''}.` }).then(() => null));
    }
  }

  await step('finish', async () => {
    log.push({ stage: 'crawl', done: true, at: new Date().toISOString(), note: `${targets.length} links and sitemap URLs checked` });
    await sink.updateAudit(auditId, { status: 'checking', stage_log: log, error: stopped ? `Crawl stopped early: ${stopped} Findings that depend on the missing pages will be marked "needs verification".` : null });
    return null;
  });
  const checked = await step('checks', () => runChecksStep({ auditId, sink }));
  if (deps.notify) await step('notify', () => deps.notify(auditId, 'complete').catch((e) => ({ error: e.message })));
  return { pages: results.length, links: targets.length, stopped, findings: checked.findings };
}

/** One page: raw fetch, browser render, facts from both, the difference, and evidence. */
async function processPage({ auditId, page, n, site, prefix, f, deps, wait, gapMs, screenshot }) {
  const { sink } = deps;
  const raw = await f.get(page.url);
  const base = `${prefix}pages/${String(n).padStart(3, '0')}`;
  const isHtml = /html/i.test((raw.headers && raw.headers['content-type']) || '') || /<html|<!doctype/i.test(raw.body || '');
  const row = {
    audit_id: auditId, url: page.url, final_url: raw.finalUrl || null, page_type: page.type, discovered_via: page.via === 'nav' ? 'nav' : page.via || 'link',
    status_code: raw.status || null, redirect_chain: raw.chain || [], headers: raw.headers || {}, fetched_at: raw.fetchedAt,
    x_robots_tag: raw.headers ? raw.headers['x-robots-tag'] || null : null, challenge: raw.challenge || null,
    robots_txt_allows: { aiaeauditbot: true },
  };
  let rawSide = null;
  if (raw.body && isHtml) {
    await sink.saveFile(`${base}-raw.html`, raw.body, 'text/html');
    row.raw_html_path = `${base}-raw.html`;
    const sd = structuredData(raw.body);
    rawSide = { facts: pageFacts(raw.body, raw.finalUrl || page.url), sd, vehicle: vehicleFacts(raw.body, sd), phones: phones(raw.body) };
    row.canonical_raw = rawSide.facts.canonicals[0] || null;
  }
  if (raw.error) row.challenge = null;

  // Render unless the raw fetch failed outright, wasn't HTML, or was an error page. Challenged pages are still
  // rendered once: a challenge can be passive for browsers, and that difference is itself evidence.
  let rend = null; let rendSide = null;
  if (deps.render && ((raw.status && raw.status < 400 && isHtml) || raw.challenge)) {
    await wait(gapMs);
    rend = await deps.render(raw.finalUrl || page.url, { screenshot });
    if (rend && rend.html) {
      rend.challenge = detectChallenge({ status: rend.status || 200, html: rend.html });
      await sink.saveFile(`${base}-rendered.html`, rend.html, 'text/html');
      row.rendered_html_path = `${base}-rendered.html`;
      row.rendered_at = rend.renderedAt;
      if (rend.screenshot) { await sink.saveFile(`${base}.jpg`, rend.screenshot, rend.screenshotType || 'image/jpeg'); row.screenshot_path = `${base}.jpg`; }
      if (!rend.challenge) {
        const sd = structuredData(rend.html);
        rendSide = { facts: pageFacts(rend.html, raw.finalUrl || page.url), sd, vehicle: vehicleFacts(rend.html, sd), phones: phones(rend.html) };
        row.canonical_rendered = rendSide.facts.canonicals[0] || null;
      } else if (!row.challenge) row.challenge = { ...rend.challenge, via: 'browser' };
    } else if (rend && rend.error) row.render_diff = { render_error: rend.error };
  }

  const best = rendSide || (row.challenge ? null : rawSide);
  if (best) {
    Object.assign(row, { title: best.facts.title, meta_description: best.facts.meta_description, meta_robots: best.facts.meta_robots, h1: best.facts.h1, word_count: best.facts.word_count });
    row.page_type = refineType(page.type, { vehicle: best.vehicle, title: best.facts.title });
  }
  if (rawSide && rendSide) row.render_diff = { ...(row.render_diff || {}), ...(renderDiff(rawSide, rendSide) || {}) };
  if (row.render_diff && !Object.keys(row.render_diff).length) row.render_diff = null;
  const pageId = await sink.upsertPage(row);
  await sink.clearPage(pageId); // a retried step must not duplicate this page's rows

  // structured data, vehicle, links, evidence
  const sdRows = [];
  for (const [source, side] of [['raw', rawSide], ['rendered', rendSide]]) if (side) for (const b of side.sd) sdRows.push({ audit_id: auditId, page_id: pageId, source, format: b.format, types: b.types, data: b.data, excerpt: b.excerpt, parse_error: b.parse_error });
  if (sdRows.length) await sink.insert('seo_structured_data', sdRows);

  const v = best && best.vehicle;
  if (v) {
    const seenAfter = v.visible_price && rend && rend.timeline && rend.timeline.prices ? rend.timeline.prices[`$${Number(v.visible_price).toLocaleString('en-US')}`] ?? null : null;
    const { price_lines: _pl, ...vrow } = v;
    await sink.insert('seo_vehicles_observed', [{ audit_id: auditId, page_id: pageId, ...vrow, price_seen_after_ms: seenAfter, observed_at: (rend && rend.renderedAt) || raw.fetchedAt }]);
  }
  const links = best ? pageLinks(rend && rendSide ? rend.html : raw.body, raw.finalUrl || page.url, site) : [];
  if (links.length) await sink.insert('seo_links', links.slice(0, 500).map((l) => ({ audit_id: auditId, from_page: pageId, to_url: l.to_url, anchor: l.anchor, rel: l.rel, internal: l.internal })));

  const ev = [{ audit_id: auditId, page_id: pageId, kind: 'header', url: page.url, content: cap(JSON.stringify({ status: raw.status || null, error: raw.error || null, redirect_chain: raw.chain || [], headers: raw.headers || {} }, null, 1)) }];
  if (row.challenge) ev.push({ audit_id: auditId, page_id: pageId, kind: 'html_excerpt', url: page.url, content: cap(`${row.challenge.signals.join('; ')}\n\n${(rend && rend.challenge ? rend.html : raw.body || '').slice(0, 1500)}`, 4000), selector: 'challenge' });
  for (const [k, side, html] of [['raw', rawSide, raw.body], ['rendered', rendSide, rend && rend.html]]) {
    if (!side) continue;
    const can = excerpt(html, /<link[^>]+rel=["']?canonical[^>]*>/i, 0);
    if (can) ev.push({ audit_id: auditId, page_id: pageId, kind: 'html_excerpt', url: page.url, content: can.slice(0, 500), selector: `${k}: link[rel=canonical]` });
    const t = excerpt(html, /<title\b[^>]*>[\s\S]*?<\/title>/i, 0);
    if (t) ev.push({ audit_id: auditId, page_id: pageId, kind: 'html_excerpt', url: page.url, content: t.slice(0, 500), selector: `${k}: title` });
  }
  if (v && rendSide) {
    const carLd = rendSide.sd.find((b) => b.types.some((t) => /Car|Vehicle|Product/.test(t)));
    if (carLd && carLd.excerpt) ev.push({ audit_id: auditId, page_id: pageId, kind: 'schema_excerpt', url: page.url, content: carLd.excerpt.slice(0, 4000), selector: 'rendered: script[type=application/ld+json]' });
    const priceTxt = v.visible_price ? `$${Number(v.visible_price).toLocaleString('en-US')}` : null;
    const px = priceTxt && excerpt(rend.html, priceTxt, 400);
    if (px) ev.push({ audit_id: auditId, page_id: pageId, kind: 'html_excerpt', url: page.url, content: px, selector: 'rendered: visible price' });
  }
  if (row.screenshot_path) ev.push({ audit_id: auditId, page_id: pageId, kind: 'screenshot', url: page.url, storage_path: row.screenshot_path });
  for (const e of ev) if (e.content) e.sha256 = await sha256(e.content);
  await sink.insert('seo_evidence', ev);

  return { url: page.url, type: row.page_type, page_id: pageId, status: raw.status || null, challenged: !!row.challenge,
    internalLinks: links.filter((l) => l.internal).map((l) => l.to_url).slice(0, 300) };
}
