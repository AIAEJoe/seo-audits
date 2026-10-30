import { sb, html, mount, $, errMsg, toast } from '../core.js';
import { navigate } from '../router.js';
import { resetContext } from '../layout.js';

export default async function login(el) {
  const next = new URLSearchParams(location.search).get('next') || '/';
  const { data } = await sb.auth.getSession();
  if (data && data.session) { navigate(next, { replace: true }); return; }
  const hashErr = new URLSearchParams(location.hash.slice(1)).get('error_description');
  mount(el, html`<div class="auth-wrap"><div class="card">
    <div class="brand big"><span class="mark" aria-hidden="true"></span>SEO Audits</div>
    <p class="sub">AI Authority Engine team sign-in. Same login as Vehicle Portfolios.</p>
    ${hashErr ? html`<p class="notice bad">${hashErr.replace(/\+/g, ' ')}. Ask for a new link below.</p>` : ''}
    <form id="pw">
      <label for="email">Email</label><input id="email" type="email" autocomplete="username" required>
      <label for="password">Password</label><input id="password" type="password" autocomplete="current-password" required>
      <button class="btn" style="margin-top:14px;width:100%">Sign in</button>
    </form>
    <button class="btn ghost" id="link" style="margin-top:8px;width:100%">Email me a sign-in link</button>
    <div id="msg"></div></div></div>`);
  $('#pw', el).addEventListener('submit', async (e) => {
    e.preventDefault();
    const { error } = await sb.auth.signInWithPassword({ email: $('#email', el).value.trim(), password: $('#password', el).value });
    if (error) { mount($('#msg', el), html`<p class="notice bad">${error.message === 'Invalid login credentials' ? 'That email and password don\'t match.' : errMsg(error)}</p>`); return; }
    resetContext();
    navigate(next, { replace: true });
  });
  $('#link', el).addEventListener('click', async () => {
    const email = $('#email', el).value.trim();
    if (!email) { toast('Enter your email first', 'bad'); return; }
    const { error } = await sb.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: `${location.origin}${next}` } });
    mount($('#msg', el), error ? html`<p class="notice bad">${errMsg(error)}</p>` : html`<p class="notice ok">Check ${email} for a sign-in link.</p>`);
  });
}
