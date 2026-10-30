// Injects the public runtime config (Supabase URL + anon key) into HTML pages.
export async function onRequest({ request, env, next }) {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return next();
  const res = await next();
  if (request.method !== 'GET' || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const config = { supabaseUrl: env.SUPABASE_URL || '', supabaseAnonKey: String(env.SUPABASE_ANON_KEY || '').trim() };
  const html = (await res.text()).replace('</head>', `<script>window.SEO_CONFIG=${JSON.stringify(config).replace(/</g, '\\u003c')}</script></head>`);
  const headers = new Headers(res.headers);
  headers.delete('content-length');
  headers.set('cache-control', 'no-cache');
  return new Response(html, { status: res.status, headers });
}
