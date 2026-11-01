// Facts from one page's HTML (raw or rendered): SEO tags, links, structured data, phone numbers and, on vehicle pages,
// the vehicle and its pricing. These are observations only; deciding what's wrong is the checks' job (Stage 3).
import { title, metas, canonicals, linkTags, anchors, headings, visibleText, jsonLdBlocks, microdataTypes } from './html.js';
import { normalizeUrl, sameSite } from './url.js';

export function pageFacts(html, url) {
  const m = metas(html);
  const text = visibleText(html);
  return {
    title: title(html),
    meta_description: m.description ?? null,
    meta_robots: [m.robots, m.googlebot ? `googlebot: ${m.googlebot}` : null].filter(Boolean).join('; ') || null,
    canonicals: canonicals(html).map((c) => normalizeUrl(c, url) || c),
    hreflang: linkTags(html).filter((a) => /alternate/i.test(a.rel || '') && a.hreflang).map((a) => ({ lang: a.hreflang, href: a.href })),
    h1: headings(html, 1),
    lang: ((String(html).match(/<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i) || [])[1]) || null,
    word_count: text ? text.split(/\s+/).length : 0,
    text,
  };
}

export function pageLinks(html, url, siteUrl) {
  const out = [];
  const seen = new Set();
  for (const a of anchors(html)) {
    const href = a.href.trim();
    if (!href || /^(mailto:|tel:|sms:|javascript:|#)/i.test(href)) continue;
    const abs = normalizeUrl(href, url);
    if (!abs) continue;
    const key = `${abs}|${a.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ to_url: abs, anchor: a.text || null, rel: a.rel, internal: sameSite(abs, siteUrl) });
  }
  return out;
}

// ---------------- structured data ----------------
const typesOf = (o) => [].concat(o && o['@type'] ? o['@type'] : []).map(String);
export function flattenLd(data) {
  const out = [];
  const walk = (o) => {
    if (Array.isArray(o)) return o.forEach(walk);
    if (!o || typeof o !== 'object') return;
    if (o['@type']) out.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  walk(data);
  return out;
}
export function structuredData(html) {
  const blocks = jsonLdBlocks(html).map((b) => ({ format: 'json-ld', data: b.data, excerpt: b.raw.slice(0, 4000), parse_error: b.error || null,
    types: b.data ? [...new Set(flattenLd(b.data).flatMap(typesOf))] : [] }));
  const md = microdataTypes(html);
  if (md.length) blocks.push({ format: 'microdata', data: null, excerpt: null, parse_error: null, types: md });
  return blocks;
}

// ---------------- phone numbers ----------------
const PHONE = /(?:\+?1[\s.-]?)?\(?\b([2-9]\d{2})\)?[\s.-]?(\d{3})[\s.-](\d{4})\b/g;
export const CALL_TRACKING = /callrail|invoca|marchex|calltrackingmetrics|dialogtech|convirza|mongoose[- ]?metrics|ringba|telmetrics|delacon|\bdni\b|number[_-]?swap|phone[_-]?swap|swap\.js/i;
export function phones(html) {
  const text = visibleText(html);
  const found = new Map();
  for (const m of text.matchAll(PHONE)) { const d = m[1] + m[2] + m[3]; if (!found.has(d)) found.set(d, m[0].trim()); }
  for (const m of String(html).matchAll(/href\s*=\s*["']tel:([^"']+)["']/gi)) { const d = m[1].replace(/\D/g, '').replace(/^1(?=\d{10}$)/, ''); if (d.length === 10 && !found.has(d)) found.set(d, m[1]); }
  return { numbers: [...found.entries()].map(([digits, shown]) => ({ digits, shown })), call_tracking: (String(html).match(CALL_TRACKING) || [null])[0] };
}

// ---------------- vehicles ----------------
const VIN = /\b(?=[A-HJ-NPR-Z0-9]*\d)(?=[A-HJ-NPR-Z0-9]*[A-HJ-NPR-Z])[A-HJ-NPR-Z0-9]{17}\b/;
const money = (s) => { const n = Number(String(s).replace(/[^0-9.]/g, '')); return Number.isFinite(n) && n > 0 ? n : null; };
const CONDITIONAL = /\bmust\b|when you (finance|lease|trade)|with (gm|ford|toyota|honda|nissan|hyundai|kia|stellantis|ally)?\s*financ|financ(e|ing) (with|through)|lease conquest|\bconquest\b|loyalty|military|first responder|college|graduate|\bqualif|\beligib|with (a )?trade|trade[- ]in (assist|bonus)|all offers|with all (incentives|rebates)|with financing|subject to (credit|approval)|on approved credit|\boac\b|in lieu of|not compatible with/i;
const DISCOUNT = /discount|savings|rebate|\bcash\b|bonus|incentive|allowance|\boff\b|markdown|price (drop|reduction)/i;
const MSRP = /\bmsrp\b|sticker price|manufacturer'?s suggested/i;
const FEES = /\bfees?\b|\bdoc(ument(ation)?)?\b|\bplus tax|tag,? (and )?title|dealer (fee|service)|reconditioning fee|destination/i;
const SELL = /selling price|our price|sale price|internet price|e-?price|your price|market price|live market|special price|now|^price\b|\bprice\b/i;

/** Every "$X" on its own text line with the words around it, classified. */
export function priceLines(text) {
  const out = [];
  for (const line of String(text).split('\n')) {
    for (const m of line.matchAll(/(-|−|–)?\s*\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})(?:\.\d{2})?/g)) {
      const amount = money(m[2]);
      if (!amount || amount < 100) continue;
      const negative = !!m[1];
      const label = line.slice(0, m.index).replace(/[:\s]+$/, '').slice(-80);
      const kind = MSRP.test(label) ? 'msrp'
        : CONDITIONAL.test(line) ? 'conditional'
        : negative || DISCOUNT.test(label) ? 'discount'
        : FEES.test(label) || (FEES.test(line) && !SELL.test(label)) ? 'fee'
        : SELL.test(label) || label === '' ? 'price' : 'other';
      out.push({ amount: negative ? -amount : amount, label: label || null, kind, conditional: CONDITIONAL.test(line), line: line.slice(0, 300) });
    }
  }
  return out;
}

function certifiedCar(html, ldCar, cert) {
  const h1 = (String(html).match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || '';
  const t = (String(html).match(/<title\b[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '';
  return /certified|\bcpo\b/i.test(h1 + ' ' + t + ' ' + ((ldCar && ldCar.name) || '')) || !!cert;
}

export function vehicleFacts(html, sd = structuredData(html)) {
  const text = visibleText(html);
  const items = sd.filter((b) => b.data).flatMap((b) => flattenLd(b.data))
    .filter((o) => typesOf(o).some((t) => /^(Car|Vehicle|MotorizedVehicle|Motorcycle|Product|IndividualProduct|BusOrCoach)$/.test(t)));
  const ldCar = items.find((o) => o.vehicleIdentificationNumber) || items.find((o) => typesOf(o).some((t) => /Car|Vehicle/.test(t))) || null;
  const offer = ldCar ? [].concat(ldCar.offers || [])[0] || null : null;
  const textVin = ((text.match(new RegExp(`VIN[\\s:#]*(${VIN.source.slice(2, -2)})`, 'i')) || [])[1]) || ((text.match(VIN) || [])[0]) || null;
  const vin = (ldCar && ldCar.vehicleIdentificationNumber) || textVin;
  if (!vin && !ldCar) return null;
  const lines = priceLines(text);
  const sell = lines.find((l) => l.kind === 'price' && !l.conditional && l.amount > 0);
  const msrp = lines.find((l) => l.kind === 'msrp');
  const cond = (ldCar && (ldCar.itemCondition || (offer && offer.itemCondition))) || '';
  const lower = text.toLowerCase();
  const pageAvail = /\bsale pending\b/.test(lower) ? 'sale pending' : /(^|\n)\s*sold\s*($|\n)|\bthis vehicle (has been|is) sold\b/.test(lower) ? 'sold'
    : /\bin transit\b/.test(lower) ? 'in transit' : /\bon order\b/.test(lower) ? 'on order' : /\bin stock\b/.test(lower) ? 'in stock' : null;
  const cert = (text.match(/[^\n.]*\b\d{2,3}[- ]point\b[^\n.]*/i) || [])[0] || null;
  const warranty = text.split('\n').filter((l) => /warrant/i.test(l)).slice(0, 4).join(' ').slice(0, 600) || null;
  const stock = ((text.match(/stock\s*(?:#|no\.?|number)?\s*:?\s*([A-Z0-9][A-Z0-9-]{2,14})\b/i) || [])[1]) || (ldCar && ldCar.sku) || null;
  return {
    vin: vin ? String(vin).toUpperCase() : null,
    stock_number: stock,
    // "Certified" in the menu doesn't make a car certified: only its own heading, schema name or inspection claim does.
    condition: /New/i.test(cond) ? 'new' : /Used|Refurbished/i.test(cond) ? (certifiedCar(html, ldCar, cert) ? 'certified' : 'used') : 'unknown',
    year: Number((ldCar && (ldCar.vehicleModelDate || ldCar.modelDate || ldCar.productionDate)) || 0) || null,
    make: ldCar ? (typeof ldCar.brand === 'object' ? ldCar.brand && ldCar.brand.name : ldCar.brand) || ldCar.manufacturer || null : null,
    model: ldCar ? (typeof ldCar.model === 'object' ? ldCar.model && ldCar.model.name : ldCar.model) || null : null,
    trim: ldCar ? ldCar.vehicleConfiguration || null : null,
    visible_price: sell ? sell.amount : null,
    visible_price_label: sell ? sell.label : null,
    msrp: msrp ? msrp.amount : null,
    discounts: lines.filter((l) => l.kind === 'discount' || l.kind === 'conditional').map((l) => ({ label: l.label, amount: l.amount, conditional: l.conditional, condition_text: l.conditional ? l.line : null })),
    fees_text: (text.split('\n').find((l) => FEES.test(l) && /\$|fee/i.test(l)) || null),
    schema_price: offer ? money(offer.price ?? offer.lowPrice) : null,
    schema_currency: offer ? offer.priceCurrency || null : null,
    schema_availability: offer && offer.availability ? String(offer.availability).replace(/^https?:\/\/schema\.org\//, '') : null,
    page_availability: pageAvail,
    certification_text: cert,
    warranty_text: warranty,
    price_lines: lines,
  };
}
