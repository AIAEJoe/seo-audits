import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRobots, isAllowed } from '../../crawler/robots.js';
import { parseSitemap } from '../../crawler/sitemap.js';
import { detectChallenge } from '../../crawler/challenge.js';
import { isPublicTarget, normalizeUrl, sameSite } from '../../crawler/url.js';
import { pageFacts, pageLinks, vehicleFacts, priceLines, phones, structuredData } from '../../crawler/extract.js';
import { classifyUrl } from '../../crawler/classify.js';
import { createFetcher } from '../../crawler/fetcher.js';

test('robots.txt: Google semantics (specific group, longest match, Allow wins ties, wildcards)', () => {
  const r = parseRobots(`# comment
User-agent: *
Disallow: /search
Disallow: /*?sort=
Allow: /search/help
Disallow: /*.pdf$

User-agent: Googlebot
User-agent: AIAEAuditBot
Disallow: /private-tools/
Allow: /private-tools/public

Sitemap: https://dealer.com/sitemap.xml`);
  assert.deepEqual(r.sitemaps, ['https://dealer.com/sitemap.xml']);
  assert.equal(isAllowed(r, 'aiaeauditbot', '/search').allowed, true, 'our own group replaces *');
  assert.equal(isAllowed(r, 'aiaeauditbot', '/private-tools/x').allowed, false);
  assert.equal(isAllowed(r, 'aiaeauditbot', '/private-tools/public').allowed, true, 'longer Allow wins');
  assert.equal(isAllowed(r, 'googlebot', '/private-tools/x').agent, 'googlebot');
  assert.equal(isAllowed(r, 'bingbot', '/search').allowed, false);
  assert.equal(isAllowed(r, 'bingbot', '/search/help').allowed, true);
  assert.equal(isAllowed(r, 'bingbot', '/used?sort=price').allowed, false, '* wildcard');
  assert.equal(isAllowed(r, 'bingbot', '/brochure.pdf').allowed, false, '$ anchor');
  assert.equal(isAllowed(r, 'bingbot', '/brochure.pdf?x').allowed, true);
  assert.equal(isAllowed(parseRobots(''), 'x', '/a').allowed, true, 'no robots.txt allows everything');
  assert.equal(isAllowed(parseRobots('User-agent: *\nDisallow:'), 'x', '/a').allowed, true, 'empty Disallow allows');
});

test('sitemaps and sitemap indexes', () => {
  const idx = parseSitemap('<?xml version="1.0"?><sitemapindex><sitemap><loc>https://d.com/a.xml</loc><lastmod>2026-10-01</lastmod></sitemap></sitemapindex>');
  assert.deepEqual(idx, { type: 'index', entries: [{ loc: 'https://d.com/a.xml', lastmod: '2026-10-01' }] });
  const set = parseSitemap('<urlset><url><loc><![CDATA[https://d.com/x?a=1&amp;b=2]]></loc></url><url><loc> https://d.com/y </loc></url></urlset>');
  assert.equal(set.type, 'urlset');
  assert.deepEqual(set.entries.map((e) => e.loc), ['https://d.com/x?a=1&b=2', 'https://d.com/y']);
});

test('challenge detection, including HTTP 200 challenges; a contact-form CAPTCHA is not a challenge', () => {
  const cf = detectChallenge({ status: 200, headers: { 'cf-mitigated': 'challenge' }, html: '<title>Just a moment...</title><script>window._cf_chl_opt={}</script>' });
  assert.equal(cf.vendor, 'Cloudflare');
  assert.ok(cf.signals.length >= 2);
  assert.equal(detectChallenge({ status: 403, headers: { server: 'AkamaiGHost' }, html: '<title>Access Denied</title><h1>Access Denied</h1> Reference #18.1' }).vendor, 'Akamai');
  assert.ok(detectChallenge({ status: 200, html: '<script src="/_Incapsula_Resource?x"></script>' }));
  assert.ok(detectChallenge({ status: 429, html: 'slow down' }));
  const form = `<title>Contact</title><main>${'Real dealership content about trucks and service. '.repeat(60)}</main><div class="g-recaptcha"></div>`;
  assert.equal(detectChallenge({ status: 200, html: form }), null);
  assert.equal(detectChallenge({ status: 200, html: '<title>Home</title><p>Welcome</p>' }), null);
});

test('only public web addresses on the audited site', () => {
  for (const bad of ['http://127.0.0.1/', 'http://10.1.2.3/', 'http://169.254.169.254/latest/meta-data', 'http://localhost/', 'http://[::1]/', 'http://server.internal/', 'ftp://d.com/', 'http://8.8.8.8/'])
    assert.equal(isPublicTarget(bad), false, bad);
  assert.equal(isPublicTarget('https://www.newsmyrnachevy.com/x'), true);
  assert.equal(sameSite('https://newsmyrnachevy.com/a', 'https://www.newsmyrnachevy.com/'), true);
  assert.equal(sameSite('https://cdn.dealer.com/a', 'https://www.newsmyrnachevy.com/'), false);
  assert.equal(normalizeUrl('/a/b?x=1#top', 'https://www.D.com:443/'), 'https://www.d.com/a/b?x=1');
});

test('page facts, links and structured data', () => {
  const html = `<html lang="en"><head><title>Used 2019 Civic | Dealer</title><meta name="description" content="A &amp; B">
    <meta name="robots" content="index,follow"><link rel="canonical" href="/inventory/civic/">
    <script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"AutoDealer","name":"D"},{"@type":"Car","vehicleIdentificationNumber":"2HGFC1F30KH000004","offers":{"@type":"Offer","price":"18995","availability":"https://schema.org/InStock"}}]}</script>
    <script type="application/ld+json">{ broken </script></head>
    <body><h1>Used 2019 Honda Civic</h1><a href="/a">A</a><a href="https://other.com/">x</a><a href="tel:123">t</a><a href="#top">top</a></body></html>`;
  const f = pageFacts(html, 'https://www.d.com/inventory/civic/?utm=1');
  assert.equal(f.title, 'Used 2019 Civic | Dealer');
  assert.equal(f.meta_description, 'A & B');
  assert.deepEqual(f.canonicals, ['https://www.d.com/inventory/civic/']);
  assert.deepEqual(f.h1, ['Used 2019 Honda Civic']);
  const links = pageLinks(html, 'https://www.d.com/x', 'https://www.d.com/');
  assert.deepEqual(links.map((l) => [l.to_url, l.internal]), [['https://www.d.com/a', true], ['https://other.com/', false]]);
  const sd = structuredData(html);
  assert.deepEqual(sd[0].types, ['AutoDealer', 'Car']);
  assert.match(sd[1].parse_error, /doesn't parse/);
});

test('pricing: selling price, MSRP, discounts, and conditional offers kept apart', () => {
  const text = 'MSRP $33,995\nDealer discount -$1,500\nSelling price $32,495\nGM Financial bonus cash -$1,000 Must finance with GM Financial.\nPrice with all offers $30,995\nPlus tax, tag, title and a $999 dealer fee.';
  const lines = priceLines(text);
  assert.deepEqual(lines.map((l) => [l.kind, l.amount]), [['msrp', 33995], ['discount', -1500], ['price', 32495], ['conditional', -1000], ['conditional', 30995], ['fee', 999]]);
  const v = vehicleFacts(`<body><h1>New 2026 Equinox</h1><p>VIN 3GNAXUEV1TL100002</p><p>Stock # N1002</p>${text.split('\n').map((l) => `<div>${l}</div>`).join('')}
    <script type="application/ld+json">{"@type":"Car","vehicleIdentificationNumber":"3GNAXUEV1TL100002","itemCondition":"https://schema.org/NewCondition","offers":{"price":32495,"priceCurrency":"USD","availability":"https://schema.org/InStock"}}</script></body>`);
  assert.equal(v.vin, '3GNAXUEV1TL100002');
  assert.equal(v.stock_number, 'N1002');
  assert.equal(v.visible_price, 32495);
  assert.equal(v.schema_price, 32495);
  assert.equal(v.msrp, 33995);
  assert.equal(v.condition, 'new');
  assert.equal(v.discounts.filter((d) => d.conditional).length, 2);
  assert.match(v.fees_text, /\$999 dealer fee/);
});

test('sold car with stale schema; certification text', () => {
  const v = vehicleFacts(`<body><h1>Used 2021 F-150</h1><div class="status">SOLD</div><dd>1FTFW1E50MFA00003</dd><div>Price <span>$38,900</span></div>
    <p>150-point vehicle inspection and reconditioning.</p><p>6-Year/100,000-Mile Powertrain Limited Warranty</p>
    <script type="application/ld+json">{"@type":"Car","vehicleIdentificationNumber":"1FTFW1E50MFA00003","itemCondition":"https://schema.org/UsedCondition","offers":{"price":41900,"availability":"https://schema.org/InStock"}}</script></body>`);
  assert.deepEqual([v.page_availability, v.schema_availability, v.visible_price, v.schema_price], ['sold', 'InStock', 38900, 41900]);
  assert.match(v.certification_text, /150-point/);
  assert.match(v.warranty_text, /Powertrain/);
  assert.equal(vehicleFacts('<body><h1>Service</h1><p>Call $99 oil change</p></body>'), null, 'not a vehicle page');
});

test('phone numbers and call-tracking scripts', () => {
  const p = phones('<body><a class="phone" href="tel:3865550100">(386) 555-0100</a> Service 386.555.0101</body><script src="https://cdn.callrail.com/swap.js"></script>');
  assert.deepEqual(p.numbers.map((n) => n.digits), ['3865550100', '3865550101']);
  assert.match(p.call_tracking, /callrail/i);
});

test('page types from dealership URLs', () => {
  const s = 'https://www.newsmyrnachevy.com/';
  const cases = {
    '/': 'home', '/new-vehicles/': 'srp_new', '/used-vehicles/': 'srp_used', '/certified-vehicles/': 'srp_certified', '/searchnew.aspx': 'srp_new',
    '/inventory/new-2026-chevrolet-silverado-1500-lt-1gcuyded5tz100001/': 'vdp_new', '/inventory/used-2021-ford-f-150-xlt-1ftfw1e50mfa00003/': 'vdp_used',
    '/inventory/certified-2023-chevrolet-tahoe-lt-1gnskbkd0pr000005/': 'vdp_certified', '/vdp?vin=2HGFC1F30KH000004': 'vdp_used',
    '/finance/': 'finance', '/service/': 'service', '/specials/': 'specials', '/daytona-beach-chevrolet-dealer/': 'city', '/contact/': 'contact',
    '/certified-program/': 'certified_info', '/new-chevrolet-silverado-1500/': 'model',
  };
  for (const [p, t] of Object.entries(cases)) assert.equal(classifyUrl(s.replace(/\/$/, '') + p, s), t, p);
});

test('fetcher: identifies itself, spaces requests, at most two at a time, stays on the site', async () => {
  // Real timers with a short gap (production uses 2 s).
  const log = []; let inflight = 0; let peak = 0;
  const fakeFetch = async (url, opts) => { inflight++; peak = Math.max(peak, inflight); log.push({ url, at: Date.now(), ua: opts.headers['user-agent'] });
    await new Promise((r) => setTimeout(r, 60)); inflight--;
    return new Response('<title>x</title>', { status: 200, headers: { 'content-type': 'text/html' } }); };
  const f = createFetcher({ siteUrl: 'https://www.d.com/', fetchImpl: fakeFetch, gapMs: 40 });
  const rs = await Promise.all(['/a', '/b', '/c', '/d', '/e'].map((p) => f.get('https://www.d.com' + p)));
  assert.ok(rs.every((r) => r.status === 200));
  assert.ok(peak <= 2, `peak ${peak}`);
  const times = log.map((l) => l.at).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= 35, `gap ${times[i] - times[i - 1]}`);
  assert.match(log[0].ua, /AIAEAuditBot\/1\.0/);
  assert.equal((await f.get('https://other.com/x')).error, 'outside the audited website');
  assert.equal((await f.get('http://169.254.169.254/')).error, 'not a public web address');
});

test('fetcher: redirect chains recorded; honours Retry-After once; stops after repeated blocks', async () => {
  const routes = { '/old': [302, '/mid'], '/mid': [301, '/new'] };
  let tries = 0;
  const fakeFetch = async (url) => {
    const p = new URL(url).pathname;
    if (routes[p]) return new Response('', { status: routes[p][0], headers: { location: routes[p][1] } });
    if (p === '/busy') { tries++; return tries === 1 ? new Response('', { status: 429, headers: { 'retry-after': '3' } }) : new Response('<title>ok</title>', { status: 200 }); }
    if (p.startsWith('/blocked')) return new Response('<title>Just a moment...</title>', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
    return new Response('<title>ok</title>', { status: 200 });
  };
  const waits = [];
  const f = createFetcher({ siteUrl: 'https://d.com/', fetchImpl: fakeFetch, gapMs: 0, wait: async (ms) => { waits.push(ms); } });
  const r = await f.get('https://d.com/old');
  assert.deepEqual(r.chain.map((c) => c.status), [302, 301]);
  assert.equal(r.finalUrl, 'https://d.com/new');
  const busy = await f.get('https://d.com/busy');
  assert.equal(busy.status, 200);
  assert.ok(waits.includes(3000), 'waited Retry-After');
  for (let i = 0; i < 5; i++) await f.get(`https://d.com/blocked${i}`);
  assert.match(f.stopped, /stopped instead of pushing on/);
  await assert.rejects(() => f.get('https://d.com/after'), /stopped/);
});
