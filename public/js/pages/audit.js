// One audit: status and pipeline, authorization, findings by status, and where its files are stored.
import { sb, html, mount, must, $, errMsg, toast, dateTime, hostOf, loadingView, copyText } from '../core.js';
import { page } from '../layout.js';
import { navigate } from '../router.js';
import { STATUS_LABEL, STAGES, FINDING_STATUS, storagePrefix, canStart } from '../audit-model.js';

const TYPE_LABEL = { home: 'Home', srp_new: 'New inventory', srp_used: 'Used inventory', srp_certified: 'CPO inventory', vdp_new: 'New vehicle', vdp_used: 'Used vehicle',
  vdp_certified: 'CPO vehicle', model: 'Model', finance: 'Finance', service: 'Service', specials: 'Specials', certified_info: 'CPO program', contact: 'Contact', city: 'City page', about: 'About', other: 'Other' };
const DIFF_LABEL = { title: 'Title changes after JavaScript', meta_description: 'Description changes after JavaScript', meta_robots: 'Robots tag changes after JavaScript',
  canonical: 'Canonical changes after JavaScript', h1: 'H1 changes after JavaScript', word_count: 'Most text appears only after JavaScript', visible_price: 'Price appears only after JavaScript',
  phones: 'Phone number swapped by a script', structured_data_types: 'Structured data differs after JavaScript', render_error: 'Could not render' };
const pathOf = (u) => { try { const x = new URL(u); return x.pathname + x.search; } catch { return u; } };

export default async function audit(el, { id }) {
  const p = await page(el, 'audits');
  if (!p) return;
  const { main } = p;
  let a, counts, reports, pages;
  let timer = null;
  async function load() {
    a = must(await sb.from('seo_audits').select('*').eq('id', id).maybeSingle());
    if (!a) throw new Error('This audit doesn\'t exist, or you can\'t see it.');
    const [f, pg, r] = await Promise.all([
      sb.from('seo_findings').select('status,review_status').eq('audit_id', id).then(must),
      sb.from('seo_pages').select('id,url,page_type,status_code,title,challenge,render_diff,screenshot_path,raw_html_path,rendered_html_path').eq('audit_id', id).order('created_at').then(must),
      sb.from('seo_reports').select('*').eq('audit_id', id).order('created_at', { ascending: false }).then(must),
    ]);
    pages = pg;
    counts = { pages: pg.length, findings: f.length, ...Object.fromEntries(Object.keys(FINDING_STATUS).map((k) => [k, f.filter((x) => x.status === k).length])) };
    reports = r;
  }
  mount(main, loadingView());
  try { await load(); } catch (e) { mount(main, html`<div class="notice bad">${errMsg(e)}</div>`); return; }

  function draw() {
    document.title = `${a.dealership_name} · SEO Audits`;
    const log = a.stage_log || [];
    const done = new Set(log.filter((s) => s.done).map((s) => s.stage));
    const noteFor = (k) => (log.find((s) => s.stage === k) || {}).note;
    const running = ['queued', 'crawling'].includes(a.status);
    const prefix = storagePrefix(a);
    mount(main, html`<div class="page-head"><div><a href="/" class="small">← Audits</a><h1>${a.dealership_name}</h1>
        <div class="sub small"><a href="${a.site_url}" target="_blank" rel="noopener" data-external>${hostOf(a.site_url)}</a> · created ${dateTime(a.created_at)}</div></div>
      <span class="pill s-${a.status} big">${STATUS_LABEL[a.status]}</span></div>

    <div class="card"><h2>Authorization</h2>
      ${a.authorized ? html`<p class="ok-text">Authorized ${dateTime(a.authorized_at)}: ${a.authorization_note}</p>`
        : html`<p>Not authorized yet. The crawler won't touch the site until it is.</p>
        <form id="authf" class="row-form"><input name="note" placeholder="How it was authorized (who approved it, and when)" maxlength="1000" aria-label="How it was authorized" required>
          <button class="btn sm">Record authorization</button></form>`}
      ${canStart(a) ? html`<button class="btn" id="queue" style="margin-top:10px">Queue the audit</button>` : ''}
    </div>

    <div class="card"><h2>Pipeline</h2>
      ${a.status === 'queued' ? html`<p class="hint" style="margin-top:0">Waiting to start. The crawler checks for queued audits every minute.</p>` : ''}
      ${a.status === 'crawling' ? html`<p class="hint" style="margin-top:0">Crawling politely (one page every 2 seconds), so a 100-page sample takes 20–40 minutes. This page refreshes by itself.</p>` : ''}
      ${a.status === 'checking' ? html`<p class="hint" style="margin-top:0">Crawl finished. The checks that turn this evidence into findings come in the next build stage.</p>` : ''}
      <ol class="stages">${STAGES.map((s) => html`<li class="${done.has(s.key) ? 'done' : ''}"><b>${s.label}</b><span class="small sub">${noteFor(s.key) || s.detail}</span></li>`)}</ol>
      ${a.error ? html`<p class="notice bad">${a.error}</p>` : ''}
    </div>

    <div class="grid3 kpis">
      <div class="card kpi"><b>${counts.pages}</b><span>pages sampled</span></div>
      <div class="card kpi"><b>${counts.findings}</b><span>findings</span></div>
      <div class="card kpi"><span class="small">${Object.entries(FINDING_STATUS).map(([k, l]) => html`<span class="dot d-${k}"></span>${l}: <b>${counts[k]}</b><br>`)}</span></div>
    </div>

    ${pages.length ? html`<div class="card"><h2>Pages sampled</h2>
      <div class="table-wrap"><table class="pages"><thead><tr><th>Type</th><th>Status</th><th>Page</th><th>Notes</th><th></th></tr></thead><tbody>
      ${pages.map((p) => html`<tr class="${p.challenge ? 'warn' : ''}"><td><span class="pill">${TYPE_LABEL[p.page_type] || p.page_type}</span></td><td>${p.status_code || '–'}</td>
        <td><a href="${p.url}" target="_blank" rel="noopener" data-external>${p.title || pathOf(p.url)}</a><div class="small sub">${pathOf(p.url)}</div></td>
        <td class="small">${p.challenge ? html`<b>Security challenge</b> (${p.challenge.vendor}): our crawler was challenged; check Google's view in Search Console.` : ''}
          ${p.render_diff ? html`${Object.keys(p.render_diff).map((k) => DIFF_LABEL[k] || k).join(' · ')}` : ''}</td>
        <td class="nowrap">${p.screenshot_path ? html`<button class="btn ghost sm" data-file="${p.screenshot_path}" title="Phone screenshot">Screenshot</button>` : ''}
          ${p.rendered_html_path ? html`<button class="btn ghost sm" data-file="${p.rendered_html_path}" title="HTML after JavaScript">Rendered</button>` : ''}
          ${p.raw_html_path ? html`<button class="btn ghost sm" data-file="${p.raw_html_path}" title="HTML as first served">Raw</button>` : ''}</td></tr>`)}
      </tbody></table></div></div>` : ''}

    <div class="card"><h2>Reports</h2>
      <p class="small">Stored in the private <b>seo</b> bucket in Supabase (Storage → seo), folder:</p>
      <div class="copy-field"><input readonly value="seo/${prefix}" aria-label="Storage folder"><button type="button" class="btn alt sm" id="copyp">Copy</button></div>
      ${reports.length ? html`<ul class="reports">${reports.map((r) => html`<li><b>${r.kind.replace(/_/g, ' ')}</b> (${r.format}, v${r.version}) <button class="btn ghost sm" data-dl="${r.storage_path}">Download</button></li>`)}</ul>`
        : html`<p class="sub small">Reports appear here after the team review: the detailed audit, the GM summary, the 30/60/90-day plan, provider tickets and the meeting email.</p>`}
    </div>

    <div class="btn-row">
      ${!['complete', 'cancelled'].includes(a.status) ? html`<button class="btn alt" id="cancel">Cancel audit</button>` : ''}
      <button class="btn ghost danger" id="del">Delete audit</button>
    </div>`);

    const af = $('#authf', main);
    af && af.addEventListener('submit', async (e) => {
      e.preventDefault();
      const note = String(new FormData(af).get('note') || '').trim();
      if (!note) return;
      try { a = must(await sb.from('seo_audits').update({ authorized: true, authorization_note: note }).eq('id', id).select().single()); toast('Authorization recorded'); draw(); }
      catch (x) { toast(errMsg(x), 'bad'); }
    });
    const q = $('#queue', main);
    q && q.addEventListener('click', async () => {
      try { a = must(await sb.from('seo_audits').update({ status: 'queued' }).eq('id', id).select().single()); toast('Audit queued'); draw(); }
      catch (x) { toast(errMsg(x), 'bad'); }
    });
    $('#copyp', main).onclick = () => copyText(`seo/${prefix}`);
    main.querySelectorAll('[data-file]').forEach((b) => b.addEventListener('click', async () => {
      const { data, error } = await sb.storage.from('seo').createSignedUrl(b.dataset.file, 300);
      if (error) { toast(errMsg(error), 'bad'); return; }
      window.open(data.signedUrl, '_blank', 'noopener');
    }));
    clearTimeout(timer);
    if (running) timer = setTimeout(async () => { if (!main.isConnected) return; try { await load(); draw(); } catch { /* try again next time */ } }, 15000);
    main.querySelectorAll('[data-dl]').forEach((b) => b.addEventListener('click', async () => {
      const { data, error } = await sb.storage.from('seo').createSignedUrl(b.dataset.dl, 300, { download: true });
      if (error) { toast(errMsg(error), 'bad'); return; }
      location.href = data.signedUrl;
    }));
    const c = $('#cancel', main);
    c && c.addEventListener('click', async () => {
      if (!confirm('Cancel this audit? Anything already collected is kept.')) return;
      try { a = must(await sb.from('seo_audits').update({ status: 'cancelled' }).eq('id', id).select().single()); toast('Audit cancelled'); draw(); }
      catch (x) { toast(errMsg(x), 'bad'); }
    });
    $('#del', main).addEventListener('click', async () => {
      if (!confirm('Delete this audit and everything collected for it? This can\'t be undone.')) return;
      try { must(await sb.from('seo_audits').delete().eq('id', id)); toast('Audit deleted'); navigate('/'); }
      catch (x) { toast(errMsg(x), 'bad'); }
    });
  }
  draw();
}
