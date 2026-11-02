import test from 'node:test';
import assert from 'node:assert/strict';
import { auditEmail, sendAuditEmail } from '../../crawler/notify.js';

const audit = { id: 'a1', dealership_name: 'New Smyrna Beach Chevrolet', site_url: 'https://www.newsmyrnachevy.com/', error: null };
const findings = [{ status: 'confirmed', priority: 'high', title: 'Vehicle X is sold but still in stock in structured data' }, { status: 'opportunity', priority: 'low', title: 'b' }, { status: 'needs_verification', priority: 'medium', title: 'c <script>' }];
const pages = [{}, {}, { challenge: { vendor: 'Cloudflare' } }];

test('the complete email: counts, high-priority titles, link to the audit', () => {
  const m = auditEmail({ kind: 'complete', audit, findings, pages, appUrl: 'https://seo.aiautoengine.com' });
  assert.equal(m.subject, 'SEO audit complete: New Smyrna Beach Chevrolet (3 findings, 1 high priority)');
  assert.match(m.text, /3 pages sampled \(1 answered with a security challenge\)/);
  assert.match(m.text, /1 confirmed, 1 opportunities, 1 need verification/);
  assert.match(m.text, /High priority:\n- Vehicle X is sold/);
  assert.match(m.html, /href="https:\/\/seo\.aiautoengine\.com\/audits\/a1"/);
  assert.doesNotMatch(m.html, /<script>/, 'escaped');
});

test('sent to joe@aiautoengine.com by default through Resend; skipped without a key', async () => {
  const sink = { getAudit: async () => audit, list: async (t) => (t === 'seo_findings' ? findings : pages) };
  let call;
  const r = await sendAuditEmail({ RESEND_API_KEY: 're_x' }, sink, 'a1', 'complete', async (url, opts) => { call = { url, body: JSON.parse(opts.body), auth: opts.headers.authorization }; return Response.json({ id: 'e1' }); });
  assert.deepEqual(r, { sent: ['joe@aiautoengine.com'] });
  assert.equal(call.url, 'https://api.resend.com/emails');
  assert.equal(call.auth, 'Bearer re_x');
  assert.deepEqual(call.body.to, ['joe@aiautoengine.com']);
  assert.equal(call.body.from, 'SEO Audits <audits@mail.aiautoengine.com>');
  assert.deepEqual(await sendAuditEmail({}, sink, 'a1', 'complete'), { skipped: 'RESEND_API_KEY not set' });
  const f = auditEmail({ kind: 'failed', audit: { ...audit, error: 'robots.txt timed out' }, appUrl: 'https://x' });
  assert.match(f.subject, /failed/);
  assert.match(f.text, /robots\.txt timed out/);
});
