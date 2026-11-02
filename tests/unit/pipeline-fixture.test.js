// Stage 2 end to end against the fake dealer site: real HTTP, a real local browser, the in-memory sink.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startFixture, requests, VEHICLES } from '../../fixtures/dealer-site/server.mjs';
import { runAudit } from '../../crawler/pipeline.js';
import { memorySink } from '../../crawler/sink-memory.js';
import { renderWithPlaywright } from '../../crawler/render.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

let site, browser, sink, result;
const AUDIT = 'a0000000-0000-4000-8000-000000000001';
const page = (p) => sink.db.seo_pages.find((x) => x.url === site.origin + p);
const vehicle = (vin) => sink.db.seo_vehicles_observed.find((v) => v.vin === vin);

test.before(async () => {
  site = await startFixture();
  browser = await chromium.launch();
  sink = memorySink({ id: AUDIT, dealership_name: 'Coastal Test Chevrolet', site_url: `${site.origin}/`, authorized: true, status: 'crawling',
    sample_plan: { new: 10, used: 10, certified: 5, city: 3 }, page_budget: 60, created_at: '2026-11-02T12:00:00Z' });
  const steps = [];
  result = await runAudit({ auditId: AUDIT, step: async (name, fn) => { steps.push(name); return fn(); },
    deps: { sink, render: renderWithPlaywright(browser, { settleMs: 3200 }), allowPrivate: true, gapMs: 30 } });
  result.steps = steps;
});
test.after(async () => { await browser.close(); await site.close(); });

test('the audit finishes, ready for checks, with every stage logged', () => {
  const a = sink.db.seo_audits[0];
  assert.equal(a.status, 'review', a.error);
  assert.deepEqual(a.stage_log.map((s) => s.stage), ['preflight', 'sample', 'fetch', 'crawl', 'checks']);
  assert.ok(result.steps.includes('preflight') && result.steps.some((s) => s.startsWith('pages-')) && result.steps.some((s) => s.startsWith('links-')));
});

test('manners: our user agent, robots.txt respected, nothing off-site or disallowed fetched', () => {
  assert.ok(requests.length > 20);
  assert.ok(requests.every((r) => /AIAEAuditBot\/1\.0/.test(r.ua)), 'every request identifies the bot');
  assert.ok(!requests.some((r) => r.path.startsWith('/private-tools/')), 'robots.txt Disallow for AIAEAuditBot honoured');
  assert.ok(!requests.some((r) => r.path.startsWith('/search') || r.path.startsWith('/cart')));
  const ev = sink.db.seo_evidence.find((e) => e.kind === 'robots' && /private-tools/.test(e.content) && /Not fetched/.test(e.content));
  assert.ok(ev, 'skipped URLs recorded as evidence');
});

test('sampling covers every page type the shopper meets', () => {
  const types = new Set(sink.db.seo_pages.map((p) => p.page_type));
  for (const t of ['home', 'srp_new', 'srp_used', 'srp_certified', 'vdp_new', 'vdp_used', 'vdp_certified', 'specials', 'finance', 'service', 'certified_info', 'contact', 'city'])
    assert.ok(types.has(t), `missing ${t}: ${[...types]}`);
  assert.equal(sink.db.seo_pages.filter((p) => p.page_type === 'city').length, 3, 'city pages capped by the plan');
});

test('delayed price: absent from the raw HTML, measured in the rendered page', () => {
  const p = page(VEHICLES.delayed.path);
  assert.equal(p.render_diff.visible_price.raw, null);
  assert.equal(p.render_diff.visible_price.rendered, 52995);
  const v = vehicle(VEHICLES.delayed.vin);
  assert.equal(v.visible_price, 52995);
  assert.equal(v.schema_price, 52995);
  assert.ok(v.price_seen_after_ms >= 2000 && v.price_seen_after_ms < 6000, `seen after ${v.price_seen_after_ms} ms`);
});

test('conditional rebates are recorded as conditional, the selling price matches the schema', () => {
  const v = vehicle(VEHICLES.conditional.vin);
  assert.equal(v.visible_price, 32495);
  assert.equal(v.schema_price, 32495);
  assert.equal(v.msrp, 33995);
  assert.ok(v.discounts.filter((d) => d.conditional).length >= 2, JSON.stringify(v.discounts));
  assert.match(v.fees_text, /\$999 dealer fee/);
});

test('stale schema facts on the sold car, with time and evidence', () => {
  const v = vehicle(VEHICLES.stale.vin);
  assert.deepEqual([v.page_availability, v.schema_availability, v.visible_price, v.schema_price], ['sold', 'InStock', 38900, 41900]);
  assert.ok(v.observed_at);
  const p = page(VEHICLES.stale.path);
  assert.ok(sink.db.seo_evidence.some((e) => e.page_id === p.id && e.kind === 'schema_excerpt' && /41900/.test(e.content)));
});

test('duplicate URL: the query version has no canonical; the clean one points to itself', () => {
  const dup = page(VEHICLES.duplicate.alt);
  const main = page(VEHICLES.duplicate.path);
  assert.ok(dup && main, 'both sampled');
  assert.equal(dup.canonical_rendered, null);
  assert.equal(main.canonical_rendered, site.origin + VEHICLES.duplicate.path);
});

test('call-tracking number: raw vs rendered phone recorded, script named', () => {
  const home = page('/');
  assert.deepEqual(home.render_diff.phones.raw, ['3865550100']);
  assert.ok(home.render_diff.phones.rendered.includes('3865550199'), 'tracking number appears only after scripts run');
  assert.match(home.render_diff.phones.call_tracking, /swap|callrail/i);
});

test('HTTP 200 challenge and 403 block are flagged as challenges, not audited as content', () => {
  const c = page('/challenge-test/');
  assert.equal(c.status_code, 200);
  assert.equal(c.challenge.vendor, 'Cloudflare');
  assert.ok(!c.title, 'challenge text never becomes the page title');
  const b = page('/inventory/used-blocked/');
  assert.equal(b.status_code, 403);
  assert.ok(b.challenge, 'Akamai block flagged');
  assert.ok(sink.db.seo_evidence.some((e) => e.page_id === c.id && e.selector === 'challenge' && /Just a moment/.test(e.content)));
});

test('certification text on the certified car; CPO program page fetched', () => {
  assert.match(vehicle(VEHICLES.certified.vin).certification_text, /150-point/);
  assert.ok(sink.db.seo_pages.some((p) => p.page_type === 'certified_info'));
});

test('sitemaps, redirects, broken links and noindex are recorded for the checks', () => {
  const sm = sink.db.seo_evidence.find((e) => e.kind === 'sitemap' && /files/.test(e.content || ''));
  const info = JSON.parse(sm.content);
  assert.ok(info.problems.some((p) => /sitemap-missing\.xml$/.test(p.url) && p.status === 404), 'missing child sitemap');
  assert.ok(sink.files.has('coastal-test-chevrolet/2026-11-02/' + AUDIT + '/sitemap-urls.json'), 'full sitemap list stored by dealership and date');
  const linkStatus = (p) => (sink.db.seo_links.find((l) => l.to_url === site.origin + p && l.status_code != null) || {}).status_code;
  assert.equal(linkStatus('/old-page/'), 404, 'broken internal link');
  assert.equal(linkStatus('/inventory/used-2018-gone-xxxxx/'), 404, 'sitemap URL that 404s');
  assert.ok(sink.db.seo_evidence.some((e) => e.kind === 'sitemap' && /used-2018-gone/.test(e.url) && /HTTP 404/.test(e.content)));
  const ty = page('/thank-you/');
  if (ty) assert.match(ty.meta_robots, /noindex/);
  const chainLink = sink.db.seo_links.find((l) => l.to_url === site.origin + '/http-old' && l.status_code != null);
  assert.ok(chainLink, 'redirecting link checked');
});

test('files: raw + rendered HTML per page and screenshots, under the audit folder', () => {
  const p = page('/');
  assert.ok(sink.files.has(p.raw_html_path) && sink.files.has(p.rendered_html_path) && sink.files.has(p.screenshot_path));
  assert.ok(p.raw_html_path.startsWith(`coastal-test-chevrolet/2026-11-02/${AUDIT}/pages/`));
  assert.ok(!/data-aiae-timeline/.test(sink.files.get(p.rendered_html_path)), 'our timing marker is stripped from stored HTML');
  for (const e of sink.db.seo_evidence) assert.ok(e.content || e.storage_path, 'evidence has content or a file');
});

test('every row the crawler writes uses real database columns and allowed values', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const dir = new URL('../../supabase/migrations/', import.meta.url);
  const sql = readdirSync(dir).sort().map((f) => readFileSync(new URL(f, dir), 'utf8')).join('\n');
  const cols = {};
  for (const m of sql.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g))
    cols[m[1]] = m[2].split('\n').flatMap((l) => l.trim().split(/,\s+(?=[a-z_]+\s+(int|text|numeric)\b)/).map((x) => (x || '').match(/^([a-z_0-9]+)\s+(?!key\b)/))).filter(Boolean).map((x) => x[1]);
  for (const t of ['seo_pages', 'seo_links', 'seo_structured_data', 'seo_vehicles_observed', 'seo_evidence'])
    for (const r of sink.db[t]) for (const k of Object.keys(r)) assert.ok(k === 'id' || cols[t].includes(k), `${t}.${k} isn't a column`);
  const kinds = new Set(['html_excerpt', 'schema_excerpt', 'screenshot', 'header', 'robots', 'sitemap', 'measurement', 'upload_excerpt', 'note']);
  assert.ok(sink.db.seo_evidence.every((e) => kinds.has(e.kind) && (!e.content || e.content.length <= 20000)));
  assert.ok(sink.db.seo_pages.every((p) => ['start', 'sitemap', 'nav', 'link', 'inventory'].includes(p.discovered_via)));
  assert.ok(sink.db.seo_vehicles_observed.every((v) => ['new', 'used', 'certified', 'unknown'].includes(v.condition)));
});

// ---------------- Stage 3: the checks, judged against fixtures/dealer-site/EXPECTED.json ----------------
test('checks: every expected outcome for the fake dealer site', async () => {
  const { readFileSync } = await import('node:fs');
  const expected = JSON.parse(readFileSync(new URL('../../fixtures/dealer-site/EXPECTED.json', import.meta.url), 'utf8'));
  const fs = sink.db.seo_findings;
  assert.equal(sink.db.seo_audits[0].status, 'review');
  for (const c of expected.cases) {
    const url = site.origin + c.url;
    // city pages are sampled (3 of 5, seeded by URL), so any of them counts for that case
    const hits = fs.filter((f) => f.rule_id === c.expect.rule && (c.case === 'city_pages' ? f.affected_urls.some((u) => /-chevrolet-dealer\/$/.test(u)) : f.affected_urls.includes(url)));
    if (c.expect.status === 'none') assert.equal(hits.length, 0, `${c.case}: ${c.expect.rule} must not be reported for ${c.url}`);
    else {
      assert.ok(hits.length, `${c.case}: expected ${c.expect.rule} on ${c.url}; got ${fs.map((f) => f.rule_id).join(', ')}`);
      assert.ok(hits.some((f) => f.status === c.expect.status), `${c.case}: status ${hits.map((f) => f.status)} ≠ ${c.expect.status}`);
    }
  }
});

test('checks: every finding is complete, cites real evidence, and makes no forbidden claims', () => {
  const evIds = new Set(sink.db.seo_evidence.map((e) => e.id));
  for (const f of sink.db.seo_findings) {
    for (const k of ['rule_id', 'category', 'title', 'status', 'priority', 'observed_at', 'significance', 'recommended_fix', 'responsible_party', 'acceptance_criteria'])
      assert.ok(f[k], `${f.rule_id} missing ${k}`);
    assert.ok(f.affected_urls.length >= 1, `${f.rule_id} has no URL`);
    assert.ok(f.evidence_ids.length >= 1 && f.evidence_ids.every((id) => evIds.has(id)), `${f.rule_id} evidence ${f.evidence_ids}`);
    const text = `${f.title} ${f.significance} ${f.recommended_fix}`;
    assert.doesNotMatch(text, /(?<!does not show that )google (is|was) blocked|penalt(y|ies|ized)|lost (traffic|sales|revenue|leads)|\$[\d,]+ (in|of) (lost|missed)|bad platform|poor platform/i, `${f.rule_id}: ${text.slice(0, 120)}`);
  }
  const ch = sink.db.seo_findings.find((f) => f.rule_id === 'technical.crawler_challenged');
  assert.match(ch.significance, /does not show that Google is blocked/);
  const city = sink.db.seo_findings.find((f) => f.rule_id === 'local.interchangeable_city_pages');
  assert.match(city.recommended_fix, /Do not create more/);
  const stale = sink.db.seo_findings.find((f) => f.rule_id === 'inventory.schema_stale');
  assert.equal(stale.facts.vin, '1FTFW1E50MFA00003');
  assert.ok(stale.observed_at);
  const late = sink.db.seo_findings.find((f) => f.rule_id === 'inventory.price_loads_late');
  assert.ok(late && late.affected_urls.includes(site.origin + VEHICLES.delayed.path), 'late price noted as an opportunity');
  assert.ok(sink.db.seo_findings.some((f) => f.rule_id === 'local.gbp_needs_access' && f.status === 'needs_verification' && f.responsible_party === 'gbp_owner'), 'Business Profile kept separate');
});

test('checks can be re-run: draft findings replaced, reviewed ones kept', async () => {
  const { runChecksStep } = await import('../../crawler/run-checks.js');
  const first = sink.db.seo_findings.length;
  sink.db.seo_findings[0].review_status = 'approved';
  const kept = sink.db.seo_findings[0].id;
  await runChecksStep({ auditId: AUDIT, sink });
  assert.ok(sink.db.seo_findings.some((f) => f.id === kept), 'approved finding kept');
  assert.equal(sink.db.seo_findings.length, first + 1, 'drafts replaced, not duplicated (the approved one plus a fresh draft of it)');
});
