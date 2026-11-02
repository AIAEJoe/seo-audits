// SEO Audits worker: starts queued audits and runs each one as a durable Cloudflare Workflow.
//   * Every minute (cron) it claims up to 3 queued, authorized audits and starts a workflow for each.
//   * The workflow runs crawler/pipeline.js; every step is retried on failure and survives restarts.
// Secrets (Cloudflare → this worker → Settings → Variables and Secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// CLOUDFLARE_ACCOUNT_ID, BROWSER_RUN_TOKEN (an API token with "Browser Run - Edit"), RESEND_API_KEY (audit emails).
// Optional: AUDIT_NOTIFY_EMAIL (default joe@aiautoengine.com), AUDIT_FROM_EMAIL, APP_URL.
// GITHUB_TOKEN (fine-grained, seo-audits repo, Actions: read and write): when set, crawls run on GitHub Actions with a
// real Chrome (.github/workflows/crawl.yml) instead of from Cloudflare, which many dealer sites' bot protection blocks.
const GH_REPO = 'AIAEJoe/seo-audits';
export async function dispatchGithub(env, auditId, fetchImpl = fetch) {
  const res = await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPO || GH_REPO}/actions/workflows/crawl.yml/dispatches`, {
    method: 'POST', headers: { authorization: `Bearer ${env.GITHUB_TOKEN}`, accept: 'application/vnd.github+json', 'user-agent': 'seo-audits-worker', 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'main', inputs: { audit_id: auditId } }) });
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text()).slice(0, 200)}`);
}
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { runAudit } from '../../crawler/pipeline.js';
import { supabaseSink } from '../../crawler/sink-supabase.js';
import { renderWithBrowserRun } from '../../crawler/render.js';
import { runChecksStep } from '../../crawler/run-checks.js';
import { sendAuditEmail } from '../../crawler/notify.js';

const STEP = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' };

export class AuditWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const auditId = event.payload && event.payload.auditId;
    const sink = supabaseSink(env);
    const render = env.CLOUDFLARE_ACCOUNT_ID && env.BROWSER_RUN_TOKEN ? renderWithBrowserRun(env) : null;
    const s = (name, fn) => step.do(name, STEP, async () => { const r = await fn(); return r === undefined ? null : r; });
    try {
      // checks only: an audit crawled before the checks existed (or whose checks never ran)
      const notify = (id, kind) => sendAuditEmail(env, sink, id, kind);
      if (event.payload && event.payload.mode === 'checks') {
        const r = await s('checks', () => runChecksStep({ auditId, sink }));
        await s('notify', () => notify(auditId, 'complete').catch((e) => ({ error: e.message })));
        return r;
      }
      if (!render) await s('no-renderer', () => sink.updateAudit(auditId, { error: 'Browser Run isn\'t set up (CLOUDFLARE_ACCOUNT_ID / BROWSER_RUN_TOKEN), so pages are fetched but not rendered.' }));
      return await runAudit({ auditId, deps: { sink, render, notify }, step: s });
    } catch (e) {
      await step.do('mark-failed', STEP, async () => { await sink.updateAudit(auditId, { status: 'failed', error: String(e && e.message ? e.message : e).slice(0, 500) }); return null; });
      await step.do('notify-failed', STEP, async () => { try { await sendAuditEmail(env, sink, auditId, 'failed'); } catch { /* the failure is already on the audit page */ } return null; });
      throw e;
    }
  }
}

export async function startQueued(env, sink = supabaseSink(env)) {
  const ids = await sink.claimQueued(3);
  const started = [];
  for (const id of ids) {
    try {
      if (env.GITHUB_TOKEN) await dispatchGithub(env, id);
      else await env.AUDIT_WORKFLOW.create({ id: `audit-${id}`, params: { auditId: id } });
      started.push(id);
    }
    catch (e) {
      if (/already exists|duplicate/i.test(String(e && e.message))) continue;
      await sink.updateAudit(id, { status: 'queued', error: `Couldn't start the crawler: ${String(e && e.message).slice(0, 300)}` });
    }
  }
  // audits whose crawl is done but whose checks never ran (one workflow per audit: the id makes it unique)
  if (sink.auditsAwaitingChecks) {
    for (const id of await sink.auditsAwaitingChecks()) {
      try { await env.AUDIT_WORKFLOW.create({ id: `checks-${id}`, params: { auditId: id, mode: 'checks' } }); started.push(`checks:${id}`); }
      catch (e) { if (!/already exists|duplicate/i.test(String(e && e.message))) console.error('checks start failed', e); }
    }
  }
  return started;
}

export default {
  async scheduled(controller, env, ctx) { ctx.waitUntil(startQueued(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') {
      return Response.json({ ok: true, app: 'seo-audits-worker', configured: {
        supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), browser_run: !!(env.CLOUDFLARE_ACCOUNT_ID && env.BROWSER_RUN_TOKEN), workflow: !!env.AUDIT_WORKFLOW, email: !!env.RESEND_API_KEY, github_runner: !!env.GITHUB_TOKEN } });
    }
    return new Response('Not found', { status: 404 });
  },
};
