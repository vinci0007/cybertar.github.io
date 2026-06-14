create table if not exists public.model_verify_reports (
  domain text primary key,
  provider_name text not null,
  homepage text not null,
  shared_at timestamptz not null default now(),
  submitter_github_id text not null default '',
  submitter_login text not null default '',
  submitter_name text not null default '',
  submitter_avatar_url text not null default '',
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.site_visit_stats (
  stat_key text primary key,
  total_count bigint not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists public.site_online_visitors (
  visitor_id text primary key,
  page_path text not null default '/',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists site_online_visitors_last_seen_idx
on public.site_online_visitors (last_seen_at);

create or replace function public.model_verify_homepage_domain(homepage text)
returns text
language sql
immutable
as $$
  select lower(
    regexp_replace(
      split_part(
        regexp_replace(coalesce(homepage, ''), '^https?://', '', 'i'),
        '/',
        1
      ),
      '^www\.',
      '',
      'i'
    )
  );
$$;

create or replace function public.touch_model_verify_reports_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists touch_model_verify_reports_updated_at on public.model_verify_reports;

create trigger touch_model_verify_reports_updated_at
before update on public.model_verify_reports
for each row
execute function public.touch_model_verify_reports_updated_at();

alter table public.model_verify_reports enable row level security;

drop policy if exists "model verify reports are readable" on public.model_verify_reports;
create policy "model verify reports are readable"
on public.model_verify_reports
for select
to anon
using (true);

drop policy if exists "model verify reports can be inserted" on public.model_verify_reports;
create policy "model verify reports can be inserted"
on public.model_verify_reports
for insert
to anon
with check (
  domain = public.model_verify_homepage_domain(homepage)
  and length(domain) > 0
);

drop policy if exists "model verify reports can be upserted by domain" on public.model_verify_reports;
create policy "model verify reports can be upserted by domain"
on public.model_verify_reports
for update
to anon
using (true)
with check (
  domain = public.model_verify_homepage_domain(homepage)
  and length(domain) > 0
);
