// Supabase sink (production): writes with the service role key, from the Worker only. Never sent to a browser.
const json = (x) => JSON.stringify(x);

export function supabaseSink(env, fetchImpl = fetch) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = String(env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const auth = { apikey: key, ...(key.startsWith('sb_') ? {} : { authorization: `Bearer ${key}` }) };
  async function rest(path, { method = 'GET', body, prefer } = {}) {
    const res = await fetchImpl(`${base}/rest/v1/${path}`, { method, headers: { ...auth, 'content-type': 'application/json', ...(prefer ? { prefer } : {}) }, body: body === undefined ? undefined : json(body) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${path.split('?')[0]}: ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }
  return {
    async getAudit(id) { return (await rest(`seo_audits?id=eq.${id}&select=*`))[0] || null; },
    async updateAudit(id, patch) { await rest(`seo_audits?id=eq.${id}`, { method: 'PATCH', body: patch }); },
    async upsertPage(row) {
      const r = await rest('seo_pages?on_conflict=audit_id,url', { method: 'POST', body: row, prefer: 'resolution=merge-duplicates,return=representation' });
      return r[0].id;
    },
    async clearPage(pageId) {
      for (const t of ['seo_structured_data', 'seo_vehicles_observed', 'seo_evidence']) await rest(`${t}?page_id=eq.${pageId}`, { method: 'DELETE', prefer: 'return=minimal' });
      await rest(`seo_links?from_page=eq.${pageId}`, { method: 'DELETE', prefer: 'return=minimal' });
    },
    async insert(table, rows) { if (rows.length) await rest(table, { method: 'POST', body: rows, prefer: 'return=minimal' }); },
    async addEvidence(row) { await rest('seo_evidence', { method: 'POST', body: row, prefer: 'return=minimal' }); },
    async setLinkStatuses(auditId, statuses) {
      const now = new Date().toISOString();
      for (const s of statuses) {
        const updated = await rest(`seo_links?audit_id=eq.${auditId}&to_url=eq.${encodeURIComponent(s.url)}`, { method: 'PATCH', body: { status_code: s.status, checked_at: now }, prefer: 'return=representation' });
        if (!updated || !updated.length) await rest('seo_links', { method: 'POST', body: { audit_id: auditId, to_url: s.url, internal: true, status_code: s.status, checked_at: now, anchor: '(sitemap)' }, prefer: 'return=minimal' });
      }
    },
    async saveFile(path, content, type) {
      const res = await fetchImpl(`${base}/storage/v1/object/seo/${path.split('/').map(encodeURIComponent).join('/')}`, {
        method: 'POST', headers: { ...auth, 'content-type': type || 'application/octet-stream', 'x-upsert': 'true' }, body: content });
      if (!res.ok) throw new Error(`Storage upload ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    },
    /** Queued audits to start (oldest first). */
    async claimQueued(limit = 3) {
      const rows = await rest(`seo_audits?status=eq.queued&authorized=eq.true&select=id&order=created_at.asc&limit=${limit}`);
      const claimed = [];
      for (const r of rows) {
        const got = await rest(`seo_audits?id=eq.${r.id}&status=eq.queued`, { method: 'PATCH', body: { status: 'crawling', started_at: new Date().toISOString() }, prefer: 'return=representation' });
        if (got && got.length) claimed.push(r.id); // another run may have claimed it first
      }
      return claimed;
    },
  };
}
