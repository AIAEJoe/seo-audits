import { sb, html, mount, must, $, errMsg, toast } from '../core.js';
import { page } from '../layout.js';
import { navigate } from '../router.js';
import { normalizeSiteUrl, parseCompetitors } from '../audit-model.js';

export default async function auditNew(el) {
  const p = await page(el, 'new');
  if (!p) return;
  const { main } = p;
  document.title = 'New audit · SEO Audits';
  mount(main, html`<div class="page-head"><h1>New audit</h1></div>
  <form class="card form" id="f" novalidate>
    <h2>Dealership</h2>
    <div class="grid2">
      <div><label for="name">Dealership name</label><input id="name" name="dealership_name" required maxlength="120" placeholder="New Smyrna Beach Chevrolet"></div>
      <div><label for="url">Website</label><input id="url" name="site_url" required inputmode="url" placeholder="https://www.newsmyrnachevy.com"></div>
    </div>
    <label for="addr">Address (optional)</label><input id="addr" name="address" placeholder="2375 State Road 44, New Smyrna Beach, FL 32168">
    <label for="comp">Competitors (optional, one per line: name and website)</label>
    <textarea id="comp" name="competitors" rows="3" placeholder="DeLand Chevrolet https://www.delandchevy.com"></textarea>
    <h2>Sample</h2>
    <p class="hint">A representative sample, not the whole site. Vehicle pages are picked across new, used and certified inventory.</p>
    <div class="grid4">
      <div><label for="budget">Page budget</label><input id="budget" name="page_budget" type="number" min="10" max="500" value="100"></div>
      <div><label for="s-new">New vehicle pages</label><input id="s-new" name="new" type="number" min="0" max="50" value="10"></div>
      <div><label for="s-used">Used vehicle pages</label><input id="s-used" name="used" type="number" min="0" max="50" value="10"></div>
      <div><label for="s-cpo">Certified vehicle pages</label><input id="s-cpo" name="certified" type="number" min="0" max="50" value="5"></div>
    </div>
    <h2>Authorization</h2>
    <label class="check"><input type="checkbox" id="auth" name="authorized"> I confirm the dealership (or an agency it has engaged) has authorized AI Authority Engine to audit this public website.</label>
    <label for="note">How it was authorized</label>
    <input id="note" name="authorization_note" maxlength="1000" placeholder="e.g. Approved by the GM by email on Oct 30, 2026">
    <p class="hint">Recorded with your name and the time. The crawler identifies itself, follows robots.txt, stays on this website, and never tries to get past a security challenge.</p>
    <div id="err"></div>
    <div class="btn-row"><button class="btn" name="go" value="queue">Save and queue</button><button class="btn alt" name="go" value="draft">Save as draft</button></div>
  </form>`);
  const f = $('#f', main);
  f.addEventListener('submit', async (e) => {
    e.preventDefault();
    const go = (e.submitter && e.submitter.value) || 'draft';
    const fd = new FormData(f);
    const err = (m) => mount($('#err', main), html`<p class="notice bad">${m}</p>`);
    const name = String(fd.get('dealership_name') || '').trim();
    if (!name) return err('Enter the dealership name.');
    let site;
    try { site = normalizeSiteUrl(fd.get('site_url')); } catch (x) { return err(x.message); }
    const authorized = fd.get('authorized') === 'on';
    const note = String(fd.get('authorization_note') || '').trim();
    if (go === 'queue' && !authorized) return err('Confirm the audit is authorized before queueing it. You can save it as a draft until then.');
    if (authorized && !note) return err('Say how the audit was authorized (who approved it, and when).');
    const n = (k, d) => { const v = Number(fd.get(k)); return Number.isFinite(v) ? v : d; };
    const row = {
      dealership_name: name, site_url: site, address: String(fd.get('address') || '').trim() || null,
      competitors: parseCompetitors(fd.get('competitors')), page_budget: Math.min(500, Math.max(10, n('page_budget', 100))),
      sample_plan: { new: n('new', 10), used: n('used', 10), certified: n('certified', 5), city: 10 },
      authorized, authorization_note: note || null, status: go === 'queue' ? 'queued' : 'draft',
    };
    try {
      const a = must(await sb.from('seo_audits').insert(row).select().single());
      toast(go === 'queue' ? 'Audit queued' : 'Draft saved');
      navigate(`/audits/${a.id}`);
    } catch (x) { err(errMsg(x)); }
  });
}
