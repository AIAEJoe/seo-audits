// In-memory sink (tests): the same operations the Supabase sink performs, kept in plain arrays.
export function memorySink(audit) {
  const db = { seo_audits: [audit], seo_pages: [], seo_links: [], seo_structured_data: [], seo_vehicles_observed: [], seo_evidence: [] };
  const files = new Map();
  let id = 0;
  return {
    db, files,
    async getAudit(auditId) { return db.seo_audits.find((a) => a.id === auditId) || null; },
    async updateAudit(auditId, patch) { Object.assign(db.seo_audits.find((a) => a.id === auditId), JSON.parse(JSON.stringify(patch))); },
    async upsertPage(row) {
      const existing = db.seo_pages.find((p) => p.audit_id === row.audit_id && p.url === row.url);
      if (existing) { Object.assign(existing, row); return existing.id; }
      const r = { id: `page-${++id}`, ...JSON.parse(JSON.stringify(row)) }; db.seo_pages.push(r); return r.id;
    },
    async clearPage(pageId) {
      for (const t of ['seo_structured_data', 'seo_vehicles_observed', 'seo_evidence']) db[t] = db[t].filter((r) => r.page_id !== pageId);
      db.seo_links = db.seo_links.filter((r) => r.from_page !== pageId);
    },
    async insert(table, rows) { for (const r of rows) db[table].push({ id: `${table}-${++id}`, ...JSON.parse(JSON.stringify(r)) }); },
    async addEvidence(row) { db.seo_evidence.push({ id: `ev-${++id}`, captured_at: new Date().toISOString(), ...row }); },
    async setLinkStatuses(auditId, statuses) {
      for (const s of statuses) {
        const rows = db.seo_links.filter((l) => l.audit_id === auditId && l.to_url === s.url);
        if (rows.length) rows.forEach((l) => { l.status_code = s.status; l.checked_at = new Date().toISOString(); });
        else db.seo_links.push({ id: `seo_links-${++id}`, audit_id: auditId, from_page: null, to_url: s.url, internal: true, status_code: s.status, checked_at: new Date().toISOString(), anchor: '(sitemap)' });
      }
    },
    async saveFile(path, content) { files.set(path, content); },
  };
}
