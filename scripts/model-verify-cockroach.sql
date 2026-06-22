create table if not exists model_verify_reports (
  domain string not null,
  target_model string not null default '',
  provider_name string not null,
  homepage string not null,
  shared_at timestamptz not null default now(),
  submitter_github_id string not null default '',
  submitter_login string not null default '',
  submitter_name string not null default '',
  submitter_avatar_url string not null default '',
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (domain, target_model)
);

create table if not exists model_verify_pending_reports (
  pending_key string primary key,
  domain string not null,
  target_model string not null,
  submitter_hash string not null,
  provider_name string not null,
  homepage string not null,
  score float8 not null,
  submitter_github_id string not null default '',
  submitter_login string not null default '',
  submitter_name string not null default '',
  submitter_avatar_url string not null default '',
  report jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists model_verify_submission_limits (
  rate_key string primary key,
  window_start timestamptz not null,
  updated_at timestamptz not null default now()
);

create table if not exists model_verify_sessions (
  session_hash string primary key,
  github_id string not null,
  github_login string not null,
  github_name string not null default '',
  avatar_url string not null default '',
  role string not null default 'user',
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists model_verify_discussions (
  id string primary key,
  domain string not null,
  target_model string not null,
  body string not null,
  author_id string not null,
  author_login string not null,
  author_name string not null default '',
  author_avatar_url string not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists site_visit_stats (
  stat_key string primary key,
  total_count int8 not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists site_online_visitors (
  visitor_id string primary key,
  page_path string not null default '/',
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index if not exists model_verify_reports_shared_at_idx
  on model_verify_reports (shared_at desc);

create index if not exists model_verify_pending_reports_expires_at_idx
  on model_verify_pending_reports (expires_at);

create index if not exists model_verify_submission_limits_updated_at_idx
  on model_verify_submission_limits (updated_at);

create index if not exists model_verify_discussions_lookup_idx
  on model_verify_discussions (domain, target_model, deleted_at, created_at);

create index if not exists site_online_visitors_last_seen_idx
  on site_online_visitors (last_seen_at);
