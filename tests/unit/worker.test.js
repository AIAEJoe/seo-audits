// The worker entry, with Cloudflare's runtime module stubbed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, next) {
  if (s === 'cloudflare:workers') return { url: 'data:text/javascript,' + encodeURIComponent('export class WorkflowEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }'), shortCircuit: true };
  return next(s, c);
}`));
const { default: worker, startQueued, AuditWorkflow } = await import('../../worker/src/index.js');

test('cron claims queued audits and starts one workflow each; an already-running one is fine', async () => {
  const created = [];
  const env = { AUDIT_WORKFLOW: { create: async ({ id, params }) => { if (id === 'audit-b') throw new Error('instance already exists'); created.push([id, params.auditId]); } } };
  const updates = [];
  const sink = { claimQueued: async () => ['a', 'b', 'c'], updateAudit: async (id, p) => updates.push([id, p]) };
  assert.deepEqual(await startQueued(env, sink), ['a', 'c']);
  assert.deepEqual(created, [['audit-a', 'a'], ['audit-c', 'c']]);
  assert.equal(updates.length, 0);
  env.AUDIT_WORKFLOW.create = async () => { throw new Error('quota'); };
  await startQueued(env, { claimQueued: async () => ['d'], updateAudit: async (id, p) => updates.push([id, p]) });
  assert.deepEqual(updates, [['d', { status: 'queued', error: "Couldn't start the crawler: quota" }]], 'put back in the queue with the reason');
});

test('health endpoint says what is configured, without revealing secrets', async () => {
  const r = await worker.fetch(new Request('https://w.dev/health'), { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'secret', AUDIT_WORKFLOW: {} });
  const j = await r.json();
  assert.deepEqual(j.configured, { supabase: true, browser_run: false, workflow: true, email: false, github_runner: false });
  assert.ok(!JSON.stringify(j).includes('secret'));
});

test('the workflow refuses an unauthorized audit without fetching the site', async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts = {}) => {
    calls.push([opts.method || 'GET', String(url)]);
    if (String(url).includes('/rest/v1/seo_audits?id=eq.x&select=*')) return Response.json([{ id: 'x', authorized: false, site_url: 'https://dealer.example.com/', dealership_name: 'D', created_at: '2026-11-02T00:00:00Z' }]);
    return new Response(null, { status: 204 });
  };
  try {
    const wf = new AuditWorkflow({}, { SUPABASE_URL: 'https://p.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', CLOUDFLARE_ACCOUNT_ID: 'acc', BROWSER_RUN_TOKEN: 't' });
    const steps = [];
    const r = await wf.run({ payload: { auditId: 'x' } }, { do: async (name, cfg, fn) => { steps.push([name, cfg.retries.limit]); return fn(); } });
    assert.deepEqual(r, { refused: true });
    assert.ok(calls.every(([, u]) => u.startsWith('https://p.supabase.co/')), 'never touched the dealer site');
    assert.ok(calls.some(([m, u]) => m === 'PATCH' && u.includes('seo_audits?id=eq.x')), 'marked failed');
    assert.equal(steps[0][1], 2, 'steps retry');
  } finally { globalThis.fetch = realFetch; }
});

test('cron also starts the checks for an audit that was crawled before the checks existed', async () => {
  const created = [];
  const env = { AUDIT_WORKFLOW: { create: async ({ id, params }) => { created.push([id, params.mode]); } } };
  const sink = { claimQueued: async () => [], updateAudit: async () => {}, auditsAwaitingChecks: async () => ['old1'] };
  assert.deepEqual(await startQueued(env, sink), ['checks:old1']);
  assert.deepEqual(created, [['checks-old1', 'checks']]);
});

test('with GITHUB_TOKEN set, queued audits are sent to the GitHub Actions runner', async () => {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body), auth: opts.headers.authorization }); return new Response(null, { status: 204 }); };
  try {
    const env = { GITHUB_TOKEN: 'ghp_x', AUDIT_WORKFLOW: { create: async () => { throw new Error('should not use the Cloudflare workflow'); } } };
    assert.deepEqual(await startQueued(env, { claimQueued: async () => ['a1'], updateAudit: async () => {} }), ['a1']);
    assert.equal(calls[0].url, 'https://api.github.com/repos/AIAEJoe/seo-audits/actions/workflows/crawl.yml/dispatches');
    assert.deepEqual(calls[0].body, { ref: 'main', inputs: { audit_id: 'a1' } });
    assert.equal(calls[0].auth, 'Bearer ghp_x');
    globalThis.fetch = async () => new Response('Bad credentials', { status: 401 });
    const updates = [];
    assert.deepEqual(await startQueued(env, { claimQueued: async () => ['a2'], updateAudit: async (id, p) => updates.push([id, p]) }), []);
    assert.equal(updates[0][1].status, 'queued', 'put back in the queue');
    assert.match(updates[0][1].error, /GitHub 401/);
  } finally { globalThis.fetch = real; }
});
