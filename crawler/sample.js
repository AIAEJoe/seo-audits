// A representative sample, not the whole site: every page type a shopper meets, and vehicle pages spread across
// new, used and certified inventory. Deterministic for a given audit (seeded), so a re-run samples the same pages.
import { classifyUrl } from './classify.js';

const QUOTA = { home: 1, srp_new: 1, srp_used: 1, srp_certified: 1, model: 4, finance: 2, service: 3, specials: 2, certified_info: 2, contact: 2, about: 1, other: 4 };

function hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** candidates: [{url, via}] → [{url, type, via}] within the page budget. */
export function samplePages(candidates, { siteUrl, plan = {}, budget = 100, seed = '' }) {
  const byType = new Map();
  const seen = new Set();
  for (const c of candidates) {
    if (!c.url || seen.has(c.url)) continue;
    seen.add(c.url);
    const type = c.type || classifyUrl(c.url, siteUrl);
    if (!byType.has(type)) byType.set(type, []);
    byType.get(type).push({ ...c, type });
  }
  const quota = { ...QUOTA, vdp_new: plan.new ?? 10, vdp_used: plan.used ?? 10, vdp_certified: plan.certified ?? 5, city: plan.city ?? 10 };
  const order = ['home', 'srp_new', 'srp_used', 'srp_certified', 'vdp_new', 'vdp_used', 'vdp_certified', 'specials', 'finance', 'service', 'certified_info', 'model', 'contact', 'city', 'about', 'other'];
  const out = [];
  for (const type of order) {
    const list = (byType.get(type) || []).slice();
    // Prefer pages found in navigation/links over sitemap-only ones for non-vehicle types; spread vehicle picks.
    list.sort((a, b) => (type.startsWith('vdp_') ? 0 : (a.via === 'sitemap') - (b.via === 'sitemap')) || hash(seed + a.url) - hash(seed + b.url));
    for (const c of list.slice(0, quota[type] ?? 0)) { if (out.length >= budget) return out; out.push(c); }
  }
  return out;
}

export const DISCOVERY_TYPES = new Set(['srp_new', 'srp_used', 'srp_certified']);
