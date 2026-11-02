// What kind of dealership page a URL is, from its address and (when known) its title and facts.
const VINISH = /[a-hj-npr-z0-9]{17}/i;
const RULES = [
  ['vdp_certified', (u) => /(certified|cpo)[^/]*\/?.*/i.test(u) && VINISH.test(u) && /inventory|vehicle|detail|vdp|\/(used|certified)/i.test(u)],
  ['vdp_new', (u) => /\/(new)[-/]/i.test(u) && VINISH.test(u)],
  ['vdp_used', (u) => (/\/(used|pre-?owned)[-/]/i.test(u) && VINISH.test(u)) || /[?&]vin=/i.test(u) || /vehicle-details|\/vdp\b|\/detail\//i.test(u) && VINISH.test(u)],
  ['srp_certified', (u) => /\/(certified|cpo)[-_]?(pre-?owned[-_]?)?(vehicles|inventory|cars)?\/?(\?|$)|searchcertified/i.test(u)],
  ['srp_new', (u) => /\/new[-_]?(vehicles|inventory|cars|chevrolet|for-sale)?\/?(\?|$)|searchnew|new-inventory|\/inventory\/new\/?(\?|$)/i.test(u)],
  ['srp_used', (u) => /\/(used|pre-?owned)[-_]?(vehicles|inventory|cars|for-sale)?\/?(\?|$)|searchused|used-inventory|\/inventory\/used\/?(\?|$)/i.test(u)],
  ['certified_info', (u) => /certified[-_]?(program|pre-?owned-?program|benefits|info)|why[-_]buy[-_]certified|\/cpo[-_]program/i.test(u)],
  ['finance', (u) => /financ|credit|loan|lease[-_]?(deals|offers)?\/?$|payment[-_]calculator|get[-_]approved|value[-_]your[-_]trade/i.test(u)],
  ['service', (u) => /service|parts|maintenance|repair|oil[-_]change|tires?\b|collision|body[-_]shop/i.test(u)],
  ['specials', (u) => /special|offers?\b|incentive|(^|[/_-])deals?([/_-]|$)|rebate|promo/i.test(u)],
  ['city', (u) => /(dealer|dealership)[-_](near|in|serving)|[-_](near|serving)[-_]|\b(near|serving)[-_]/i.test(u) || /-chevrolet-dealer\/?$|-dealer\/?$/i.test(u)],
  ['contact', (u) => /contact|hours|directions|location/i.test(u)],
  ['about', (u) => /about|staff|team|careers|reviews|testimonials/i.test(u)],
  ['model', (u) => /\/(new-)?(chevrolet|chevy|ford|toyota|honda|gmc|buick|cadillac|ram|jeep|dodge|nissan|hyundai|kia)-[a-z0-9-]+\/?$|model[-_]research|showroom|\/research\//i.test(u)],
];

export function classifyUrl(url, siteUrl) {
  let path;
  try { const u = new URL(url); path = u.pathname + u.search; } catch { return 'other'; }
  try { if (new URL(siteUrl).pathname === path || path === '/' || path === '') return 'home'; } catch { /* ignore */ }
  for (const [type, test] of RULES) if (test(path)) return type;
  return 'other';
}

/** Refine with what the page said about itself (vehicle facts beat the URL). */
export function refineType(type, { vehicle, title } = {}) {
  if (vehicle && vehicle.vin && (vehicle.visible_price || vehicle.schema_price)) {
    if (vehicle.condition === 'new') return 'vdp_new';
    if (vehicle.condition === 'certified' || /certified/i.test(title || '')) return 'vdp_certified';
    if (vehicle.condition === 'used') return 'vdp_used';
    return type.startsWith('vdp_') ? type : 'vdp_used';
  }
  return type;
}
