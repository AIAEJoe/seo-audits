-- Team-only access, authorization stamping, and the evidence rules on findings.
\set ON_ERROR_STOP 1
create or replace function pg_temp.check(cond boolean, msg text) returns void language plpgsql as $$
begin if not coalesce(cond, false) then raise exception 'FAIL: %', msg; end if; raise notice 'ok: %', msg; end $$;
create or replace function pg_temp.fails(stmt text, want text, msg text) returns void language plpgsql as $$
begin
  begin execute stmt; exception when others then
    if sqlerrm ilike '%' || want || '%' then raise notice 'ok: %', msg; return; end if;
    raise exception 'FAIL: % (wrong error: %)', msg, sqlerrm;
  end;
  raise exception 'FAIL: % (no error)', msg;
end $$;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'joe@aiautoengine.test'),
  ('00000000-0000-0000-0000-0000000000b2', 'sales@dealer.test');
insert into platform_admins (user_id) values ('00000000-0000-0000-0000-0000000000a1');

-- team member
set role authenticated;
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000a1';
insert into seo_audits (dealership_name, site_url) values ('New Smyrna Beach Chevrolet', 'https://www.newsmyrnachevy.com/');
select pg_temp.check((select host from seo_audits) = 'www.newsmyrnachevy.com', 'host is derived from the URL');
select pg_temp.fails($$update seo_audits set status = 'queued'$$, 'check constraint', 'cannot queue an audit before it is authorized');
update seo_audits set authorized = true, authorization_note = 'GM approved by email', authorized_by = '00000000-0000-0000-0000-0000000000b2', authorized_at = '2020-01-01';
select pg_temp.check((select authorized_by = '00000000-0000-0000-0000-0000000000a1' and authorized_at > now() - interval '1 minute' from seo_audits), 'authorization is stamped with who and when, never by hand');
update seo_audits set status = 'queued';
update seo_audits set authorized_by = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.check((select authorized_by from seo_audits) = '00000000-0000-0000-0000-0000000000a1', 'authorization stamp cannot be changed later');
select pg_temp.fails($$insert into seo_audits (dealership_name, site_url) values ('x', 'not a url')$$, 'check constraint', 'site URL must be a web address');
select pg_temp.fails($$insert into seo_audits (dealership_name, site_url) values ('x', 'ftp://dealer.com')$$, 'check constraint', 'only http(s)');

insert into seo_pages (audit_id, url, page_type, status_code) select id, 'https://www.newsmyrnachevy.com/', 'home', 200 from seo_audits;
insert into seo_evidence (audit_id, page_id, kind, url, content) select a.id, p.id, 'html_excerpt', p.url, '<title>Home</title>' from seo_audits a join seo_pages p on p.audit_id = a.id;
select pg_temp.fails($$insert into seo_evidence (audit_id, kind) select id, 'note' from seo_audits$$, 'check constraint', 'evidence needs content or a file');
insert into seo_findings (audit_id, rule_id, category, title, status, priority, affected_urls, observed_at)
select id, 'technical.test', 'technical', 'Test finding', 'confirmed', 'medium', array['https://www.newsmyrnachevy.com/'], now() from seo_audits;
select pg_temp.fails($$insert into seo_findings (audit_id, rule_id, category, title, status, priority, affected_urls, observed_at) select id, 'x', 'technical', 't', 'confirmed', 'low', '{}', now() from seo_audits$$, 'check constraint', 'a finding needs an affected URL');
select pg_temp.fails($$insert into seo_findings (audit_id, rule_id, category, title, status, priority, affected_urls, observed_at) select id, 'x', 'technical', 't', 'probably', 'low', array['u'], now() from seo_audits$$, 'check constraint', 'status is confirmed / opportunity / needs verification');
select pg_temp.fails($$update seo_findings set review_status = 'approved'$$, 'check constraint', 'cannot approve a finding without evidence and the full set of fields');
update seo_findings set evidence_ids = array[(select id from seo_evidence)], significance = 's', recommended_fix = 'f', responsible_party = 'website_provider', acceptance_criteria = 'a';
update seo_findings set review_status = 'approved';
select pg_temp.check((select reviewed_by = '00000000-0000-0000-0000-0000000000a1' and reviewed_at is not null from seo_findings), 'approval records the reviewer');

-- someone signed in but not on the team
set request.jwt.claim.sub = '00000000-0000-0000-0000-0000000000b2';
select pg_temp.check((select count(*) from seo_audits) = 0 and (select count(*) from seo_findings) = 0 and (select count(*) from seo_evidence) = 0, 'non-team users see nothing');
select pg_temp.fails($$insert into seo_audits (dealership_name, site_url) values ('x', 'https://x.com/')$$, 'row-level security', 'non-team users cannot create audits');
update seo_audits set dealership_name = 'hacked';
select pg_temp.check(not public.seo_is_team(), 'not team');

-- anonymous
reset request.jwt.claim.sub;
set role anon;
select pg_temp.fails($$select count(*) from seo_audits$$, 'permission denied', 'anonymous visitors cannot read audits at all');
reset role;
select pg_temp.check((select dealership_name from seo_audits) = 'New Smyrna Beach Chevrolet', 'nothing changed by outsiders');
select pg_temp.check((select public from storage.buckets where id = 'seo') = false, 'report files are private');
delete from seo_audits;
select pg_temp.check((select count(*) from seo_findings) + (select count(*) from seo_pages) + (select count(*) from seo_evidence) = 0, 'deleting an audit removes everything collected for it');
