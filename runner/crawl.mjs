// The audit runner on GitHub Actions: fetches and renders the dealer's site with a real Chrome, then runs the
// same pipeline, checks and "audit complete" email as the Cloudflare worker. The worker claims the queued audit
// and starts this with the audit id (.github/workflows/crawl.yml).
// Env (GitHub → seo-audits → Settings → Secrets and variables → Actions): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// RESEND_API_KEY; optional AUDIT_NOTIFY_EMAIL.
import { createRequire } from 'node:module';
import { runAudit } from '../crawler/pipeline.js';
import { supabaseSink } from '../crawler/sink-supabase.js';
import { renderWithPlaywright, phoneContextOptions } from '../crawler/render.js';
import { browserFetch } from '../crawler/browser-fetch.js';
import { sendAuditEmail } from '../crawler/notify.js';
import { chromeUserAgents } from '../crawler/constants.js';

const require = createRequire(import.meta.url);

export async function runInBrowser({ auditId, env, sink, chromium, step = (n, fn) => fn(), extraDeps = {} }) {
  const browser = await chromium.launch();
  const ua = chromeUserAgents(browser.version());
  const fetchCtx = await browser.newContext({ userAgent: ua.desktop, viewport: { width: 1366, height: 900 }, locale: 'en-US' });
  const phoneCtx = await browser.newContext(phoneContextOptions(ua.mobile));
  const notify = (id, kind) => sendAuditEmail(env, sink, id, kind);
  try {
    return await runAudit({ auditId, step, deps: { sink, notify, userAgent: ua.desktop, fetchImpl: browserFetch(fetchCtx), render: renderWithPlaywright(browser, { context: phoneCtx }), ...extraDeps } });
  } catch (e) {
    await sink.updateAudit(auditId, { status: 'failed', error: String(e && e.message ? e.message : e).slice(0, 500) }).catch(() => {});
    await sendAuditEmail(env, sink, auditId, 'failed').catch(() => {});
    throw e;
  } finally { await browser.close().catch(() => {}); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const auditId = process.argv[2] || process.env.AUDIT_ID;
  if (!/^[0-9a-f-]{36}$/i.test(auditId || '')) { console.error('usage: node runner/crawl.mjs <audit id>'); process.exit(2); }
  const { chromium } = require('playwright');
  const env = process.env;
  const sink = supabaseSink(env);
  const a = await sink.getAudit(auditId);
  if (!a) { console.error('audit not found'); process.exit(1); }
  if (a.status === 'queued') await sink.updateAudit(auditId, { status: 'crawling', started_at: new Date().toISOString() });
  console.log(`Auditing ${a.dealership_name} (${a.site_url})`);
  const r = await runInBrowser({ auditId, env, sink, chromium, step: async (name, fn) => { const t = Date.now(); const out = await fn(); console.log(`✓ ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); return out; } });
  console.log('done', JSON.stringify(r).slice(0, 500));
}
