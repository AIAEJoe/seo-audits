// The GitHub Actions runner: a real Chrome fetches and renders the fake dealer site through the same pipeline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFixture, requests, VEHICLES } from '../../fixtures/dealer-site/server.mjs';
import { memorySink } from '../../crawler/sink-memory.js';
import { browserFetch } from '../../crawler/browser-fetch.js';
import { createFetcher } from '../../crawler/fetcher.js';
import { runInBrowser } from '../../runner/crawl.mjs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const AUDIT = 'b0000000-0000-4000-8000-000000000002';
let site;
test.before(async () => { site = await startFixture(); });
test.after(async () => { await site.close(); });

test('browser fetch: raw server HTML, every redirect hop, challenges reported, Chrome identity', async () => {
  const browser = await chromium.launch();
  try {
    const ctx = await browser.newContext({ userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 TestRunner' });
    const f = createFetcher({ siteUrl: `${site.origin}/`, fetchImpl: browserFetch(ctx, { challengeWaitMs: 300 }), userAgent: 'Mozilla/5.0 Chrome/131.0.0.0 TestRunner', gapMs: 10, allowPrivate: true });
    const r = await f.get(`${site.origin}/http-old`);
    assert.deepEqual(r.chain.map((h) => [new URL(h.url).pathname, h.status]), [['/http-old', 302], ['/http-old-2', 301]]);
    assert.equal(new URL(r.finalUrl).pathname, '/specials/');
    assert.equal(r.status, 200);
    const robots = await f.get(`${site.origin}/robots.txt`);
    assert.match(robots.body, /^User-agent: \*/, 'robots.txt read as plain text, not the browser\'s view of it');
    const c = await f.get(`${site.origin}/challenge-test/`);
    assert.ok(c.challenge, 'a challenge that stays is reported, not worked around');
    const home = await f.get(`${site.origin}/`);
    assert.ok(!/data-aiae-timeline/.test(home.body), 'raw HTML, not the rendered page');
    assert.ok(requests.filter((q) => q.path === '/http-old-2').every((q) => /TestRunner/.test(q.ua)));
  } finally { await browser.close(); }
});

test('a full audit through the runner: pages fetched and rendered, checks run, robots.txt still honoured', async () => {
  const sink = memorySink({ id: AUDIT, dealership_name: 'Coastal Test Chevrolet', site_url: `${site.origin}/`, authorized: true, status: 'crawling',
    sample_plan: { new: 3, used: 3, certified: 1, city: 1 }, page_budget: 20, created_at: '2026-11-02T12:00:00Z' });
  const before = requests.length;
  let sent = null;
  await runInBrowser({ auditId: AUDIT, env: {}, sink, chromium, extraDeps: { allowPrivate: true, gapMs: 20, notify: async (id, kind) => { sent = kind; } } });
  const a = sink.db.seo_audits[0];
  assert.equal(a.status, 'review', a.error);
  assert.equal(sent, 'complete');
  const mine = requests.slice(before);
  assert.ok(mine.length > 15);
  assert.ok(mine.every((q) => /Chrome\/\d+/.test(q.ua) && !/HeadlessChrome|AIAEAuditBot/.test(q.ua)), 'standard Chrome identity');
  assert.ok(!mine.some((q) => q.path.startsWith('/private-tools/') || q.path.startsWith('/search')), 'robots.txt still honoured');
  const p = sink.db.seo_pages.find((x) => x.url === site.origin + VEHICLES.delayed.path);
  if (p) assert.equal(p.render_diff.visible_price.rendered, 52995, 'rendered with the phone browser');
  assert.ok(sink.db.seo_pages.some((x) => x.rendered_html_path && x.screenshot_path));
  assert.ok(sink.db.seo_findings.length > 0);
});
