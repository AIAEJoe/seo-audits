// "Audit complete" (and "audit failed") emails to the team, sent with Resend from the worker.
// Env: RESEND_API_KEY (required to send), AUDIT_NOTIFY_EMAIL (default joe@aiautoengine.com),
// AUDIT_FROM_EMAIL (default "SEO Audits <audits@mail.aiautoengine.com>"), APP_URL (default https://seo.aiautoengine.com).
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function auditEmail({ kind, audit, findings = [], pages = [], appUrl }) {
  const url = `${appUrl}/audits/${audit.id}`;
  const host = String(audit.site_url || '').replace(/^https?:\/\//, '').replace(/\/$/, '');
  if (kind === 'failed') {
    return {
      subject: `SEO audit failed: ${audit.dealership_name}`,
      text: `The SEO audit of ${audit.dealership_name} (${host}) stopped: ${audit.error || 'unknown error'}\n\nOpen it: ${url}`,
      html: `<p>The SEO audit of <b>${esc(audit.dealership_name)}</b> (${esc(host)}) stopped:</p><p style="color:#b42318">${esc(audit.error || 'unknown error')}</p><p><a href="${esc(url)}">Open the audit</a></p>`,
    };
  }
  const n = (s) => findings.filter((f) => f.status === s).length;
  const high = findings.filter((f) => f.priority === 'high');
  const challenged = pages.filter((p) => p.challenge).length;
  const top = high.slice(0, 5).map((f) => f.title);
  const lines = [
    `${pages.length} pages sampled${challenged ? ` (${challenged} answered with a security challenge)` : ''}`,
    `${findings.length} findings: ${n('confirmed')} confirmed, ${n('opportunity')} opportunities, ${n('needs_verification')} need verification`,
    `${high.length} high priority`,
  ];
  return {
    subject: `SEO audit complete: ${audit.dealership_name} (${findings.length} findings, ${high.length} high priority)`,
    text: `The SEO audit of ${audit.dealership_name} (${host}) is ready for review.\n\n${lines.join('\n')}${top.length ? `\n\nHigh priority:\n- ${top.join('\n- ')}` : ''}\n\nReview it: ${url}`,
    html: `<p>The SEO audit of <b>${esc(audit.dealership_name)}</b> (${esc(host)}) is ready for review.</p>
<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
${top.length ? `<p><b>High priority</b></p><ul>${top.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
<p><a href="${esc(url)}" style="display:inline-block;background:#0B1F3A;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:700">Review the findings</a></p>
<p style="color:#667;font-size:12px">Findings are drafts until approved. Only approved findings go into reports.</p>`,
  };
}

export async function sendAuditEmail(env, sink, auditId, kind, fetchImpl = fetch) {
  if (!env.RESEND_API_KEY) return { skipped: 'RESEND_API_KEY not set' };
  const audit = await sink.getAudit(auditId);
  if (!audit) return { skipped: 'audit not found' };
  const [findings, pages] = kind === 'complete' ? await Promise.all([sink.list('seo_findings', auditId), sink.list('seo_pages', auditId)]) : [[], []];
  const msg = auditEmail({ kind, audit, findings, pages, appUrl: (env.APP_URL || 'https://seo.aiautoengine.com').replace(/\/$/, '') });
  const to = String(env.AUDIT_NOTIFY_EMAIL || 'joe@aiautoengine.com').split(/[,;\s]+/).filter(Boolean);
  const res = await fetchImpl('https://api.resend.com/emails', {
    method: 'POST', headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({ from: env.AUDIT_FROM_EMAIL || 'SEO Audits <audits@mail.aiautoengine.com>', to, subject: msg.subject, html: msg.html, text: msg.text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return { sent: to };
}
