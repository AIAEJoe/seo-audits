// Stage 3: deterministic checks. Crawl evidence in, findings out. No model is involved here: every finding comes from
// a rule, cites the evidence it rests on, and carries the fields a reviewer needs (status, priority, affected URLs,
// observation time, why it matters, the fix, who fixes it, and how to tell it's fixed). Stage 5 rewrites the prose;
// it never adds findings.
//
// Ground rules from the spec, enforced here:
//  * a page our crawler was challenged on is never treated as content, and findings that depend on it are "needs
//    verification"; we never conclude Google is blocked;
//  * conditional offers (finance-only, conquest, loyalty…) are not price inconsistencies;
//  * call-tracking numbers are not NAP errors;
//  * interchangeable city pages: improve or consolidate; never "create more";
//  * no claims about lost traffic, sales, penalties or the website platform's quality.
import { parseRobots, isAllowed } from './robots.js';
import { visibleText } from './html.js';
import { pathOf } from './url.js';

const VDP = new Set(['vdp_new', 'vdp_used', 'vdp_certified']);
const money = (n) => (n == null ? '–' : `$${Number(n).toLocaleString('en-US')}`);
const uniq = (a) => [...new Set(a)];
const ok200 = (p) => p.status_code === 200 && !p.challenge;

/** Every finding goes through here so the required fields are always present. */
function finding(f) {
  const out = {
    rule_id: f.rule, category: f.category, title: f.title.slice(0, 200), status: f.status, priority: f.priority,
    affected_urls: uniq(f.urls).slice(0, 200), observed_at: f.observed_at || new Date().toISOString(),
    evidence_ids: uniq((f.evidence || []).filter(Boolean)), new_evidence: f.newEvidence || [],
    significance: f.significance, recommended_fix: f.fix, responsible_party: f.who, acceptance_criteria: f.accept,
    facts: f.facts || {}, drafted_by: 'rule',
  };
  for (const k of ['significance', 'recommended_fix', 'responsible_party', 'acceptance_criteria']) if (!out[k]) throw new Error(`rule ${f.rule} left ${k} empty`);
  if (!out.affected_urls.length) throw new Error(`rule ${f.rule} has no affected URL`);
  return out;
}

function index(data) {
  const pageById = new Map(data.pages.map((p) => [p.id, p]));
  const ev = (pageId, pred) => data.evidence.filter((e) => e.page_id === pageId && pred(e)).map((e) => e.id);
  const headerEv = (p) => ev(p.id, (e) => e.kind === 'header')[0];
  const sel = (p, s) => ev(p.id, (e) => (e.selector || '').startsWith(s));
  return { pageById, ev, headerEv, sel };
}

// ---------------------------------------------------------------- technical
function technical(data, ix) {
  const out = [];
  const { pages, links } = data;

  // challenged pages → needs verification (one finding per site, listing them)
  const ch = pages.filter((p) => p.challenge);
  if (ch.length) out.push(finding({
    rule: 'technical.crawler_challenged', category: 'technical', status: 'needs_verification', priority: ch.some((p) => p.page_type === 'home' || VDP.has(p.page_type)) ? 'high' : 'medium',
    title: `Our crawler was shown a security challenge on ${ch.length} page${ch.length === 1 ? '' : 's'}`,
    urls: ch.map((p) => p.url), evidence: ch.flatMap((p) => [...ix.sel(p, 'challenge'), ix.headerEv(p)]),
    observed_at: ch[0].fetched_at,
    facts: { pages: ch.map((p) => ({ url: p.url, status: p.status_code, vendor: p.challenge.vendor, signals: p.challenge.signals })) },
    significance: 'These pages answered our audit crawler with a bot challenge instead of content, so they could not be audited. This does not show that Google is blocked: security services usually treat verified Googlebot differently. It does need checking, because if Googlebot were challenged too, these pages could not be crawled or indexed.',
    fix: 'In Google Search Console, run URL Inspection (live test) on these URLs and confirm Googlebot receives the real page. Or check verified server/CDN logs for Googlebot requests to them. If our crawler should audit them, allow the user agent "AIAEAuditBot" in the security service.',
    who: 'website_provider', accept: 'Search Console URL Inspection shows the rendered page (not a challenge) for each URL, or verified logs show Googlebot receiving HTTP 200 content.',
  }));

  // robots.txt rules that would block Googlebot from key pages
  const robots = parseRobots(data.robotsText || '');
  const blocked = pages.filter((p) => ['home', 'srp_new', 'srp_used', 'srp_certified', ...VDP].includes(p.page_type)).filter((p) => !isAllowed(robots, 'googlebot', pathOf(p.url)).allowed);
  if (blocked.length) out.push(finding({
    rule: 'technical.robots_blocks_important', category: 'technical', status: 'confirmed', priority: 'high',
    title: `robots.txt tells Googlebot not to crawl ${blocked.length} key page${blocked.length === 1 ? '' : 's'}`,
    urls: blocked.map((p) => p.url), evidence: [data.robotsEvidenceId], observed_at: data.robotsObservedAt,
    facts: { pages: blocked.map((p) => ({ url: p.url, rule: isAllowed(robots, 'googlebot', pathOf(p.url)).rule })) },
    significance: 'Pages Googlebot is told not to crawl can\'t be crawled for Search or used as supporting links in AI Overviews and AI Mode.',
    fix: 'Remove or narrow the Disallow rules that match these inventory and vehicle pages (keep them for search-result filters and private areas).',
    who: 'website_provider', accept: 'robots.txt allows Googlebot to fetch these URLs (Search Console robots.txt report / URL Inspection shows "Crawl allowed").',
  }));

  // sitemaps
  const files = (data.sitemapInfo && data.sitemapInfo.files) || [];
  const badFiles = files.filter((f) => (f.status && f.status !== 200) || f.error);
  if (badFiles.length) out.push(finding({
    rule: 'technical.sitemap_unreachable', category: 'technical', status: badFiles.some((f) => f.challenge) ? 'needs_verification' : 'confirmed', priority: 'medium',
    title: `${badFiles.length} sitemap file${badFiles.length === 1 ? '' : 's'} listed for search engines can't be fetched`,
    urls: badFiles.map((f) => f.url), evidence: [data.sitemapEvidenceId], observed_at: data.sitemapObservedAt, facts: { files: badFiles },
    significance: 'A sitemap that errors gives search engines nothing; inventory URLs listed only there may be discovered late.',
    fix: 'Fix or remove the broken sitemap from the sitemap index and robots.txt, and make sure inventory sitemaps regenerate as cars arrive and sell.',
    who: 'website_provider', accept: 'Every sitemap in robots.txt and the sitemap index returns HTTP 200 with valid XML; Search Console Sitemaps report shows "Success".',
  }));
  const smBad = data.evidence.filter((e) => e.kind === 'sitemap' && /^Listed in the sitemap; answered HTTP (\d+)/.test(e.content || ''));
  if (smBad.length) out.push(finding({
    rule: 'technical.sitemap_non_200', category: 'technical', status: 'confirmed', priority: smBad.length > 5 ? 'medium' : 'low',
    title: `The sitemap lists ${smBad.length} URL${smBad.length === 1 ? '' : 's'} that don't load (sample)`,
    urls: smBad.map((e) => e.url), evidence: smBad.map((e) => e.id), observed_at: smBad[0].captured_at,
    facts: { urls: smBad.map((e) => ({ url: e.url, note: e.content })) },
    significance: 'Sitemaps should list only live, indexable pages. Sold or removed vehicles left in the sitemap send crawlers to dead pages.',
    fix: 'Remove sold/removed vehicles from the inventory sitemap when they leave inventory (or redirect them to a relevant inventory page).',
    who: 'website_provider', accept: 'A fresh sample of sitemap URLs all return HTTP 200 (or the URLs are gone from the sitemap).',
  }));
  const smUrls = new Set(data.sitemapUrls || []);
  const noidx = pages.filter((p) => smUrls.has(p.url) && /noindex/i.test(`${p.meta_robots || ''} ${p.x_robots_tag || ''}`));
  const noidxEv = data.evidence.filter((e) => e.kind === 'sitemap' && /^Listed in the sitemap; the page says noindex/.test(e.content || '') && !noidx.some((p) => p.url === e.url));
  if (noidx.length || noidxEv.length) out.push(finding({
    rule: 'technical.noindex_in_sitemap', category: 'technical', status: 'confirmed', priority: 'low',
    title: `${noidx.length + noidxEv.length} page${noidx.length + noidxEv.length === 1 ? ' is' : 's are'} in the sitemap but marked noindex`,
    urls: [...noidx.map((p) => p.url), ...noidxEv.map((e) => e.url)], evidence: [...noidx.flatMap((p) => [ix.headerEv(p), ...ix.sel(p, 'rendered: title')]), ...noidxEv.map((e) => e.id)],
    observed_at: (noidx[0] && noidx[0].fetched_at) || noidxEv[0].captured_at,
    facts: { pages: [...noidx.map((p) => ({ url: p.url, meta_robots: p.meta_robots, x_robots_tag: p.x_robots_tag })), ...noidxEv.map((e) => ({ url: e.url, note: e.content }))] },
    significance: 'The sitemap asks for these pages to be indexed while the page asks not to be. Search engines get mixed signals.',
    fix: 'Remove noindex pages (thank-you, form confirmations) from the sitemap, or remove the noindex if the page should be found.',
    who: 'website_provider', accept: 'No sitemap URL carries a noindex robots meta tag or X-Robots-Tag header.',
  }));

  // broken internal links
  const broken = links.filter((l) => l.internal && l.status_code && (l.status_code === 404 || l.status_code === 410 || l.status_code >= 500));
  const brokenTargets = uniq(broken.map((l) => l.to_url));
  if (brokenTargets.length) {
    const from = (u) => uniq(broken.filter((l) => l.to_url === u && l.from_page).map((l) => (ix.pageById.get(l.from_page) || {}).url).filter(Boolean)).slice(0, 5);
    out.push(finding({
      rule: 'technical.broken_internal_link', category: 'technical', status: 'confirmed', priority: brokenTargets.length > 5 ? 'medium' : 'low',
      title: `${brokenTargets.length} internal link target${brokenTargets.length === 1 ? '' : 's'} return${brokenTargets.length === 1 ? 's' : ''} an error`,
      urls: brokenTargets, observed_at: broken[0].checked_at,
      newEvidence: brokenTargets.slice(0, 20).map((u) => ({ kind: 'note', url: u, content: `HTTP ${broken.find((l) => l.to_url === u).status_code}. Linked from: ${from(u).join(', ') || 'the sitemap'}.` })),
      facts: { links: brokenTargets.map((u) => ({ url: u, status: broken.find((l) => l.to_url === u).status_code, linked_from: from(u) })) },
      significance: 'Shoppers who click these links hit an error page, and crawlers spend visits on dead ends.',
      fix: 'Update or remove each link (navigation, footer and page links listed), or redirect the old address to the closest live page.',
      who: 'website_provider', accept: 'Every listed link target returns HTTP 200, or the links are removed.',
    }));
  }

  // redirect chains (2+ hops) on sampled pages and checked links
  const chains = pages.filter((p) => (p.redirect_chain || []).length >= 2);
  if (chains.length) out.push(finding({
    rule: 'technical.redirect_chain', category: 'technical', status: 'opportunity', priority: 'low',
    title: `${chains.length} link${chains.length === 1 ? '' : 's'} go through more than one redirect`,
    urls: chains.map((p) => p.url), evidence: chains.map((p) => ix.headerEv(p)), observed_at: chains[0].fetched_at,
    facts: { chains: chains.map((p) => ({ url: p.url, hops: p.redirect_chain.map((c) => `${c.status} → ${c.location}`), final: p.final_url })) },
    significance: 'Each extra redirect slows the page for shoppers and crawlers. Temporary (302) redirects in the chain are a weaker signal than permanent ones.',
    fix: 'Point links straight at the final URL, and make any remaining redirect a single permanent (301) hop.',
    who: 'website_provider', accept: 'Each listed URL reaches its final page in at most one 301 redirect, and site links use the final URL.',
  }));

  // duplicate vehicle pages without a converging canonical
  const byVin = new Map();
  for (const v of data.vehicles) if (v.vin) { if (!byVin.has(v.vin)) byVin.set(v.vin, []); byVin.get(v.vin).push(v); }
  for (const [vin, vs] of byVin) {
    const ps = uniq(vs.map((v) => v.page_id)).map((id) => ix.pageById.get(id)).filter((p) => p && ok200(p));
    if (ps.length < 2) continue;
    const canon = ps.map((p) => p.canonical_rendered || p.canonical_raw || null);
    const converges = canon.every((c) => c && c === canon[0]);
    if (converges) continue;
    out.push(finding({
      rule: 'technical.duplicate_without_canonical', category: 'technical', status: 'confirmed', priority: 'medium',
      title: `Vehicle ${vin} is published at ${ps.length} URLs without one canonical address`,
      urls: ps.map((p) => p.url), evidence: ps.flatMap((p) => [...ix.sel(p, 'rendered: link[rel=canonical]'), ...ix.sel(p, 'raw: link[rel=canonical]'), ix.headerEv(p)]),
      observed_at: ps[0].fetched_at, facts: { vin, pages: ps.map((p, i) => ({ url: p.url, canonical: canon[i] })) },
      significance: 'The same car at several addresses splits signals between them, and search engines may show the wrong one.',
      fix: 'Give every version of the vehicle page a rel=canonical pointing at the one main vehicle URL (or stop generating the extra URL).',
      who: 'website_provider', accept: `All URLs for VIN ${vin} declare the same canonical URL, which returns HTTP 200.`,
    }));
  }

  // canonical changes after JavaScript / canonical to an error or another site
  const canonDiff = pages.filter((p) => p.render_diff && p.render_diff.canonical && ok200(p));
  if (canonDiff.length) out.push(finding({
    rule: 'technical.canonical_changes_with_js', category: 'technical', status: 'confirmed', priority: 'medium',
    title: `The canonical tag changes after JavaScript runs on ${canonDiff.length} page${canonDiff.length === 1 ? '' : 's'}`,
    urls: canonDiff.map((p) => p.url), evidence: canonDiff.flatMap((p) => [...ix.sel(p, 'raw: link[rel=canonical]'), ...ix.sel(p, 'rendered: link[rel=canonical]'), ix.headerEv(p)]),
    observed_at: canonDiff[0].rendered_at || canonDiff[0].fetched_at, facts: { pages: canonDiff.map((p) => ({ url: p.url, ...p.render_diff.canonical })) },
    significance: 'Google reads the canonical from the HTML it first receives and from the rendered page; conflicting values make the choice unpredictable.',
    fix: 'Output the correct canonical in the initial HTML and don\'t change it with JavaScript.',
    who: 'website_provider', accept: 'Raw and rendered HTML carry the same canonical URL on each listed page.',
  }));

  // titles and descriptions
  const live = pages.filter(ok200);
  const noTitle = live.filter((p) => !p.title);
  if (noTitle.length) out.push(finding({
    rule: 'technical.missing_title', category: 'technical', status: 'confirmed', priority: 'medium', title: `${noTitle.length} page${noTitle.length === 1 ? ' has' : 's have'} no title`,
    urls: noTitle.map((p) => p.url), evidence: noTitle.map((p) => ix.headerEv(p)), observed_at: noTitle[0].fetched_at,
    significance: 'The title is the main text of a search result.', fix: 'Add a unique, descriptive <title> to each page.',
    who: 'website_provider', accept: 'Each listed page has a non-empty <title> in its HTML.',
  }));
  const byTitle = new Map();
  for (const p of live.filter((x) => x.title && !VDP.has(x.page_type))) { const k = p.title.trim().toLowerCase(); if (!byTitle.has(k)) byTitle.set(k, []); byTitle.get(k).push(p); }
  const dupTitles = [...byTitle.values()].filter((g) => g.length > 1);
  if (dupTitles.length) out.push(finding({
    rule: 'technical.duplicate_titles', category: 'technical', status: 'opportunity', priority: 'low',
    title: `${dupTitles.length} title${dupTitles.length === 1 ? ' is' : 's are'} shared by several different pages`,
    urls: dupTitles.flat().map((p) => p.url), evidence: dupTitles.flat().flatMap((p) => [...ix.sel(p, 'rendered: title'), ix.headerEv(p)]), observed_at: dupTitles[0][0].fetched_at,
    facts: { groups: dupTitles.map((g) => ({ title: g[0].title, urls: g.map((p) => p.url) })) },
    significance: 'Identical titles make it hard for shoppers and search engines to tell pages apart.',
    fix: 'Write a distinct title for each page that says what is on it (department, model, offer, city).', who: 'website_provider',
    accept: 'No two of the listed pages share a title.',
  }));
  const noDesc = live.filter((p) => !p.meta_description && ['home', 'srp_new', 'srp_used', 'srp_certified', 'service', 'finance', 'specials'].includes(p.page_type));
  if (noDesc.length) out.push(finding({
    rule: 'technical.missing_meta_description', category: 'technical', status: 'opportunity', priority: 'low',
    title: `${noDesc.length} key page${noDesc.length === 1 ? ' has' : 's have'} no meta description`, urls: noDesc.map((p) => p.url),
    evidence: noDesc.map((p) => ix.headerEv(p)), observed_at: noDesc[0].fetched_at,
    significance: 'Without one, search engines pick their own snippet text, which may not say what the page offers.',
    fix: 'Add a specific meta description (what the page offers, for whom, where).', who: 'website_provider', accept: 'Each listed page has a meta description.',
  }));

  // structured data that doesn't parse
  const badLd = data.sd.filter((b) => b.parse_error);
  if (badLd.length) {
    const ps = uniq(badLd.map((b) => b.page_id)).map((id) => ix.pageById.get(id)).filter(Boolean);
    out.push(finding({
      rule: 'technical.structured_data_parse_error', category: 'technical', status: 'confirmed', priority: 'medium',
      title: `Structured data (JSON-LD) is broken on ${ps.length} page${ps.length === 1 ? '' : 's'}`, urls: ps.map((p) => p.url), observed_at: ps[0].fetched_at,
      newEvidence: badLd.slice(0, 10).map((b) => ({ kind: 'schema_excerpt', page_id: b.page_id, url: (ix.pageById.get(b.page_id) || {}).url, content: `${b.parse_error}\n\n${(b.excerpt || '').slice(0, 1500)}` })),
      significance: 'JSON-LD that doesn\'t parse is ignored entirely, along with everything in it.',
      fix: 'Fix the JSON syntax (validate with the Rich Results Test or a JSON validator).', who: 'website_provider',
      accept: 'Every JSON-LD block on the listed pages parses without errors.',
    }));
  }

  // content that only appears after JavaScript (opportunity)
  const jsOnly = pages.filter((p) => p.render_diff && p.render_diff.word_count && ok200(p));
  if (jsOnly.length) out.push(finding({
    rule: 'technical.js_only_content', category: 'technical', status: 'opportunity', priority: 'low',
    title: `Most of the text on ${jsOnly.length} page${jsOnly.length === 1 ? '' : 's'} appears only after JavaScript runs`,
    urls: jsOnly.map((p) => p.url), evidence: jsOnly.map((p) => ix.headerEv(p)), observed_at: jsOnly[0].fetched_at,
    facts: { pages: jsOnly.map((p) => ({ url: p.url, ...p.render_diff.word_count })) },
    significance: 'Google renders JavaScript, usually after a delay; other crawlers and many AI systems may read only the initial HTML.',
    fix: 'Serve the main content (vehicle details, prices, department information) in the initial HTML (server-side rendering).',
    who: 'website_provider', accept: 'The initial HTML of each listed page contains its main text content.',
  }));
  return out;
}

// ---------------------------------------------------------------- inventory
const DOLLAR = /\$\s?(\d{1,3}(?:,\d{3})+|\d{3,6})/g;

function inventory(data, ix) {
  const out = [];
  const vdps = data.vehicles.map((v) => ({ v, p: ix.pageById.get(v.page_id) })).filter((x) => x.p && ok200(x.p));

  const isStale = (v) => /sold|sale pending/.test(v.page_availability || '');
  // a sold car's stale price is reported once, under schema_stale
  const mismatch = vdps.filter(({ v }) => !isStale(v) && v.visible_price && v.schema_price && Math.abs(v.visible_price - v.schema_price) >= 1);
  for (const { v, p } of mismatch) out.push(finding({
    rule: 'inventory.price_mismatch', category: 'inventory', status: 'confirmed', priority: 'high',
    title: `Price on the page (${money(v.visible_price)}) doesn't match the structured data (${money(v.schema_price)}) for VIN ${v.vin}`,
    urls: [p.url], evidence: [...ix.sel(p, 'rendered: visible price'), ...ix.ev(p.id, (e) => e.kind === 'schema_excerpt'), ix.headerEv(p)], observed_at: v.observed_at,
    facts: { vin: v.vin, stock: v.stock_number, visible_price: v.visible_price, label: v.visible_price_label, schema_price: v.schema_price, conditional_offers: v.discounts.filter((d) => d.conditional) },
    significance: 'Search engines and shopping surfaces read the structured price; Google requires feed and landing-page prices to match. A shopper may see a different price than the one advertised.',
    fix: 'Make the Offer price in the vehicle\'s structured data the same unconditional selling price shown on the page, generated from the same data.',
    who: 'website_provider', accept: `For VIN ${v.vin}, the visible selling price and the structured-data Offer price are identical.`,
  }));

  const stale = vdps.filter(({ v }) => /sold|sale pending/.test(v.page_availability || '') && /InStock|InStoreOnly|OnlineOnly|LimitedAvailability/i.test(v.schema_availability || ''));
  for (const { v, p } of stale) out.push(finding({
    rule: 'inventory.schema_stale', category: 'inventory', status: 'confirmed', priority: 'high',
    title: `Vehicle ${v.vin} says "${v.page_availability}" but its structured data still says in stock${v.schema_price && v.visible_price && v.schema_price !== v.visible_price ? ` at ${money(v.schema_price)}` : ''}`,
    urls: [p.url], evidence: [...ix.ev(p.id, (e) => e.kind === 'schema_excerpt'), ...ix.sel(p, 'rendered: visible price'), ix.headerEv(p)], observed_at: v.observed_at,
    facts: { vin: v.vin, stock: v.stock_number, page_availability: v.page_availability, schema_availability: v.schema_availability, visible_price: v.visible_price, schema_price: v.schema_price },
    significance: 'Search engines may keep showing a sold car as available, at an old price, which sends shoppers to a car they can\'t buy.',
    fix: 'When a vehicle sells, update its structured data availability (SoldOut / remove the Offer) and price in the same step, or take the page down with a redirect to similar inventory.',
    who: 'website_provider', accept: `For VIN ${v.vin}, structured data availability and price match the page (or the page is removed/redirected).`,
  }));

  const noSchema = vdps.filter(({ v }) => !v.schema_price && !v.schema_availability);
  if (noSchema.length) out.push(finding({
    rule: 'inventory.no_vehicle_schema', category: 'inventory', status: 'opportunity', priority: 'low',
    title: `${noSchema.length} vehicle page${noSchema.length === 1 ? ' has' : 's have'} no vehicle offer in structured data`,
    urls: noSchema.map((x) => x.p.url), evidence: noSchema.map((x) => ix.headerEv(x.p)), observed_at: noSchema[0].v.observed_at,
    significance: 'Google retired vehicle-listing rich results in 2025, so this isn\'t about rich results. Accurate structured data (VIN, price, availability) still states the facts unambiguously and must match the page if present.',
    fix: 'Optionally add Car structured data with VIN, Offer price and availability generated from the same data as the page; if added, keep it in sync.',
    who: 'website_provider', accept: 'Each vehicle page either has no vehicle structured data or has data that matches the visible VIN, price and availability.',
  }));

  const noPrice = vdps.filter(({ v }) => !v.visible_price && !/sold/.test(v.page_availability || ''));
  if (noPrice.length) out.push(finding({
    rule: 'inventory.no_visible_price', category: 'inventory', status: 'opportunity', priority: 'medium',
    title: `${noPrice.length} vehicle page${noPrice.length === 1 ? ' shows' : 's show'} no selling price`,
    urls: noPrice.map((x) => x.p.url), evidence: noPrice.map((x) => ix.headerEv(x.p)), observed_at: noPrice[0].v.observed_at,
    facts: { vins: noPrice.map((x) => x.v.vin) },
    significance: 'Shoppers comparing cars skip listings without a price, and there is nothing for search engines to show.',
    fix: 'Show the selling price on each vehicle page (or a clear reason, e.g. "in transit, price pending").', who: 'dealership',
    accept: 'Each listed vehicle page shows a selling price after it loads.',
  }));

  const late = vdps.filter(({ v }) => v.price_seen_after_ms && v.price_seen_after_ms >= 2000);
  if (late.length) out.push(finding({
    rule: 'inventory.price_loads_late', category: 'inventory', status: 'opportunity', priority: 'low',
    title: `The price appears ${Math.round(Math.max(...late.map((x) => x.v.price_seen_after_ms)) / 100) / 10} s after the page loads on ${late.length} vehicle page${late.length === 1 ? '' : 's'}`,
    urls: late.map((x) => x.p.url), evidence: late.flatMap((x) => [...ix.sel(x.p, 'rendered: visible price'), ix.headerEv(x.p)]), observed_at: late[0].v.observed_at,
    facts: { pages: late.map((x) => ({ url: x.p.url, vin: x.v.vin, ms: x.v.price_seen_after_ms, in_initial_html: !(x.p.render_diff && x.p.render_diff.visible_price) })) },
    significance: 'The price matched the structured data, so this isn\'t an inconsistency. Shoppers wait for it, and crawlers that don\'t run scripts never see it.',
    fix: 'Render the selling price in the initial HTML instead of loading it with a script.', who: 'website_provider',
    accept: 'The selling price is present in the initial HTML of each listed page.',
  }));

  // certification claims that disagree between pages
  const certPages = data.pages.filter((p) => p.page_type === 'certified_info' && ok200(p));
  const certVdps = vdps.filter(({ v }) => v.certification_text);
  const pts = (t) => uniq([...String(t || '').matchAll(/\b(\d{2,3})[- ]point/gi)].map((m) => Number(m[1])));
  const progPts = uniq(certPages.flatMap((p) => pts(data.text[p.id])));
  const conflictC = certVdps.filter(({ v }) => progPts.length && pts(v.certification_text).some((n) => !progPts.includes(n)));
  if (conflictC.length) out.push(finding({
    rule: 'inventory.contradictory_disclosure', category: 'inventory', status: 'confirmed', priority: 'high',
    title: `Certified inspection claims disagree: ${uniq(conflictC.flatMap(({ v }) => pts(v.certification_text))).join('/')}-point on vehicle pages vs ${progPts.join('/')}-point on the certified program page`,
    urls: [...conflictC.map((x) => x.p.url), ...certPages.map((p) => p.url)], observed_at: conflictC[0].v.observed_at,
    evidence: [...conflictC.flatMap((x) => ix.sel(x.p, 'rendered: visible price')), ...certPages.map((p) => ix.headerEv(p))],
    newEvidence: [...conflictC.map((x) => ({ kind: 'html_excerpt', page_id: x.p.id, url: x.p.url, content: x.v.certification_text, selector: 'certification text' })),
      ...certPages.map((p) => ({ kind: 'html_excerpt', page_id: p.id, url: p.url, content: (String(data.text[p.id] || '').match(/[^\n.]*\b\d{2,3}[- ]point[^\n.]*/i) || [''])[0], selector: 'certification text' }))],
    facts: { vehicle_pages: conflictC.map(({ v, p }) => ({ url: p.url, vin: v.vin, text: v.certification_text })), program_points: progPts },
    significance: 'Certification is a material claim. Two different inspection standards on the same website is a disclosure inconsistency shoppers and regulators can point to.',
    fix: 'Use the manufacturer\'s current program wording everywhere, generated from one source.', who: 'dealership',
    accept: 'Every page that states the certified inspection uses the same, current point count.',
  }));

  // same-name incentive with different amounts on the specials page vs vehicle pages
  const specials = data.pages.filter((p) => p.page_type === 'specials' && ok200(p));
  const incentiveName = (s) => (String(s).match(/(gm financial|ford credit|toyota financial|honda financial|conquest|loyalty|military|bonus cash|customer cash|trade[- ]in (bonus|assist)|first responder|college)/i) || [null])[0];
  const conflicts = [];
  for (const sp of specials) {
    const text = String(data.text[sp.id] || '');
    for (const line of text.split('\n')) {
      const name = incentiveName(line);
      const amts = [...line.matchAll(DOLLAR)].map((m) => Number(m[1].replace(/,/g, '')));
      if (!name || !amts.length) continue;
      for (const { v, p } of vdps) {
        const modelHit = v.model && new RegExp(`\\b${v.model.split(' ')[0]}\\b`, 'i').test(line);
        if (!modelHit) continue;
        for (const d of v.discounts) {
          if (incentiveName(`${d.label} ${d.condition_text || ''}`)?.toLowerCase() !== name.toLowerCase()) continue;
          const a = Math.abs(d.amount);
          if (!amts.includes(a)) conflicts.push({ name, specials: { url: sp.url, line: line.slice(0, 300), amounts: amts }, vehicle: { url: p.url, vin: v.vin, amount: a, page_id: p.id }, specials_id: sp.id, observed_at: v.observed_at });
        }
      }
    }
  }
  if (conflicts.length) out.push(finding({
    rule: 'inventory.contradictory_disclosure', category: 'inventory', status: 'confirmed', priority: 'high',
    title: `Incentive amounts disagree: "${conflicts[0].name}" is ${money(conflicts[0].specials.amounts[0])} on the specials page but ${money(conflicts[0].vehicle.amount)} on a vehicle page`,
    urls: uniq([...conflicts.map((c) => c.specials.url), ...conflicts.map((c) => c.vehicle.url)]), observed_at: conflicts[0].observed_at,
    newEvidence: [...uniq(conflicts.map((c) => c.specials.url)).map((u) => { const c = conflicts.find((x) => x.specials.url === u); return { kind: 'html_excerpt', page_id: c.specials_id, url: u, content: c.specials.line, selector: 'specials text' }; }),
      ...conflicts.map((c) => ({ kind: 'note', page_id: c.vehicle.page_id, url: c.vehicle.url, content: `VIN ${c.vehicle.vin}: ${c.name} ${money(c.vehicle.amount)}` }))],
    facts: { conflicts: conflicts.map(({ specials_id: _s, ...c }) => c) },
    significance: 'The same offer advertised at two amounts is a disclosure inconsistency: shoppers can hold the dealership to the higher figure, and it undermines trust.',
    fix: 'Publish each incentive from one source with one amount and its eligibility terms, and remove expired versions.', who: 'dealership',
    accept: 'Each incentive shows the same amount and terms on the specials page and on every vehicle page it applies to.',
  }));

  // fees excluded from the advertised price → needs verification (a legal question for the dealer)
  const feeX = vdps.filter(({ v }) => v.fees_text && /\b(plus|\+|excludes?|not included)\b[^.]*\b(dealer|doc(ument(ation)?)?|reconditioning|electronic|registration|service)\s*fee/i.test(v.fees_text));
  if (feeX.length) out.push(finding({
    rule: 'inventory.fees_outside_price', category: 'inventory', status: 'needs_verification', priority: 'medium',
    title: `Dealer fees are listed in addition to the advertised price on ${feeX.length} vehicle page${feeX.length === 1 ? '' : 's'}`,
    urls: feeX.map((x) => x.p.url), evidence: feeX.flatMap((x) => [...ix.sel(x.p, 'rendered: visible price'), ix.headerEv(x.p)]), observed_at: feeX[0].v.observed_at,
    newEvidence: feeX.slice(0, 5).map((x) => ({ kind: 'html_excerpt', page_id: x.p.id, url: x.p.url, content: x.v.fees_text, selector: 'fees text' })),
    facts: { examples: feeX.slice(0, 10).map((x) => ({ url: x.p.url, fees_text: x.v.fees_text })) },
    significance: 'Federal and state advertising rules generally expect mandatory dealer charges to be included in an advertised price (government fees aside). Whether these fees are optional or mandatory, and which rules apply, needs the dealership\'s compliance review.',
    fix: 'Have compliance confirm whether each listed fee is mandatory; if so, include it in the advertised price or follow the applicable state requirements.',
    who: 'dealership', accept: 'Compliance has confirmed the treatment of each fee, and the pages follow it.',
  }));
  return out;
}

// ---------------------------------------------------------------- local
const shingles = (t, n = 5) => { const w = String(t).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean); const s = new Set(); for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' ')); return s; };
const jaccard = (a, b) => { if (!a.size || !b.size) return 0; let i = 0; for (const x of a) if (b.has(x)) i++; return i / (a.size + b.size - i); };

function local(data, ix) {
  const out = [];
  const home = data.pages.find((p) => p.page_type === 'home' && ok200(p));
  const dealerLd = data.sd.filter((b) => b.source === 'rendered' && b.types.some((t) => /AutoDealer|LocalBusiness|Organization|AutomotiveBusiness|CarDealer/.test(t)));

  if (home && !dealerLd.some((b) => b.page_id === home.id)) out.push(finding({
    rule: 'local.no_dealer_schema', category: 'local', status: 'opportunity', priority: 'low',
    title: 'The homepage doesn\'t identify the dealership in structured data', urls: [home.url], evidence: [ix.headerEv(home)], observed_at: home.fetched_at,
    significance: 'A clear AutoDealer description (name, address, phone, hours, departments) consistent with the visible page and the Google Business Profile states the business identity unambiguously, for search and AI systems alike.',
    fix: 'Add AutoDealer structured data to the homepage with the exact name, address, main phone and hours shown on the site.',
    who: 'website_provider', accept: 'The homepage carries AutoDealer (or LocalBusiness) structured data matching its visible NAP and hours.',
  }));

  // phone: schema vs page, with call tracking recognised
  if (home) {
    const ld = dealerLd.find((b) => b.page_id === home.id && b.data);
    const flat = ld ? [].concat(ld.data['@graph'] || ld.data).find((o) => o && o.telephone) : null;
    const schemaPhone = flat ? String(flat.telephone).replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '') : null;
    const diff = home.render_diff && home.render_diff.phones;
    const rawPhones = diff ? diff.raw : null;
    if (schemaPhone && rawPhones && rawPhones.length && !rawPhones.includes(schemaPhone) && !diff.call_tracking) out.push(finding({
      rule: 'local.nap_phone_mismatch', category: 'local', status: 'confirmed', priority: 'medium',
      title: 'The phone number in the dealership\'s structured data isn\'t one shown on the homepage', urls: [home.url], evidence: [ix.headerEv(home)], observed_at: home.fetched_at,
      facts: { schema_phone: schemaPhone, page_phones: rawPhones },
      significance: 'Business identity details should agree everywhere; conflicting phone numbers weaken them.', fix: 'Use the main published number in structured data.',
      who: 'website_provider', accept: 'The structured-data phone number matches the main number shown on the page.',
    }));
  }

  // interchangeable city pages
  const cities = data.pages.filter((p) => p.page_type === 'city' && ok200(p) && data.text[p.id]);
  if (cities.length >= 2) {
    const strip = (p) => { let t = String(data.text[p.id]); const name = (p.title || '').match(/near ([A-Z][a-zA-Z .]+?)(,|\s\||$)/); if (name) t = t.split(name[1]).join('CITY'); return shingles(t); };
    const sh = cities.map(strip);
    let pairs = 0; let high = 0;
    for (let i = 0; i < sh.length; i++) for (let j = i + 1; j < sh.length; j++) { pairs++; if (jaccard(sh[i], sh[j]) >= 0.8) high++; }
    if (high && high / pairs >= 0.5) out.push(finding({
      rule: 'local.interchangeable_city_pages', category: 'local', status: 'opportunity', priority: 'medium',
      title: `${cities.length} city pages are nearly identical apart from the city name`, urls: cities.map((p) => p.url),
      evidence: cities.flatMap((p) => [...ix.sel(p, 'rendered: title'), ix.headerEv(p)]), observed_at: cities[0].fetched_at,
      facts: { pages: cities.map((p) => p.url), similar_pairs: `${high} of ${pairs}` },
      significance: 'Interchangeable location pages add little for shoppers and can be treated as low-value or doorway-like content. More of them would not help.',
      fix: 'Keep only cities you genuinely serve and give each page specific, useful content (directions and drive time, local service and delivery details, local customer questions), or consolidate them. Do not create more templated city pages.',
      who: 'marketing_agency', accept: 'Each remaining city page has substantially unique, useful content (no two pages over 80% the same).',
    }));
  }

  // hours on home/contact
  const hoursPages = data.pages.filter((p) => ['home', 'contact'].includes(p.page_type) && ok200(p) && data.text[p.id]);
  if (hoursPages.length && !hoursPages.some((p) => /\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b[^\n]{0,40}\d{1,2}(:\d{2})?\s*(am|pm|a\.m\.|p\.m\.)/i.test(data.text[p.id]))) out.push(finding({
    rule: 'local.hours_not_found', category: 'local', status: 'opportunity', priority: 'low',
    title: 'Opening hours weren\'t found in the text of the homepage or contact page', urls: hoursPages.map((p) => p.url),
    evidence: hoursPages.map((p) => ix.headerEv(p)), observed_at: hoursPages[0].fetched_at,
    significance: 'Shoppers and AI answers look for hours by department; hours shown only in images or widgets may not be read.',
    fix: 'Show sales, service and parts hours as text on the homepage footer and contact page, matching the Google Business Profile.', who: 'website_provider',
    accept: 'Department hours appear as text on the homepage or contact page and match the Business Profile.',
  }));

  // Business Profile: always flagged as needing access, separate from website findings
  if (home) out.push(finding({
    rule: 'local.gbp_needs_access', category: 'local', status: 'needs_verification', priority: 'medium',
    title: 'Google Business Profile not reviewed (needs access)', urls: [home.url], evidence: [ix.headerEv(home)], observed_at: home.fetched_at,
    significance: 'Business Profile categories, hours, departments, photos and Q&A matter for local results and AI answers, but they can\'t be verified from the website.',
    fix: 'Grant AI Authority Engine manager access to the Business Profile (or share screenshots) so name, address, phone, hours, categories and department profiles can be compared with the website.',
    who: 'gbp_owner', accept: 'Business Profile details have been reviewed and match the website, or the differences are listed as separate findings.',
  }));
  return out;
}

export function runChecks(data) {
  const ix = index(data);
  const all = [...technical(data, ix), ...inventory(data, ix), ...local(data, ix)];
  const rank = { high: 0, medium: 1, low: 2 };
  return all.sort((a, b) => rank[a.priority] - rank[b.priority]);
}

/** Visible text of the stored rendered HTML (or raw) for the pages the text-based checks need. */
export const TEXT_TYPES = new Set(['home', 'contact', 'certified_info', 'specials', 'city']);
export const textFromHtml = (html) => visibleText(html);
