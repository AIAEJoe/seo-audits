// In-memory stand-in for @supabase/supabase-js used by the browser tests. Column names are checked against the
// real migration (window.__SCHEMA), and the team-only and authorization rules mirror the database's.
const SCHEMA = window.__SCHEMA || {};
const db = window.__DB;
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const sessionOf = () => JSON.parse(localStorage.getItem('stub-session') || 'null');
const isTeam = () => { const s = sessionOf(); return !!(s && db.platform_admins.some((p) => p.user_id === s.user.id)); };
const save = () => localStorage.setItem('stub-db', JSON.stringify(db));
function checkCol(t, c) { const cols = SCHEMA[t]; if (cols && !cols.includes(c)) { const m = `STUB: column "${c}" does not exist on ${t}`; window.__STUB_ERRORS.push(m); throw new Error(m); } }
const hostOf = (u) => String(u).replace(/^https?:\/\//i, '').split('/')[0].split(':')[0].toLowerCase();

const DEFAULTS = {
  seo_audits: (r) => ({ competitors: [], page_budget: 100, sample_plan: { new: 10, used: 10, certified: 5, city: 10 }, authorized: false, status: 'draft', stage_log: [], host: hostOf(r.site_url) }),
};
function stampAudit(row, before) {
  if (row.authorized && (!before || !before.authorized)) { row.authorized_by = sessionOf().user.id; row.authorized_at = now(); }
  else if (!row.authorized) { row.authorized_by = null; row.authorized_at = null; }
  else if (before) { row.authorized_by = before.authorized_by; row.authorized_at = before.authorized_at; }
  if (!['draft', 'cancelled'].includes(row.status) && !row.authorized) throw new Error('new row for relation "seo_audits" violates check constraint "seo_audits_check"');
  if (!/^https?:\/\/[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?(\/.*)?$/i.test(row.site_url)) throw new Error('violates check constraint "seo_audits_site_url_check"');
}

class Query {
  constructor(t) { this.t = t; this.filters = []; this.op = 'select'; this.one = null; this.orders = []; this.lim = null; }
  select() { if (this.op !== 'select') this.wantRows = true; return this; }
  insert(rows) { this.op = 'insert'; this.payload = Array.isArray(rows) ? rows : [rows]; return this; }
  update(p) { this.op = 'update'; this.payload = p; return this; }
  delete() { this.op = 'delete'; return this; }
  eq(c, v) { checkCol(this.t, c); this.filters.push((r) => r[c] === v); return this; }
  order(c, o = {}) { checkCol(this.t, c); this.orders.push([c, o.ascending !== false]); return this; }
  limit(n) { this.lim = n; return this; }
  single() { this.one = 'single'; return this; }
  maybeSingle() { this.one = 'maybe'; return this; }
  then(res, rej) { return Promise.resolve().then(() => this.run()).then(res, rej); }
  run() {
    try {
      const table = db[this.t];
      if (!table) throw new Error(`STUB: no table ${this.t}`);
      if (this.t.startsWith('seo_') && !isTeam()) {
        if (this.op === 'insert') throw new Error('new row violates row-level security policy');
        return this.one ? { data: null, error: this.one === 'single' ? { message: 'no rows' } : null } : { data: [], error: null };
      }
      const s = sessionOf();
      let rows;
      if (this.op === 'insert') {
        rows = this.payload.map((p) => {
          Object.keys(p).forEach((k) => checkCol(this.t, k));
          const r = { id: uid(), created_at: now(), ...(DEFAULTS[this.t] ? DEFAULTS[this.t](p) : {}), ...p, created_by: s && s.user.id };
          if (this.t === 'seo_audits') stampAudit(r, null);
          table.push(r);
          return r;
        });
      } else {
        rows = table.filter((r) => this.filters.every((f) => f(r)));
        if (this.t === 'platform_admins') rows = rows.filter((r) => s && r.user_id === s.user.id);
        if (this.op === 'update') {
          Object.keys(this.payload).forEach((k) => checkCol(this.t, k));
          rows.forEach((r) => { const before = { ...r }; Object.assign(r, this.payload); if (this.t === 'seo_audits') stampAudit(r, before); });
        }
        if (this.op === 'delete') {
          db[this.t] = table.filter((r) => !rows.includes(r));
          if (this.t === 'seo_audits') for (const k of Object.keys(db)) if (k.startsWith('seo_') && k !== 'seo_audits') db[k] = db[k].filter((x) => !rows.some((r) => r.id === x.audit_id));
        }
      }
      if (this.op !== 'select') save();
      if (this.op === 'select' || this.wantRows) {
        for (const [c, asc] of [...this.orders].reverse()) rows = [...rows].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        if (this.lim) rows = rows.slice(0, this.lim);
      } else rows = null;
      if (this.one) {
        if (this.one === 'single' && (!rows || rows.length !== 1)) return { data: null, error: { message: 'JSON object requested, multiple (or no) rows returned' } };
        return { data: rows ? rows[0] || null : null, error: null };
      }
      return { data: rows, error: null };
    } catch (e) { return { data: null, error: { message: e.message } }; }
  }
}

export function createClient() {
  return {
    from: (t) => new Query(t),
    storage: { from: () => ({ createSignedUrl: async (p) => ({ data: { signedUrl: `/signed/${encodeURIComponent(p)}` }, error: null }) }) },
    auth: {
      getSession: async () => ({ data: { session: sessionOf() }, error: null }),
      signInWithPassword: async ({ email, password }) => {
        const u = db.users.find((x) => x.email === email && x.password === password);
        if (!u) return { data: null, error: { message: 'Invalid login credentials' } };
        const session = { access_token: 'tok', user: { id: u.id, email: u.email } };
        localStorage.setItem('stub-session', JSON.stringify(session));
        return { data: { session }, error: null };
      },
      signInWithOtp: async ({ email }) => { (window.__OTP ||= []).push(email); return { data: {}, error: null }; },
      signOut: async () => { localStorage.removeItem('stub-session'); return { error: null }; },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  };
}
