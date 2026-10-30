// Signed-in page frame. Team only: a team member is a Vehicle Portfolios platform operator (platform_admins).
import { sb, html, mount, $, errMsg } from './core.js';
import { navigate } from './router.js';

let ctxCache = null;
export function resetContext() { ctxCache = null; }

async function context() {
  if (ctxCache) return ctxCache;
  const { data } = await sb.auth.getSession();
  const session = data && data.session;
  if (!session) return null;
  const { data: me } = await sb.from('platform_admins').select('user_id').eq('user_id', session.user.id).maybeSingle();
  ctxCache = { user: session.user, team: !!me };
  return ctxCache;
}

export async function page(el, active) {
  let ctx;
  try { ctx = await context(); } catch (e) { mount(el, html`<div class="auth-wrap"><div class="card">${errMsg(e)}</div></div>`); return null; }
  if (!ctx) { navigate(`/login?next=${encodeURIComponent(location.pathname + location.search)}`, { replace: true }); return null; }
  if (!ctx.team) {
    mount(el, html`<div class="auth-wrap"><div class="card"><h1>Team only</h1>
      <p>SEO Audits is for the AI Authority Engine team. You're signed in as <b>${ctx.user.email}</b>, which isn't on the team list.</p>
      <button class="btn alt" id="so">Sign out</button></div></div>`);
    $('#so', el).onclick = async () => { await sb.auth.signOut(); resetContext(); navigate('/login'); };
    return null;
  }
  const link = (href, label, key) => html`<a href="${href}" class="${active === key ? 'on' : ''}">${label}</a>`;
  mount(el, html`<header class="top"><a href="/" class="brand"><span class="mark" aria-hidden="true"></span>SEO Audits <small>AI Authority Engine</small></a>
      <nav>${link('/', 'Audits', 'audits')}${link('/audits/new', 'New audit', 'new')}</nav>
      <button class="me" id="me" title="Sign out">${ctx.user.email} · Sign out</button></header>
    <main class="main" id="main"></main>`);
  $('#me', el).onclick = async () => { await sb.auth.signOut(); resetContext(); navigate('/login'); };
  return { ctx, main: $('#main', el) };
}
