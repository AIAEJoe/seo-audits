// Shared audit facts: statuses, stages, URL rules and where an audit's files are stored. Pure, unit-tested.

export const STATUS_LABEL = {
  draft: 'Draft', queued: 'Queued', crawling: 'Crawling', checking: 'Checking', drafting: 'Writing findings',
  review: 'Ready for review', complete: 'Complete', failed: 'Failed', cancelled: 'Cancelled',
};

// The pipeline, in order. Stage numbers match the build plan; later stages show as "coming" until built.
export const STAGES = [
  { key: 'preflight', label: 'Preflight', detail: 'robots.txt, sitemaps, homepage, platform' },
  { key: 'sample', label: 'Sample pages', detail: 'home, inventory, vehicle pages, model, finance, service, specials, city' },
  { key: 'fetch', label: 'Fetch + render', detail: 'raw HTML and browser-rendered page, screenshot, challenge check' },
  { key: 'checks', label: 'Checks', detail: 'technical, inventory pricing, local, content, AI readiness' },
  { key: 'speed', label: 'Page speed', detail: 'PageSpeed Insights / Chrome UX Report for key templates' },
  { key: 'draft', label: 'Write-ups', detail: 'Claude explains verified evidence; nothing new is claimed' },
  { key: 'review', label: 'Team review', detail: 'approve or reject each finding' },
  { key: 'reports', label: 'Reports', detail: 'audit, GM summary, 30/60/90 plan, tickets, email' },
];

export const FINDING_STATUS = { confirmed: 'Confirmed issue', opportunity: 'Opportunity', needs_verification: 'Needs verification' };
export const RESPONSIBLE = {
  website_provider: 'Website provider', dealership: 'Dealership', marketing_agency: 'Marketing agency',
  gbp_owner: 'Google Business Profile owner', inventory_provider: 'Inventory / feed provider', aiae: 'AI Authority Engine',
};

const PRIVATE_HOST = /^(localhost|.*\.local|.*\.internal|.*\.localhost)$|^(\d{1,3}\.){3}\d{1,3}$|^\[|:/i;

/** "newsmyrnachevy.com/" → "https://www.newsmyrnachevy.com/"-style origin URL, or throws a plain-English error. */
export function normalizeSiteUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Enter the dealership\'s website address.');
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u;
  try { u = new URL(s); } catch { throw new Error('That doesn\'t look like a website address.'); }
  const host = u.hostname.toLowerCase();
  if (PRIVATE_HOST.test(host) || !/\.[a-z]{2,}$/.test(host)) throw new Error('Use the dealership\'s public website address (a domain name, not an IP or local address).');
  if (u.username || u.password) throw new Error('Leave out any username or password.');
  return `${u.protocol}//${host}${u.port ? `:${u.port}` : ''}/`;
}

/** "Lou Bachrodt Chevrolet https://www.loubachrodtchevy.com" per line → [{name, url}] */
export function parseCompetitors(text) {
  return String(text || '').split(/\n+/).map((l) => l.trim()).filter(Boolean).slice(0, 10).map((l) => {
    const m = l.match(/(https?:\/\/\S+|[a-z0-9-]+(\.[a-z0-9-]+)+\.[a-z]{2,}\S*|[a-z0-9-]+\.[a-z]{2,}\S*)/i);
    const url = m ? (() => { try { return normalizeSiteUrl(m[0]); } catch { return null; } })() : null;
    const name = (m ? l.replace(m[0], '') : l).replace(/[\s,–—-]+$/, '').replace(/^[\s,–—-]+/, '').trim();
    return { name: name || (url ? new URL(url).hostname.replace(/^www\./, '') : l), url };
  });
}

const slug = (s) => String(s || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'dealership';

/** Where an audit's files live in the private "seo" bucket: <dealership>/<YYYY-MM-DD>/<audit id>/ */
export function storagePrefix(a) {
  const day = new Date(a.created_at || Date.now()).toISOString().slice(0, 10);
  return `${slug(a.dealership_name)}/${day}/${a.id}/`;
}

/** File name for a report: "New-Smyrna-Beach-Chevrolet_SEO-Audit_2026-11-02.pdf" */
export function reportFileName(a, kind, ext) {
  const names = { detailed_audit: 'SEO-Audit', executive_summary: 'GM-Summary', plan_30_60_90: '30-60-90-Plan', tickets: 'Technical-Tickets', meeting_email: 'Meeting-Email' };
  const day = new Date(a.created_at || Date.now()).toISOString().slice(0, 10);
  const name = String(a.dealership_name || 'Dealership').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${name}_${names[kind] || kind}_${day}.${ext}`;
}

export const canStart = (a) => !!(a && a.authorized && a.status === 'draft');
