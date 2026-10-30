import { sb, html, mount, must, errMsg, timeAgo, hostOf, loadingView } from '../core.js';
import { page } from '../layout.js';
import { STATUS_LABEL } from '../audit-model.js';

export default async function audits(el) {
  const p = await page(el, 'audits');
  if (!p) return;
  const { main } = p;
  document.title = 'Audits · SEO Audits';
  mount(main, loadingView());
  let rows;
  try {
    rows = must(await sb.from('seo_audits').select('id,dealership_name,site_url,status,authorized,created_at,finished_at').order('created_at', { ascending: false }).limit(200));
  } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}${/seo_audits/.test(errMsg(e)) ? ' Run the SEO Audits SQL in Supabase first.' : ''}</div>`); return; }
  mount(main, html`<div class="page-head"><h1>Audits</h1><a class="btn" href="/audits/new">+ New audit</a></div>
    ${rows.length ? html`<div class="list">${rows.map((a) => html`<a class="row" href="/audits/${a.id}">
        <div><h3>${a.dealership_name}</h3><div class="sub small">${hostOf(a.site_url)} · started ${timeAgo(a.created_at)}</div></div>
        <span class="pill s-${a.status}">${STATUS_LABEL[a.status] || a.status}</span></a>`)}</div>`
      : html`<div class="card empty"><h2>No audits yet</h2><p>Start with one dealership and a representative sample of its pages.</p><a class="btn" href="/audits/new">Set up the first audit</a></div>`}`);
}
