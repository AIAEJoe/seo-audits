import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { startFixture, VEHICLES } from '../../fixtures/dealer-site/server.mjs';

const expected = JSON.parse(readFileSync(new URL('../../fixtures/dealer-site/EXPECTED.json', import.meta.url), 'utf8'));
let site;
test.before(async () => { site = await startFixture(); });
test.after(async () => { await site.close(); });
const get = (p) => fetch(site.origin + p, { redirect: 'manual', headers: { 'user-agent': 'AIAEAuditBot/1.0 (+https://seo.aiautoengine.com/bot.html)' } });

test('every expected case points at something the fixture actually serves', async () => {
  for (const c of expected.cases) {
    const r = await get(c.url);
    assert.ok(r.status > 0, c.case);
  }
});

test('the tricky cases look the way the auditor will see them', async () => {
  const ch = await get('/challenge-test/');
  assert.equal(ch.status, 200, 'challenge answers 200');
  assert.match(await ch.text(), /Just a moment/);
  assert.equal(ch.headers.get('cf-mitigated'), 'challenge');
  assert.equal((await get('/inventory/used-blocked/')).status, 403);

  const delayed = await (await get(VEHICLES.delayed.path)).text();
  assert.match(delayed, /<span class="price" data-vin="[^"]+"><\/span>/, 'no price in the raw HTML');
  assert.match(delayed, /"price":52995/, 'schema has the price');

  const stale = await (await get(VEHICLES.stale.path)).text();
  assert.match(stale, /SOLD/);
  assert.match(stale, /"price":41900.*InStock|InStock.*"price":41900/);

  const dup = await (await get(VEHICLES.duplicate.alt)).text();
  assert.doesNotMatch(dup, /rel="canonical"/);
  assert.match(await (await get(VEHICLES.duplicate.path)).text(), /rel="canonical"/);

  const home = await (await get('/')).text();
  assert.match(home, /\(386\) 555-0100/);
  assert.match(home, /swap\.js/);

  const r1 = await get('/http-old');
  assert.equal(r1.status, 302);
  assert.equal((await get(r1.headers.get('location'))).status, 301);
  assert.equal((await get('/old-page/')).status, 404);
  assert.match(await (await get('/robots.txt')).text(), /User-agent: AIAEAuditBot\nDisallow: \/private-tools\//);
  assert.equal((await get('/sitemap-missing.xml')).status, 404);
});
