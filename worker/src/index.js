// SEO Audits worker: starts queued audits and runs each one as a durable Cloudflare Workflow.
//   * Every minute (cron) it claims up to 3 queued, authorized audits and starts a workflow for each.
//   * The workflow runs crawler/pipeline.js; every step is retried on failure and survives restarts.
// Secrets (Cloudflare → this worker → Settings → Variables and Secrets): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
// CLOUDFLARE_ACCOUNT_ID, BROWSER_RUN_TOKEN (an API token with "Browser Run - Edit").
import { WorkflowEntrypoint } from 'cloudflare:workers';
import { runAudit } from '../../crawler/pipeline.js';
import { supabaseSink } from '../../crawler/sink-supabase.js';
import { renderWithBrowserRun } from '../../crawler/render.js';

const STEP = { retries: { limit: 2, delay: '30 seconds', backoff: 'exponential' }, timeout: '10 minutes' };

export class AuditWorkflow extends WorkflowEntrypoint {
  async run(event, step) {
    const env = this.env;
    const auditId = event.payload && event.payload.auditId;
    const sink = supabaseSink(env);
    const render = env.CLOUDFLARE_ACCOUNT_ID && env.BROWSER_RUN_TOKEN ? renderWithBrowserRun(env) : null;
    const s = (name, fn) => step.do(name, STEP, async () => { const r = await fn(); return r === undefined ? null : r; });
    try {
      if (!render) await s('no-renderer', () => sink.updateAudit(auditId, { error: 'Browser Run isn\'t set up (CLOUDFLARE_ACCOUNT_ID / BROWSER_RUN_TOKEN), so pages are fetched but not rendered.' }));
      return await runAudit({ auditId, deps: { sink, render }, step: s });
    } catch (e) {
      await step.do('mark-failed', STEP, async () => { await sink.updateAudit(auditId, { status: 'failed', error: String(e && e.message ? e.message : e).slice(0, 500) }); return null; });
      throw e;
    }
  }
}

export async function startQueued(env, sink = supabaseSink(env)) {
  const ids = await sink.claimQueued(3);
  const started = [];
  for (const id of ids) {
    try { await env.AUDIT_WORKFLOW.create({ id: `audit-${id}`, params: { auditId: id } }); started.push(id); }
    catch (e) {
      if (/already exists|duplicate/i.test(String(e && e.message))) continue;
      await sink.updateAudit(id, { status: 'queued', error: `Couldn't start the crawler: ${String(e && e.message).slice(0, 300)}` });
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
        supabase: !!(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY), browser_run: !!(env.CLOUDFLARE_ACCOUNT_ID && env.BROWSER_RUN_TOKEN), workflow: !!env.AUDIT_WORKFLOW } });
    }
    return new Response('Not found', { status: 404 });
  },
};
