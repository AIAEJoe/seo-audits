// Browser tests for the SEO Audits app (Playwright + an in-memory Supabase stub). Run: node tests/e2e/run.mjs
import { createRequire } from 'node:module';
import { readFileSync, readdirSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const PUB = join(ROOT, 'public');
const SHOTS = join(ROOT, 'tests/e2e/screenshots');
mkdirSync(SHOTS, { recursive: true });
const ORIGIN = 'https://seo.aiautoengine.com';

// ---- schema from the real migrations ----
const sql = readdirSync(join(ROOT, 'supabase/migrations')).sort().map((f) => readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8')).join('\n');
const SCHEMA = {};
for (const m of sql.matchAll(/create table if not exists public\.(\w+) \(([\s\S]*?)\n\);/g)) {
  SCHEMA[m[1]] = m[2].split('\n').map((l) => l.trim().match(/^([a-z_0-9]+)\s+(?!key\b)/)).filter(Boolean).map((x) => x[1])
    .filter((c) => !['unique', 'primary', 'check', 'constraint'].includes(c));
}
// "year int, make text, model text, trim text" style lines
SCHEMA.seo_vehicles_observed.push('make', 'model', 'trim');

const TEAM = 'aaaaaaaa-0000-4000-8000-000000000001';
const OUTSIDER = 'aaaaaaaa-0000-4000-8000-000000000002';
const SEED = {
  users: [{ id: TEAM, email: 'joe@aiautoengine.test', password: 'team-pass' }, { id: OUTSIDER, email: 'sales@dealer.test', password: 'sales-pass' }],
  platform_admins: [{ user_id: TEAM }],
  ...Object.fromEntries(Object.keys(SCHEMA).filter((t) => t.startsWith('seo_')).map((t) => [t, []])),
};

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.txt': 'text/plain' };
const indexHtml = readFileSync(join(PUB, 'index.html'), 'utf8').replace('</head>', '<script>window.SEO_CONFIG={"supabaseUrl":"https://proj.supabase.co","supabaseAnonKey":"anon"}</script></head>');
const stub = readFileSync(join(ROOT, 'tests/e2e/supabase-stub.js'), 'utf8');

async function setup(context) {
  await context.addInitScript(({ seed, schema }) => {
    window.__SCHEMA = schema; window.__STUB_ERRORS = [];
    const saved = localStorage.getItem('stub-db');
    window.__DB = saved ? JSON.parse(saved) : JSON.parse(JSON.stringify(seed));
  }, { seed: SEED, schema: SCHEMA });
  await context.route('https://cdn.jsdelivr.net/npm/@supabase/**', (r) => r.fulfill({ contentType: 'text/javascript', body: stub }));
  await context.route(`${ORIGIN}/**`, async (route) => {
    const p = new URL(route.request().url()).pathname;
    const file = join(PUB, p);
    if (p !== '/' && existsSync(file) && !p.endsWith('/')) return route.fulfill({ contentType: TYPES[extname(p)] || 'application/octet-stream', body: readFileSync(file) });
    if (p.startsWith('/api/')) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"error":"not mocked"}' });
    return route.fulfill({ contentType: 'text/html', body: indexHtml });
  });
}

let failures = 0;
const assert = (c, m) => { if (!c) throw new Error('Assertion failed: ' + m); };
async function step(name, fn) {
  try { await fn(); console.log('  ok -', name); } catch (e) { failures++; console.log('  FAIL -', name, '\n     ', e.message.split('\n')[0]); }
}

const browser = await chromium.launch();
const errors = [];
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
await setup(context);
const page = await context.newPage();
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
page.on('dialog', (d) => d.accept());
const db = () => page.evaluate(() => window.__DB);

console.log('SEO Audits');
await step('signed-out visitors go to sign-in; someone not on the team is turned away', async () => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForURL('**/login?next=%2F');
  await page.fill('#email', 'sales@dealer.test'); await page.fill('#password', 'nope');
  await page.click('#pw button');
  await page.waitForSelector('text=That email and password don\'t match.');
  await page.fill('#password', 'sales-pass');
  await page.click('#pw button');
  await page.waitForSelector('text=Team only');
  await page.click('#so');
  await page.waitForSelector('#pw');
});
await step('team member signs in and sees the empty audit list', async () => {
  await page.fill('#email', 'joe@aiautoengine.test'); await page.fill('#password', 'team-pass');
  await page.click('#pw button');
  await page.waitForSelector('text=No audits yet');
  await page.screenshot({ path: join(SHOTS, '01-audits-empty.png') });
});
await step('new audit: URL checks, authorization required before queueing', async () => {
  await page.click('text=Set up the first audit');
  await page.waitForSelector('#f');
  await page.fill('#name', 'New Smyrna Beach Chevrolet');
  await page.fill('#url', 'http://192.168.1.10');
  await page.click('button[value=queue]');
  await page.waitForSelector('#err >> text=public website address');
  await page.fill('#url', 'www.NewSmyrnaChevy.com/inventory/used');
  await page.click('button[value=queue]');
  await page.waitForSelector('#err >> text=Confirm the audit is authorized');
  await page.check('#auth');
  await page.click('button[value=queue]');
  await page.waitForSelector('#err >> text=Say how the audit was authorized');
  await page.fill('#note', 'GM approved by email, Oct 30 2026');
  await page.fill('#addr', '2375 State Road 44, New Smyrna Beach, FL 32168');
  await page.fill('#comp', 'DeLand Chevrolet https://www.delandchevy.com');
  await page.screenshot({ path: join(SHOTS, '02-new-audit.png'), fullPage: true });
  await page.click('button[value=queue]');
  await page.waitForSelector('.pill.big >> text=Queued');
  const a = (await db()).seo_audits[0];
  assert(a.site_url === 'https://www.newsmyrnachevy.com/' && a.status === 'queued' && a.authorized && a.authorized_by === TEAM && a.authorized_at, JSON.stringify(a));
  assert(a.competitors[0].url === 'https://www.delandchevy.com/' && a.sample_plan.used === 10, 'competitors and sample');
  const t = await page.textContent('main');
  assert(t.includes('GM approved by email') && t.includes('crawler is built in the next stage'), 'authorization and pipeline note shown');
  const folder = await page.inputValue('input[aria-label="Storage folder"]');
  assert(/^seo\/new-smyrna-beach-chevrolet\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\/$/.test(folder), folder);
  await page.screenshot({ path: join(SHOTS, '03-audit.png'), fullPage: true });
});
await step('a draft can be authorized later, then queued', async () => {
  await page.goto(`${ORIGIN}/audits/new`);
  await page.fill('#name', 'Test Draft Dealer'); await page.fill('#url', 'https://draft-dealer.example.com');
  await page.click('button[value=draft]');
  await page.waitForSelector('.pill.big >> text=Draft');
  assert(!(await page.$('#queue')), 'no queue button before authorization');
  await page.fill('#authf input', 'Owner approved on a call, Oct 30');
  await page.click('#authf button');
  await page.waitForSelector('#toast >> text=Authorization recorded');
  await page.click('#queue');
  await page.waitForSelector('.pill.big >> text=Queued');
});
await step('list shows both; cancel and delete work', async () => {
  await page.goto(`${ORIGIN}/`);
  await page.waitForSelector('.row');
  assert((await page.$$('.row')).length === 2, 'two audits');
  await page.click('.row:has-text("Test Draft Dealer")');
  await page.click('#cancel');
  await page.waitForSelector('.pill.big >> text=Cancelled');
  await page.click('#del');
  await page.waitForURL(`${ORIGIN}/`);
  await page.waitForSelector('.row');
  assert((await page.$$('.row')).length === 1, 'deleted');
});
await step('no console errors or stub schema errors', async () => {
  const stubErrors = await page.evaluate(() => window.__STUB_ERRORS);
  assert(!errors.length && !stubErrors.length, [...errors, ...stubErrors].join('; '));
});

await browser.close();
console.log(failures ? `${failures} FAILED` : 'ALL BROWSER TESTS PASSED');
process.exit(failures ? 1 : 0);
