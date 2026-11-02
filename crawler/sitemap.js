// XML sitemaps and sitemap indexes. Locations are read as data; nothing in them is followed off the site.
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").trim();

export function parseSitemap(xml) {
  const text = String(xml || '');
  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const blocks = text.match(isIndex ? /<sitemap[\s>][\s\S]*?<\/sitemap>/gi : /<url[\s>][\s\S]*?<\/url>/gi) || [];
  const entries = blocks.map((b) => {
    const loc = (b.match(/<loc>\s*(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?\s*<\/loc>/i) || [])[1];
    const lastmod = (b.match(/<lastmod>([\s\S]*?)<\/lastmod>/i) || [])[1];
    return loc ? { loc: decode(loc), lastmod: lastmod ? lastmod.trim() : null } : null;
  }).filter(Boolean);
  return { type: isIndex ? 'index' : /<urlset[\s>]/i.test(text) ? 'urlset' : 'unknown', entries };
}

/** Gzip sitemaps (.xml.gz) are decompressed when the runtime supports it. */
export async function sitemapText(res) {
  const type = res.headers.get('content-type') || '';
  if (/gzip/.test(type) || /\.gz($|\?)/.test(res.url || '')) {
    if (typeof DecompressionStream === 'function' && res.body) {
      try { return await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).text(); } catch { /* fall through */ }
    }
  }
  return res.text();
}
