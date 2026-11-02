// Stage 3 step: load an audit's crawl evidence, run the checks, store the findings (and any evidence they add).
// Safe to re-run: rule findings still in draft are replaced; findings a person already approved or rejected stay.
import { runChecks, TEXT_TYPES, textFromHtml } from './checks.js';
import { storagePrefix } from '../public/js/audit-model.js';

export async function loadCheckData(sink, audit) {
  const id = audit.id;
  const [pages, links, sd, vehicles, evidence] = await Promise.all(['seo_pages', 'seo_links', 'seo_structured_data', 'seo_vehicles_observed', 'seo_evidence'].map((t) => sink.list(t, id)));
  const robotsEv = evidence.find((e) => e.kind === 'robots' && !/^Not fetched/.test(e.content || ''));
  const smEv = evidence.find((e) => e.kind === 'sitemap' && /^\s*\{/.test(e.content || ''));
  let sitemapInfo = null;
  try { sitemapInfo = smEv ? JSON.parse(smEv.content) : null; } catch { sitemapInfo = null; }
  let sitemapUrls = [];
  try { sitemapUrls = JSON.parse(await sink.readFile(`${storagePrefix(audit)}sitemap-urls.json`) || '[]').map((u) => u.url); } catch { sitemapUrls = []; }
  const text = {};
  for (const p of pages.filter((x) => TEXT_TYPES.has(x.page_type) && !x.challenge)) {
    const path = p.rendered_html_path || p.raw_html_path;
    if (!path) continue;
    try { text[p.id] = textFromHtml(await sink.readFile(path)); } catch { /* missing file: the text checks skip this page */ }
  }
  return {
    audit, pages, links, sd, vehicles, evidence, text, sitemapInfo, sitemapUrls,
    robotsText: robotsEv && !/^HTTP /.test(robotsEv.content || '') ? robotsEv.content : '',
    robotsEvidenceId: robotsEv ? robotsEv.id : null, robotsObservedAt: robotsEv ? robotsEv.captured_at : null,
    sitemapEvidenceId: smEv ? smEv.id : null, sitemapObservedAt: smEv ? smEv.captured_at : null,
  };
}

export async function runChecksStep({ auditId, sink }) {
  const audit = await sink.getAudit(auditId);
  if (!audit) throw new Error(`audit ${auditId} not found`);
  const data = await loadCheckData(sink, audit);
  const findings = runChecks(data);
  await sink.clearRuleFindings(auditId);
  for (const f of findings) {
    const { new_evidence: extra, ...row } = f;
    const ids = extra.length ? await sink.insertEvidence(extra.map((e) => ({ audit_id: auditId, page_id: e.page_id || null, kind: e.kind, url: e.url || null, content: String(e.content || '').slice(0, 20000) || '(empty)', selector: e.selector || null }))) : [];
    await sink.insert('seo_findings', [{ ...row, audit_id: auditId, evidence_ids: [...row.evidence_ids, ...ids] }]);
  }
  const log = [...(audit.stage_log || []).filter((s) => s.stage !== 'checks'),
    { stage: 'checks', done: true, at: new Date().toISOString(), note: summary(findings) }];
  await sink.updateAudit(auditId, { status: 'review', stage_log: log });
  return { findings: findings.length };
}

function summary(fs) {
  const n = (s) => fs.filter((f) => f.status === s).length;
  return `${fs.length} finding${fs.length === 1 ? '' : 's'}: ${n('confirmed')} confirmed, ${n('opportunity')} opportunit${n('opportunity') === 1 ? 'y' : 'ies'}, ${n('needs_verification')} to verify`;
}
