-- SEO Audits: complete database setup. Paste all of this into Supabase → SQL Editor → Run (same project as Vehicle Portfolios).

-- AI Authority Engine SEO Audits: foundation. Safe to run more than once.
--
-- Lives in the same Supabase project as Vehicle Portfolios (same logins), in tables prefixed seo_. Team only for now:
-- a "team member" is anyone in public.platform_admins (the Vehicle Portfolios platform operators).
--
-- Evidence rules this schema enforces:
--   * every finding has a status (confirmed issue / opportunity / needs verification), priority, responsible party,
--     fix and acceptance criteria, and must cite at least one piece of evidence before it can be approved;
--   * crawled content and uploads are stored as data (text/jsonb), never interpreted;
--   * an audit can't start until someone records that we're authorized to audit the site.

create extension if not exists pgcrypto;

-- Vehicle Portfolios already has this table; created here only so a fresh database works too.
create table if not exists public.platform_admins (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
alter table public.platform_admins enable row level security;

create or replace function public.seo_is_team() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.platform_admins where user_id = auth.uid())
$$;

-- ---------------------------------------------------------------- audits
create table if not exists public.seo_audits (
  id                 uuid primary key default gen_random_uuid(),
  dealership_name    text not null check (length(btrim(dealership_name)) between 1 and 120),
  site_url           text not null check (site_url ~* '^https?://[a-z0-9.-]+\.[a-z]{2,}(:[0-9]+)?(/.*)?$'),
  host               text generated always as (lower(split_part(split_part(regexp_replace(site_url, '^https?://', '', 'i'), '/', 1), ':', 1))) stored,
  address            text,
  competitors        jsonb not null default '[]'::jsonb check (jsonb_typeof(competitors) = 'array'),
  page_budget        int not null default 100 check (page_budget between 10 and 500),
  sample_plan        jsonb not null default '{"new":10,"used":10,"certified":5,"city":10}'::jsonb,
  authorized         boolean not null default false,
  authorization_note text check (authorization_note is null or length(authorization_note) <= 1000),
  authorized_by      uuid,
  authorized_at      timestamptz,
  status             text not null default 'draft'
                     check (status in ('draft', 'queued', 'crawling', 'checking', 'drafting', 'review', 'complete', 'failed', 'cancelled')),
  stage_log          jsonb not null default '[]'::jsonb,
  error              text,
  created_by         uuid default auth.uid(),
  created_at         timestamptz not null default now(),
  started_at         timestamptz,
  finished_at        timestamptz,
  check (status = 'draft' or status = 'cancelled' or (authorized and authorized_by is not null and authorized_at is not null))
);
create index if not exists seo_audits_created on public.seo_audits (created_at desc);

-- Authorization can only be recorded as "this user, now".
create or replace function public.seo_audit_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.authorized and (tg_op = 'INSERT' or not old.authorized) then
    new.authorized_by := auth.uid();
    new.authorized_at := now();
  elsif not new.authorized then
    new.authorized_by := null; new.authorized_at := null;
  elsif tg_op = 'UPDATE' then
    new.authorized_by := old.authorized_by; new.authorized_at := old.authorized_at;
  end if;
  return new;
end $$;
drop trigger if exists seo_audit_stamp on public.seo_audits;
create trigger seo_audit_stamp before insert or update on public.seo_audits for each row execute function public.seo_audit_stamp();

-- ---------------------------------------------------------------- crawl results
create table if not exists public.seo_pages (
  id                uuid primary key default gen_random_uuid(),
  audit_id          uuid not null references public.seo_audits(id) on delete cascade,
  url               text not null,
  final_url         text,
  page_type         text not null default 'other' check (page_type in ('home', 'srp_new', 'srp_used', 'srp_certified', 'vdp_new', 'vdp_used',
                      'vdp_certified', 'model', 'finance', 'service', 'specials', 'certified_info', 'contact', 'city', 'about', 'other')),
  discovered_via    text check (discovered_via in ('start', 'sitemap', 'nav', 'link', 'inventory')),
  status_code       int,
  redirect_chain    jsonb not null default '[]'::jsonb,
  headers           jsonb not null default '{}'::jsonb,
  robots_txt_allows jsonb not null default '{}'::jsonb,
  meta_robots       text,
  x_robots_tag      text,
  canonical_raw     text,
  canonical_rendered text,
  title             text,
  meta_description  text,
  h1                jsonb not null default '[]'::jsonb,
  word_count        int,
  challenge         jsonb,
  render_diff       jsonb,
  raw_html_path     text,
  rendered_html_path text,
  screenshot_path   text,
  fetched_at        timestamptz,
  rendered_at       timestamptz,
  created_at        timestamptz not null default now(),
  unique (audit_id, url)
);
create index if not exists seo_pages_audit on public.seo_pages (audit_id, page_type);

create table if not exists public.seo_links (
  id          bigint generated always as identity primary key,
  audit_id    uuid not null references public.seo_audits(id) on delete cascade,
  from_page   uuid references public.seo_pages(id) on delete cascade,
  to_url      text not null,
  anchor      text,
  rel         text,
  internal    boolean not null default true,
  status_code int,
  checked_at  timestamptz
);
create index if not exists seo_links_audit on public.seo_links (audit_id, to_url);

create table if not exists public.seo_structured_data (
  id          bigint generated always as identity primary key,
  audit_id    uuid not null references public.seo_audits(id) on delete cascade,
  page_id     uuid not null references public.seo_pages(id) on delete cascade,
  source      text not null check (source in ('raw', 'rendered')),
  format      text not null check (format in ('json-ld', 'microdata', 'rdfa')),
  types       text[] not null default '{}',
  data        jsonb,
  excerpt     text,
  parse_error text
);

create table if not exists public.seo_vehicles_observed (
  id                  bigint generated always as identity primary key,
  audit_id            uuid not null references public.seo_audits(id) on delete cascade,
  page_id             uuid not null references public.seo_pages(id) on delete cascade,
  vin                 text,
  stock_number        text,
  condition           text check (condition in ('new', 'used', 'certified', 'unknown')),
  year int, make text, model text, trim text,
  visible_price       numeric,
  visible_price_label text,
  msrp                numeric,
  discounts           jsonb not null default '[]'::jsonb,   -- [{label, amount, conditional, condition_text}]
  fees_text           text,
  schema_price        numeric,
  schema_currency     text,
  schema_availability text,
  page_availability   text,
  certification_text  text,
  warranty_text       text,
  price_seen_after_ms int,
  observed_at         timestamptz not null default now()
);
create index if not exists seo_vehicles_vin on public.seo_vehicles_observed (audit_id, vin);

create table if not exists public.seo_evidence (
  id          uuid primary key default gen_random_uuid(),
  audit_id    uuid not null references public.seo_audits(id) on delete cascade,
  page_id     uuid references public.seo_pages(id) on delete cascade,
  kind        text not null check (kind in ('html_excerpt', 'schema_excerpt', 'screenshot', 'header', 'robots', 'sitemap', 'measurement', 'upload_excerpt', 'note')),
  url         text,
  content     text check (content is null or length(content) <= 20000),
  storage_path text,
  selector    text,
  sha256      text,
  captured_at timestamptz not null default now(),
  check (content is not null or storage_path is not null)
);
create index if not exists seo_evidence_audit on public.seo_evidence (audit_id);

-- ---------------------------------------------------------------- findings
create table if not exists public.seo_findings (
  id                  uuid primary key default gen_random_uuid(),
  audit_id            uuid not null references public.seo_audits(id) on delete cascade,
  rule_id             text not null,
  category            text not null check (category in ('technical', 'inventory', 'local', 'content', 'experience', 'performance', 'ai_readiness')),
  title               text not null check (length(title) <= 200),
  status              text not null check (status in ('confirmed', 'opportunity', 'needs_verification')),
  priority            text not null check (priority in ('high', 'medium', 'low')),
  affected_urls       text[] not null default '{}' check (cardinality(affected_urls) >= 1),
  observed_at         timestamptz not null,
  evidence_ids        uuid[] not null default '{}',
  significance        text,
  recommended_fix     text,
  responsible_party   text check (responsible_party in ('website_provider', 'dealership', 'marketing_agency', 'gbp_owner', 'inventory_provider', 'aiae')),
  acceptance_criteria text,
  facts               jsonb not null default '{}'::jsonb,   -- the deterministic values the rule found (prices, VIN, canonicals…)
  drafted_by          text check (drafted_by in ('rule', 'model', 'person')) default 'rule',
  review_status       text not null default 'draft' check (review_status in ('draft', 'approved', 'rejected')),
  reviewed_by         uuid,
  reviewed_at         timestamptz,
  review_note         text,
  created_at          timestamptz not null default now(),
  -- nothing reaches a report without evidence and the full set of fields
  check (review_status <> 'approved' or (cardinality(evidence_ids) >= 1 and significance is not null and recommended_fix is not null
         and responsible_party is not null and acceptance_criteria is not null))
);
create index if not exists seo_findings_audit on public.seo_findings (audit_id, review_status);

create or replace function public.seo_finding_review_stamp() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.review_status is distinct from old.review_status then
    new.reviewed_by := case when new.review_status = 'draft' then null else auth.uid() end;
    new.reviewed_at := case when new.review_status = 'draft' then null else now() end;
  else
    new.reviewed_by := old.reviewed_by; new.reviewed_at := old.reviewed_at;
  end if;
  return new;
end $$;
drop trigger if exists seo_finding_review_stamp on public.seo_findings;
create trigger seo_finding_review_stamp before update on public.seo_findings for each row execute function public.seo_finding_review_stamp();

-- ---------------------------------------------------------------- uploads and reports
create table if not exists public.seo_uploads (
  id           uuid primary key default gen_random_uuid(),
  audit_id     uuid not null references public.seo_audits(id) on delete cascade,
  kind         text not null default 'ai_visibility_snapshot' check (kind in ('ai_visibility_snapshot', 'other')),
  file_name    text not null,
  storage_path text not null,
  extracted    jsonb,     -- parsed as data only; its own methodology kept with it
  uploaded_by  uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

create table if not exists public.seo_reports (
  id           uuid primary key default gen_random_uuid(),
  audit_id     uuid not null references public.seo_audits(id) on delete cascade,
  kind         text not null check (kind in ('detailed_audit', 'executive_summary', 'plan_30_60_90', 'tickets', 'meeting_email')),
  format       text not null check (format in ('pdf', 'html', 'csv', 'md', 'docx', 'json')),
  version      int not null default 1,
  storage_path text not null,
  created_by   uuid default auth.uid(),
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------- row level security: team only
do $$
declare t text;
begin
  foreach t in array array['seo_audits', 'seo_pages', 'seo_links', 'seo_structured_data', 'seo_vehicles_observed', 'seo_evidence',
                           'seo_findings', 'seo_uploads', 'seo_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_team', t);
    execute format('create policy %I on public.%I for all using (public.seo_is_team()) with check (public.seo_is_team())', t || '_team', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end $$;

-- Private file storage for HTML snapshots, screenshots, uploads and reports: <dealership>/<YYYY-MM-DD>/<audit id>/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('seo', 'seo', false, 52428800)
on conflict (id) do nothing;
drop policy if exists seo_files_team on storage.objects;
create policy seo_files_team on storage.objects for all to authenticated
  using (bucket_id = 'seo' and public.seo_is_team()) with check (bucket_id = 'seo' and public.seo_is_team());
