// A fake dealership website for testing the auditor. Every tricky case from the spec is here on purpose:
// delayed price rendering, conditional rebates, stale schema, duplicate URLs, call-tracking phone numbers and an
// HTTP 200 bot-challenge page, plus robots/sitemaps, redirects, a broken link, noindex, near-duplicate city pages and
// contradictory certification / rebate disclosures. EXPECTED.json lists what the audit should conclude for each.
//
// Run on its own:  node fixtures/dealer-site/server.mjs 4321
import http from 'node:http';
import { pathToFileURL } from 'node:url';

const DEALER = { name: 'Coastal Test Chevrolet', street: '100 Ocean Ave', city: 'New Smyrna Beach', region: 'FL', zip: '32168', phone: '(386) 555-0100' };
const DEALER_LD = {
  '@context': 'https://schema.org', '@type': 'AutoDealer', name: DEALER.name, telephone: DEALER.phone, url: '/',
  address: { '@type': 'PostalAddress', streetAddress: DEALER.street, addressLocality: DEALER.city, addressRegion: DEALER.region, postalCode: DEALER.zip, addressCountry: 'US' },
  openingHours: ['Mo-Fr 09:00-20:00', 'Sa 09:00-19:00'],
};

export const VEHICLES = {
  delayed: { path: '/inventory/new-2026-chevrolet-silverado-1500-lt-1gcuyded5tz100001/', vin: '1GCUYDED5TZ100001', stock: 'N1001', condition: 'new', year: 2026, make: 'Chevrolet', model: 'Silverado 1500', trim: 'LT', price: 52995, msrp: 56495 },
  conditional: { path: '/inventory/new-2026-chevrolet-equinox-lt-3gnaxuev1tl100002/', vin: '3GNAXUEV1TL100002', stock: 'N1002', condition: 'new', year: 2026, make: 'Chevrolet', model: 'Equinox', trim: 'LT', price: 32495, msrp: 33995 },
  stale: { path: '/inventory/used-2021-ford-f-150-xlt-1ftfw1e50mfa00003/', vin: '1FTFW1E50MFA00003', stock: 'U2003', condition: 'used', year: 2021, make: 'Ford', model: 'F-150', trim: 'XLT', price: 38900, schemaPrice: 41900 },
  duplicate: { path: '/inventory/used-2019-honda-civic-ex-2hgfc1f30kh000004/', alt: '/vdp?vin=2HGFC1F30KH000004', vin: '2HGFC1F30KH000004', stock: 'U2004', condition: 'used', year: 2019, make: 'Honda', model: 'Civic', trim: 'EX', price: 18995 },
  certified: { path: '/inventory/certified-2023-chevrolet-tahoe-lt-1gnskbkd0pr000005/', vin: '1GNSKBKD0PR000005', stock: 'C3005', condition: 'certified', year: 2023, make: 'Chevrolet', model: 'Tahoe', trim: 'LT', price: 58995 },
};

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => `$${Number(n).toLocaleString('en-US')}`;
const ld = (o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;
const nav = `<nav><a href="/">Home</a> <a href="/new-vehicles/">New</a> <a href="/used-vehicles/">Used</a> <a href="/certified-vehicles/">Certified</a>
  <a href="/specials/">Specials</a> <a href="/finance/">Finance</a> <a href="/service/">Service</a> <a href="/certified-program/">Why certified</a> <a href="/contact/">Contact</a> <a href="/old-page/">Old page</a></nav>`;
// Call tracking: the raw HTML has the real number; a script swaps in a tracking number after load (like CallRail/Invoca).
const callTracking = `<script src="/js/swap.js" data-provider="callrail-like"></script>`;
const footer = `<footer><p class="nap"><span class="name">${DEALER.name}</span>, ${DEALER.street}, ${DEALER.city}, ${DEALER.region} ${DEALER.zip} · <a class="phone" href="tel:3865550100">${DEALER.phone}</a></p>
  <p>Sales: Mon–Fri 9am–8pm, Sat 9am–7pm. Service: Mon–Fri 7am–6pm.</p></footer>${callTracking}`;
function page({ title, description, canonical, robots, body, head = '' }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>${description ? `<meta name="description" content="${esc(description)}">` : ''}
${canonical ? `<link rel="canonical" href="${esc(canonical)}">` : ''}${robots ? `<meta name="robots" content="${esc(robots)}">` : ''}${head}</head>
<body>${nav}<main>${body}</main>${footer}</body></html>`;
}

function carLd(v, { price = v.schemaPrice || v.price, availability = 'https://schema.org/InStock' } = {}) {
  return ld({ '@context': 'https://schema.org', '@type': 'Car', name: `${v.year} ${v.make} ${v.model} ${v.trim}`, vehicleIdentificationNumber: v.vin, sku: v.stock,
    itemCondition: v.condition === 'new' ? 'https://schema.org/NewCondition' : 'https://schema.org/UsedCondition', brand: { '@type': 'Brand', name: v.make }, model: v.model,
    vehicleModelDate: String(v.year), offers: { '@type': 'Offer', price, priceCurrency: 'USD', availability, seller: { '@type': 'AutoDealer', name: DEALER.name } } });
}
const vTitle = (v) => `${v.condition === 'new' ? 'New' : v.condition === 'certified' ? 'Certified Pre-Owned' : 'Used'} ${v.year} ${v.make} ${v.model} ${v.trim}`;
const specs = (v) => `<dl class="specs"><dt>VIN</dt><dd class="vin">${v.vin}</dd><dt>Stock #</dt><dd class="stock">${v.stock}</dd></dl>`;

function vdp(key, origin) {
  const v = VEHICLES[key];
  const canonical = `${origin}${v.path}`;
  const title = `${vTitle(v)} | ${DEALER.name}`;
  if (key === 'delayed') {
    // Price is empty in the HTML and filled in by script 2.5 s later; the schema has the right price.
    return page({ title, canonical, description: `${vTitle(v)} for sale in ${DEALER.city}.`, head: carLd(v),
      body: `<h1>${vTitle(v)}</h1>${specs(v)}<div class="pricing"><div class="msrp">MSRP <span>${money(v.msrp)}</span></div>
        <div class="price-final">Our price <span class="price" data-vin="${v.vin}"></span></div></div>
        <script>setTimeout(function(){document.querySelector('.price').textContent='${money(v.price)}'},2500)</script>` });
  }
  if (key === 'conditional') {
    // Legitimate conditional pricing: the selling price matches the schema; extra offers carry conditions.
    return page({ title, canonical, description: `${vTitle(v)} for sale in ${DEALER.city}.`, head: carLd(v),
      body: `<h1>${vTitle(v)}</h1>${specs(v)}<div class="pricing"><div class="msrp">MSRP <span>${money(v.msrp)}</span></div>
        <div class="discount">Dealer discount <span>-$1,500</span></div>
        <div class="price-final">Selling price <span class="price">${money(v.price)}</span></div>
        <div class="incentive conditional">GM Financial bonus cash <span>-$1,000</span> <small>Must finance with GM Financial. Subject to credit approval.</small></div>
        <div class="incentive conditional">Conquest cash <span>-$500</span> <small>Must currently lease a non-GM vehicle.</small></div>
        <div class="price-conditional">Price with all offers <span>$30,995</span></div>
        <p class="fees">Plus tax, tag, title and a $999 dealer fee.</p></div>` });
  }
  if (key === 'stale') {
    // Stale schema: the page says it's sold at a reduced price; the schema still says in stock at the old price.
    return page({ title, canonical, description: `${vTitle(v)} for sale.`, head: carLd(v),
      body: `<h1>${vTitle(v)}</h1><div class="status sold">SOLD</div>${specs(v)}<div class="pricing"><div class="price-final">Price <span class="price">${money(v.price)}</span></div></div>` });
  }
  if (key === 'duplicate') {
    return page({ title, canonical, description: `${vTitle(v)} for sale in ${DEALER.city}.`, head: carLd(v),
      body: `<h1>${vTitle(v)}</h1>${specs(v)}<div class="pricing"><div class="price-final">Price <span class="price">${money(v.price)}</span></div></div>` });
  }
  if (key === 'certified') {
    // Contradictory disclosure: this page says 150-point inspection; the certified-program page says 172-point.
    return page({ title, canonical, description: `${vTitle(v)} for sale in ${DEALER.city}.`, head: carLd(v),
      body: `<h1>${vTitle(v)}</h1>${specs(v)}<div class="pricing"><div class="price-final">Price <span class="price">${money(v.price)}</span></div></div>
        <section class="certified"><h2>Chevrolet Certified</h2><p>150-point vehicle inspection and reconditioning.</p>
        <p class="warranty">6-Year/100,000-Mile Powertrain Limited Warranty and 12-Month/12,000-Mile Bumper-to-Bumper Limited Warranty.</p></section>` });
  }
  return null;
}

function srp(kind, origin) {
  const list = Object.values(VEHICLES).filter((v) => v.condition === kind);
  const label = { new: 'New', used: 'Used', certified: 'Certified Pre-Owned' }[kind];
  return page({ title: `${label} Vehicles for Sale | ${DEALER.name}`, canonical: `${origin}/${kind}-vehicles/`, description: `Browse ${label.toLowerCase()} inventory at ${DEALER.name}.`,
    body: `<h1>${label} Vehicles</h1><ul class="srp">${list.map((v) => `<li class="vehicle-card" data-vin="${v.vin}"><a href="${v.path}">${vTitle(v)}</a>
      <span class="price">${money(v.price)}</span></li>`).join('')}</ul>` });
}

const CITIES = ['new-smyrna-beach', 'daytona-beach', 'deland', 'port-orange', 'edgewater'];
const cityName = (c) => c.split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
function cityPage(c, origin) {
  // Interchangeable city pages: same text with the city name swapped.
  return page({ title: `Chevrolet Dealer near ${cityName(c)}, FL | ${DEALER.name}`, canonical: `${origin}/${c}-chevrolet-dealer/`,
    description: `Looking for a Chevrolet dealer near ${cityName(c)}? Visit ${DEALER.name}.`,
    body: `<h1>Chevrolet Dealer near ${cityName(c)}, FL</h1><p>Drivers from ${cityName(c)} choose ${DEALER.name} for new and used Chevrolet vehicles, financing and service.
      Our friendly team is ready to help ${cityName(c)} shoppers find the right car. Visit us today!</p>` });
}

const CHALLENGE = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title><meta http-equiv="refresh" content="390">
<meta name="robots" content="noindex,nofollow"><style>body{font-family:system-ui}</style></head><body><div class="main-wrapper" role="main">
<div class="main-content"><h1 class="zone-name-title h1">www.coastaltestchevy.com</h1><h2 id="challenge-running">Checking if the site connection is secure</h2>
<noscript><div id="challenge-error-title">Enable JavaScript and cookies to continue</div></noscript></div></div>
<script>(function(){window._cf_chl_opt={cvId:'3',cZone:'www.coastaltestchevy.com',cType:'managed'};})();</script></body></html>`;

export function handler(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const origin = `http://${req.headers.host}`;
  const p = url.pathname;
  const send = (status, body, type = 'text/html; charset=utf-8', headers = {}) => { res.writeHead(status, { 'content-type': type, ...headers }); res.end(body); };
  const ua = String(req.headers['user-agent'] || '');

  if (p === '/robots.txt') return send(200, `User-agent: *\nDisallow: /search\nDisallow: /cart\n\nUser-agent: AIAEAuditBot\nDisallow: /private-tools/\n\nSitemap: ${origin}/sitemap_index.xml\n`, 'text/plain');
  if (p === '/sitemap_index.xml') return send(200, `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap><loc>${origin}/sitemap-pages.xml</loc></sitemap><sitemap><loc>${origin}/sitemap-inventory.xml</loc></sitemap><sitemap><loc>${origin}/sitemap-missing.xml</loc></sitemap></sitemapindex>`, 'application/xml');
  if (p === '/sitemap-pages.xml') return send(200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    ['/', '/new-vehicles/', '/used-vehicles/', '/certified-vehicles/', '/specials/', '/finance/', '/service/', '/certified-program/', '/contact/', '/thank-you/', ...CITIES.map((c) => `/${c}-chevrolet-dealer/`)]
      .map((u) => `<url><loc>${origin}${u}</loc></url>`).join('')}</urlset>`, 'application/xml');
  if (p === '/sitemap-inventory.xml') return send(200, `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${
    Object.values(VEHICLES).map((v) => `<url><loc>${origin}${v.path}</loc></url>`).join('')}<url><loc>${origin}/inventory/used-2018-gone-xxxxx/</loc></url></urlset>`, 'application/xml');
  if (p === '/js/swap.js') return send(200, `document.querySelectorAll('.phone').forEach(function(a){a.textContent='(386) 555-0199';a.href='tel:3865550199';});`, 'text/javascript');

  if (p === '/') return send(200, page({ title: `${DEALER.name} | New & Used Chevrolet in ${DEALER.city}, FL`, canonical: `${origin}/`, description: `${DEALER.name} in ${DEALER.city}, FL.`, head: ld(DEALER_LD),
    body: `<h1>${DEALER.name}</h1><p>New and used Chevrolet cars, trucks and SUVs in ${DEALER.city}.</p>
      <a href="/new-vehicles/">Shop new</a> <a href="/used-vehicles/">Shop used</a> <a href="/promo">This month's promo</a> <a href="/http-old">Old link</a>
      <p>${CITIES.map((c) => `<a href="/${c}-chevrolet-dealer/">${cityName(c)}</a>`).join(' · ')}</p>` }));
  if (p === '/new-vehicles/') return send(200, srp('new', origin));
  if (p === '/used-vehicles/') return send(200, srp('used', origin));
  if (p === '/certified-vehicles/') return send(200, srp('certified', origin));
  for (const [key, v] of Object.entries(VEHICLES)) if (p === v.path) return send(200, vdp(key, origin));
  if (p === '/vdp' && url.searchParams.get('vin') === VEHICLES.duplicate.vin) {
    // Same vehicle at a second URL with no canonical.
    const html = vdp('duplicate', origin).replace(/<link rel="canonical"[^>]*>/, '');
    return send(200, html);
  }
  if (p === '/specials/') return send(200, page({ title: `Specials | ${DEALER.name}`, canonical: `${origin}/specials/`, description: 'Current Chevrolet offers.',
    body: `<h1>Specials</h1><div class="offer">2026 Equinox: <b>$2,000 GM Financial bonus cash</b> when you finance with GM Financial.</div>` }));
  if (p === '/finance/') return send(200, page({ title: `Car Financing | ${DEALER.name}`, canonical: `${origin}/finance/`, description: 'Apply for financing.',
    body: '<h1>Financing</h1><p>Apply online.</p><form><input name="name"></form>' }));
  if (p === '/service/') return send(200, page({ title: `Chevrolet Service | ${DEALER.name}`, canonical: `${origin}/service/`, description: 'Book service.',
    body: '<h1>Service Center</h1><p>Service hours: Mon–Fri 7am–6pm.</p>' }));
  if (p === '/certified-program/') return send(200, page({ title: `Chevrolet Certified Pre-Owned | ${DEALER.name}`, canonical: `${origin}/certified-program/`, description: 'Why buy certified.',
    body: '<h1>Chevrolet Certified Pre-Owned</h1><p>Every certified vehicle passes a 172-point inspection.</p>' }));
  if (p === '/contact/') return send(200, page({ title: `Contact | ${DEALER.name}`, canonical: `${origin}/contact/`, description: 'Hours and directions.',
    body: `<h1>Contact us</h1><p>${DEALER.street}, ${DEALER.city}, ${DEALER.region} ${DEALER.zip}</p>` }));
  if (p === '/thank-you/') return send(200, page({ title: 'Thank you', robots: 'noindex, follow', body: '<h1>Thanks!</h1>' }));
  for (const c of CITIES) if (p === `/${c}-chevrolet-dealer/`) return send(200, cityPage(c, origin));

  if (p === '/promo') return send(301, '', 'text/plain', { location: '/specials/' });
  if (p === '/http-old') return send(302, '', 'text/plain', { location: '/http-old-2' });
  if (p === '/http-old-2') return send(301, '', 'text/plain', { location: '/specials/' });
  if (p === '/challenge-test/') return send(200, CHALLENGE, 'text/html; charset=UTF-8', { 'cf-mitigated': 'challenge', server: 'cloudflare' });
  if (p === '/inventory/used-blocked/') return send(403, '<html><head><title>Access Denied</title></head><body><h1>Access Denied</h1>You don\'t have permission to access this server.<p>Reference #18.abc</p></body></html>', 'text/html', { server: 'AkamaiGHost' });
  if (p === '/slow-down/') return send(429, 'Too Many Requests', 'text/plain', { 'retry-after': '30' });
  if (p === '/whoami') return send(200, JSON.stringify({ ua }), 'application/json');
  return send(404, page({ title: 'Page not found', body: '<h1>Page not found</h1>' }));
}

export function startFixture(port = 0) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(port, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  startFixture(Number(process.argv[2]) || 4321).then(({ origin }) => console.log(`Fixture dealer site at ${origin}`));
}
