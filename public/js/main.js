import { route, start } from './router.js';
import { configured, mount, html } from './core.js';

if (!configured) {
  mount(document.getElementById('app'), html`<div class="auth-wrap"><div class="card">
    <h1>Almost there</h1>
    <p>This site isn't connected to Supabase yet. Add <code>SUPABASE_URL</code> and <code>SUPABASE_ANON_KEY</code>
    to the Cloudflare Pages environment variables, then redeploy.</p></div></div>`);
} else {
  route('/', () => import('./pages/audits.js'));
  route('/login', () => import('./pages/login.js'));
  route('/audits/new', () => import('./pages/audit-new.js'));
  route('/audits/:id', () => import('./pages/audit.js'));
  start();
}
