# SEO Audits · AI Authority Engine

SEO and AI-search audits for car dealerships, at **seo.aiautoengine.com**. Team only for now.

The audit collects evidence first and writes conclusions second. Every finding is tied to a URL, a timestamp and a piece of evidence (HTML or structured-data excerpt, header, or screenshot). Deterministic rules decide what's a finding; Claude only explains verified evidence; a team member approves each finding before anything goes into a report.

## Status

| Stage | What | State |
|---|---|---|
| 1 | Foundation: app, sign-in, database, fake dealer site, tests | **built** |
| 2 | Crawler: preflight, sampling, raw + rendered fetch, challenge detection, evidence | **built** |
| 3 | Checks: technical, inventory and pricing, local | **built** |
| 4 | Content, mobile experience, page speed, AI readiness, AI Visibility Snapshot upload | |
| 5 | Claude write-ups and the review screen | |
| 6 | Reports: detailed audit, GM summary, 30/60/90 plan, provider tickets, meeting email | |
| 7 | Search Console and GA4 connections | |

## What Google currently says (and the audit follows)

- **AI Overviews / AI Mode:** no special requirements or markup. Pages must be indexed and eligible for a snippet; allow crawling (robots.txt, CDN, hosting), keep important content in text, keep structured data consistent with visible text, keep Business Profile and Merchant Center current. AI-feature traffic is counted in Search Console's Performance report under "Web". <https://developers.google.com/search/docs/appearance/ai-features> (updated Dec 10, 2025). So the audit never recommends "AI schema" or AI text files, and never claims schema guarantees citations.
- **Vehicle listing rich results are retired** (documentation removed Sept 9, 2025). The audit doesn't recommend vehicle markup *for rich results*; it still checks that any markup on vehicle pages matches the visible price, VIN and availability.

## Sign-in and access

Same Supabase project and logins as Vehicle Portfolios. "Team" = anyone in `public.platform_admins` (the Vehicle Portfolios platform operators), checked by `seo_is_team()` in every row-level-security policy. Everyone else who signs in sees "Team only"; anonymous visitors can't read any `seo_` table.

## Data model (`supabase/migrations/0001_seo_foundation.sql`)

- `seo_audits`: dealership, site, address, competitors, page budget and sample plan, authorization (who, when, how; stamped by the database, required before an audit can leave draft), status, stage log.
- `seo_pages`, `seo_links`, `seo_structured_data`, `seo_vehicles_observed`: what the crawler saw, raw and rendered.
- `seo_evidence`: excerpts, headers, screenshots, with time and fingerprint.
- `seo_findings`: category, status (confirmed issue / opportunity / needs verification), priority, affected URLs, observation time, evidence, significance, fix, responsible party, acceptance criteria, the rule's facts, review status. **Can't be approved without evidence and every required field.**
- `seo_uploads` (AI Visibility Snapshots, kept as data with their own methodology), `seo_reports`.
- Private storage bucket `seo`, files under `<dealership>/<YYYY-MM-DD>/<audit id>/`. Each audit page shows its folder; reports download from there.

## The fake dealer site (`fixtures/dealer-site/`)

`node fixtures/dealer-site/server.mjs 4321` serves a dealership website with every hard case in the spec: a price that appears 2.5 s after load, conditional rebates that are *not* inconsistencies, stale schema on a sold car, the same car at two URLs without a canonical, a call-tracking script that swaps the phone number, a bot-challenge page that answers **200 OK** (and a 403 one), redirect chains, a broken link, a noindex page in the sitemap, a missing child sitemap, interchangeable city pages, and contradictory certification and rebate disclosures. `EXPECTED.json` says what a correct audit concludes for each; later stages are tested against it.

## The crawler (Stage 2): `crawler/` + `worker/`

A Cloudflare Worker (`worker/`) checks every minute for queued, authorized audits and runs each as a durable **Cloudflare Workflow**: every step is retried on failure and the run survives restarts. The steps (`crawler/pipeline.js`):

1. **Preflight:** robots.txt (stored as evidence), every sitemap it lists (or `/sitemap.xml` and `/sitemap_index.xml`), following sitemap indexes up to 30 files / 20,000 URLs (full list stored as `sitemap-urls.json`), the homepage, and the website platform (Dealer Inspire, Dealer.com, DealerOn…, for reference only).
2. **Discover:** the new, used and certified inventory list pages are read for vehicle links.
3. **Sample** (`crawler/sample.js`): home, each inventory list, vehicle pages per the audit's plan (new / used / certified), specials, finance, service, CPO program, model, contact, city pages (capped), about, a few others; deterministic per audit. Anything robots.txt disallows for our bot is skipped and listed as evidence.
4. **Each page, three at a time per step:** the raw HTML (headers and full redirect chain), then **the rendered page** on a phone-sized browser (Cloudflare Browser Run) with a timing script that records when each price first appears; a screenshot for the first page of each type; facts from both versions (`crawler/extract.js`: title, description, robots, canonical, H1, words, links, JSON-LD, phone numbers and call-tracking scripts, and on vehicle pages VIN, stock, condition, visible price, MSRP, discounts with conditional offers marked as such, fees text, schema price and availability, sold/in-transit wording, certification and warranty text); what changed between raw and rendered (`crawler/diff.js`); and evidence rows (headers, title and canonical tags, the vehicle's JSON-LD, the price in context, the challenge page, screenshot). Files go to `seo/<dealership>/<date>/<audit>/pages/`.
5. **Links:** up to 150 internal links and 40 sitemap URLs not already sampled get a status check (HEAD, then GET if refused).

Then the audit moves to **Checking** for Stage 3.

**Challenges** (`crawler/challenge.js`): Cloudflare, Akamai, Imperva, PerimeterX/HUMAN, DataDome, Sucuri and CAPTCHA walls, including ones that answer **200 OK** ("Just a moment…", `cf-mitigated: challenge`, near-empty pages with a "checking your browser" notice). A challenged page is never read as content (no title, no facts), the challenge itself is saved as evidence, and the page shows "our crawler was challenged; check Google's view in Search Console". A reCAPTCHA on an ordinary contact form isn't a challenge.

## The checks (Stage 3): `crawler/checks.js`, `crawler/run-checks.js`

Deterministic rules run on the stored crawl evidence right after the crawl (and, for audits crawled earlier, the worker's cron starts them). Each finding has a status (confirmed / opportunity / needs verification), priority, affected URLs, observation time, cited evidence, why it matters, the fix, who fixes it and acceptance criteria. No model is involved; Stage 5 rewrites the prose and can't add findings. Re-running replaces draft findings and keeps reviewed ones. The audit then shows **Ready for review**, and each finding can be opened (evidence included), approved, rejected or undone; only approved findings go into reports.

| Area | Rules |
|---|---|
| Technical | challenged pages (needs verification, never "Google is blocked"), robots.txt blocking key pages for Googlebot, unreachable sitemaps, sitemap URLs that don't load, noindex pages in the sitemap, broken internal links, redirect chains, the same vehicle at several URLs without one canonical, canonical changing after JavaScript, missing/duplicate titles, missing descriptions, broken JSON-LD, text that only appears after JavaScript |
| Inventory | visible price ≠ structured-data price (conditional offers excluded), sold car with in-stock schema, no visible price, price that loads late (opportunity), no vehicle offer in structured data (opportunity; rich results retired), certification claims that disagree between pages, the same incentive at different amounts on the specials page and a vehicle page, dealer fees listed outside the price (needs verification: a compliance question) |
| Local | no dealer identity in structured data, structured-data phone not on the page (call tracking excluded), interchangeable city pages (improve or consolidate; never "create more"), hours not found as text, Google Business Profile (always "needs access", kept separate) |

`fixtures/dealer-site/EXPECTED.json` is the test: a full crawl of the fake dealer site must produce every expected finding, with the expected status, and nothing where the answer is "none".

## The crawler's manners

User agent `AIAEAuditBot/1.0 (+https://seo.aiautoengine.com/bot.html)`; follows robots.txt for `AIAEAuditBot` and `*`; one request every 2 s per site, two at a time; honours `Retry-After`; stops on repeated 429s or challenges; public addresses on the dealer's own domain only; never tries to get past a challenge. A challenged page makes the dependent findings **needs verification**, with Search Console URL Inspection or verified server logs as the way to check; it is never reported as "Google is blocked".

## Deploy

1. **Supabase** (the Vehicle Portfolios project): SQL Editor → paste `supabase/setup-all.sql` → Run. Safe to run twice.
2. **Cloudflare Pages:** Workers & Pages → Create → Pages → connect `AIAEJoe/seo-audits`. Build command: none. Output directory: `public`.
3. **Variables** (Settings → Variables and Secrets): `SUPABASE_URL` and `SUPABASE_ANON_KEY` (same values as Vehicle Portfolios).
4. **Custom domain:** the project's Custom domains → add `seo.aiautoengine.com`.
5. **Supabase → Authentication → URL Configuration:** add `https://seo.aiautoengine.com/**` to the redirect URLs.
6. Team members: `select public.vp_add_platform_admin('person@example.com');` in the SQL editor (they need a login first).

### The crawler worker (Stage 2)
1. Cloudflare **Workers Paid** plan ($5/month): Workflows and Browser Run need it.
2. **Browser Run token:** My Profile → API Tokens → Create Token → Custom token → Permissions: *Account · Browser Run · Edit* → your account → Create. Copy it once.
3. **Create the worker from GitHub:** Workers & Pages → Create → *Import a repository* → `AIAEJoe/seo-audits` → **Root directory `worker`** → Deploy. It deploys on every push to `main`.
4. On the worker → Settings → Variables and Secrets, add **secrets**: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Supabase → Project Settings → API; server-side only, never in the Pages project or the browser), `CLOUDFLARE_ACCOUNT_ID` (Workers & Pages overview, right side), `BROWSER_RUN_TOKEN`.
5. Open `https://seo-audits-worker.<your-subdomain>.workers.dev/health`: every item under `configured` should be `true`.
6. Queue an audit; it starts within a minute. A 100-page sample takes roughly 20–40 minutes at one request every 2 seconds plus rendering.

## Tests

```
node --test tests/unit/*.test.js   # URL rules, robots, sitemaps, challenges, extraction, pacing, adapters, the worker,
                                   # and a full crawl of the fake dealer site with a real local browser
bash tests/sql/run.sh              # database rules on a throwaway Postgres (migrations applied twice)
node tests/e2e/run.mjs             # browser tests with an in-memory Supabase
```
