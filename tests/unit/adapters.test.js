// The two production adapters, checked against fake HTTP: Browser Run (rendering) and Supabase (storage).
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderWithBrowserRun, readTimeline, TIMELINE_SCRIPT } from '../../crawler/render.js';
import { supabaseSink } from '../../crawler/sink-supabase.js';

test('Browser Run: content + screenshot requests, bot user agent, phone viewport, timing script; marker stripped', async () => {
  const calls = [];
  const fake = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization });
    if (url.includes('/content')) return Response.json({ success: true, meta: { status: 200, title: 'x' },
      result: '<html data-aiae-timeline="{&quot;prices&quot;:{&quot;$52,995&quot;:2510},&quot;phones&quot;:{},&quot;at&quot;:6100}"><head><title>x</title></head></html>' });
    return new Response(new Uint8Array([255, 216, 255]), { headers: { 'content-type': 'image/jpeg' } });
  };
  const render = renderWithBrowserRun({ CLOUDFLARE_ACCOUNT_ID: 'acc1', BROWSER_RUN_TOKEN: 'tok' }, fake);
  const r = await render('https://dealer.com/v/1', { screenshot: true });
  assert.equal(calls[0].url, 'https://api.cloudflare.com/client/v4/accounts/acc1/browser-run/content?cacheTTL=0');
  assert.equal(calls[0].auth, 'Bearer tok');
  assert.match(calls[0].body.userAgent, /AIAEAuditBot/);
  assert.equal(calls[0].body.viewport.width, 390);
  assert.equal(calls[0].body.addScriptTag[0].content, TIMELINE_SCRIPT);
  assert.ok(calls[0].body.waitForTimeout >= 5000 && calls[0].body.waitForTimeout <= 120000);
  assert.equal(calls[1].url, 'https://api.cloudflare.com/client/v4/accounts/acc1/browser-run/screenshot?cacheTTL=0');
  assert.equal(r.status, 200);
  assert.deepEqual(r.timeline.prices, { '$52,995': 2510 });
  assert.ok(!r.html.includes('data-aiae-timeline'));
  assert.equal(r.screenshot.length, 3);
  const bad = await renderWithBrowserRun({ CLOUDFLARE_ACCOUNT_ID: 'a', BROWSER_RUN_TOKEN: 't' }, async () => Response.json({ success: false, errors: [{ code: 1, message: 'Navigation timeout' }] }, { status: 422 }))('https://d.com/');
  assert.equal(bad.error, 'Navigation timeout');
  assert.equal(readTimeline('<html>'), null);
});

test('Supabase sink: claims each queued audit once, upserts pages, stores files under the seo bucket', async () => {
  const calls = [];
  const fake = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', prefer: opts.headers && opts.headers.prefer, body: opts.body });
    if (url.includes('seo_audits?status=eq.queued')) return Response.json([{ id: 'a1' }, { id: 'a2' }]);
    if (url.includes('seo_audits?id=eq.a1&status=eq.queued')) return Response.json([{ id: 'a1' }]);
    if (url.includes('seo_audits?id=eq.a2&status=eq.queued')) return Response.json([]); // someone else got it
    if (url.includes('seo_pages?on_conflict')) return Response.json([{ id: 'p1' }]);
    return new Response(null, { status: 201 });
  };
  const sink = supabaseSink({ SUPABASE_URL: 'https://p.supabase.co/', SUPABASE_SERVICE_ROLE_KEY: 'svc' }, fake);
  assert.deepEqual(await sink.claimQueued(), ['a1']);
  assert.match(calls[0].url, /authorized=eq\.true/);
  assert.equal(await sink.upsertPage({ audit_id: 'a1', url: 'https://d.com/' }), 'p1');
  assert.match(calls.at(-1).prefer, /merge-duplicates/);
  await sink.saveFile('new-smyrna-beach-chevrolet/2026-11-02/a1/pages/000 raw.html', '<html>', 'text/html');
  assert.equal(calls.at(-1).url, 'https://p.supabase.co/storage/v1/object/seo/new-smyrna-beach-chevrolet/2026-11-02/a1/pages/000%20raw.html');
  await assert.rejects(() => supabaseSink({ SUPABASE_URL: 'https://p', SUPABASE_SERVICE_ROLE_KEY: 'k' }, async () => new Response('nope', { status: 401 })).getAudit('x'), /401/);
});
