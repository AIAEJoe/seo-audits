# SEO Audits · AI Authority Engine

SEO and AI-search audits for car dealerships, at **seo.aiautoengine.com**. Team only for now.

The audit collects evidence first and writes conclusions second. Every finding is tied to a URL, a timestamp and a piece of evidence (HTML or structured-data excerpt, header, or screenshot). Deterministic rules decide what's a finding; Claude only explains verified evidence; a team member approves each finding before anything goes into a report.

## Status

| Stage | What | State |
|---|---|---|
| 1 | Foundation: app, sign-in, database, fake dealer site, tests | **built** |
| 2 | Crawler: preflight, sampling, raw + rendered fetch, challenge detection, evidence | next |
| 3 | Checks: technical, inventory and pricing, local | |
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

## The crawler's manners (Stage 2)

User agent `AIAEAuditBot/1.0 (+https://seo.aiautoengine.com/bot.html)`; follows robots.txt for `AIAEAuditBot` and `*`; one request every 2 s per site, two at a time; honours `Retry-After`; stops on repeated 429s or challenges; public addresses on the dealer's own domain only; never tries to get past a challenge. A challenged page makes the dependent findings **needs verification**, with Search Console URL Inspection or verified server logs as the way to check; it is never reported as "Google is blocked".

## Deploy

1. **Supabase** (the Vehicle Portfolios project): SQL Editor → paste `supabase/setup-all.sql` → Run. Safe to run twice.
2. **Cloudflare Pages:** Workers & Pages → Create → Pages → connect `AIAEJoe/seo-audits`. Build command: none. Output directory: `public`.
3. **Variables** (Settings → Variables and Secrets): `SUPABASE_URL` and `SUPABASE_ANON_KEY` (same values as Vehicle Portfolios).
4. **Custom domain:** the project's Custom domains → add `seo.aiautoengine.com`.
5. **Supabase → Authentication → URL Configuration:** add `https://seo.aiautoengine.com/**` to the redirect URLs.
6. Team members: `select public.vp_add_platform_admin('person@example.com');` in the SQL editor (they need a login first).

## Tests

```
node --test tests/unit/*.test.js   # URL rules, file naming, and the fake dealer site
bash tests/sql/run.sh              # database rules on a throwaway Postgres (migrations applied twice)
node tests/e2e/run.mjs             # browser tests with an in-memory Supabase
```
