export const onRequestGet = ({ env }) => new Response(JSON.stringify({ ok: true, app: 'seo-audits', supabase: !!env.SUPABASE_URL }), {
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
});
