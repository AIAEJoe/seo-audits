// Small, dependency-free HTML reading: enough for SEO facts. Page content is only ever read as data.
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', hellip: '…', copy: '©', reg: '®', trade: '™' };
export function decodeEntities(s) {
  return String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const clean = (s) => decodeEntities(String(s ?? '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function attrs(tag) {
  const out = {};
  const re = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  const inner = tag.replace(/^<\s*[\w:-]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

export function stripNoise(html) {
  return String(html || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|template|svg|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ');
}

export function headOf(html) {
  const m = String(html || '').match(/<head\b[\s\S]*?<\/head>/i);
  return m ? m[0] : String(html || '').slice(0, 200000);
}

export function title(html) {
  const m = headOf(html).replace(/<!--[\s\S]*?-->/g, '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || String(html || '').match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return m ? clean(m[1]) : null;
}

/** All <meta> tags as {name|property|http-equiv: content}. Later duplicates are kept in .all */
export function metas(html) {
  const out = {}; const all = [];
  for (const t of String(html || '').replace(/<!--[\s\S]*?-->/g, '').match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(t);
    const key = (a.name || a.property || a['http-equiv'] || '').toLowerCase();
    if (!key) continue;
    all.push({ key, content: a.content ?? '' });
    if (!(key in out)) out[key] = a.content ?? '';
  }
  out.all = all;
  return out;
}

export function linkTags(html) {
  return (String(html || '').replace(/<!--[\s\S]*?-->/g, '').match(/<link\b[^>]*>/gi) || []).map(attrs);
}

export function canonicals(html) {
  return linkTags(html).filter((a) => String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical')).map((a) => a.href).filter(Boolean);
}

export function anchors(html) {
  const out = [];
  const re = /<a\b[^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  const src = stripNoise(html);
  while ((m = re.exec(src))) {
    const a = attrs(m[0].match(/^<a\b[^>]*>/i)[0]);
    if (a.href === undefined) continue;
    out.push({ href: a.href, text: clean(m[1]).slice(0, 200), rel: a.rel || null });
  }
  return out;
}

export function headings(html, level = 1) {
  const re = new RegExp(`<h${level}\\b[^>]*>([\\s\\S]*?)<\\/h${level}>`, 'gi');
  return [...stripNoise(html).matchAll(re)].map((m) => clean(m[1])).filter(Boolean);
}

/** Visible-ish text with line breaks at block boundaries (for prices, phone numbers, disclosures). */
export function visibleText(html) {
  const body = (String(html || '').match(/<body\b[\s\S]*<\/body>/i) || [String(html || '')])[0];
  return decodeEntities(stripNoise(body)
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article|\/header|\/footer|\/dd|\/dt|\/td|\/th|\/option|\/small|\/span)\b[^>]*>/gi, (t) => (/\/(span|small)/i.test(t) ? ' ' : '\n'))
    .replace(/<[^>]+>/g, ' '))
    .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function jsonLdBlocks(html) {
  const out = [];
  for (const m of String(html || '').matchAll(/<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi)) {
    const raw = m[1].trim();
    try { out.push({ raw, data: JSON.parse(raw.replace(/^<!\[CDATA\[|\]\]>$/g, '')) }); }
    catch (e) { out.push({ raw, data: null, error: `JSON-LD doesn't parse: ${e.message}` }); }
  }
  return out;
}

export function microdataTypes(html) {
  return [...new Set([...String(html || '').matchAll(/itemtype\s*=\s*["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)].map((m) => m[1]))];
}

/** A short, exact excerpt of the raw HTML around a match, for evidence. */
export function excerpt(html, needle, radius = 300) {
  const s = String(html || '');
  const i = typeof needle === 'string' ? s.indexOf(needle) : s.search(needle);
  if (i < 0) return null;
  return s.slice(Math.max(0, i - radius), Math.min(s.length, i + (typeof needle === 'string' ? needle.length : 0) + radius));
}
