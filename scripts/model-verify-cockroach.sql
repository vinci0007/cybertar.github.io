create table if not exists model_verify_reports (
  domain string not null,
  target_model string not null default '',
  provider_name string not null,
  homepage string not null,
  shared_at timestamptz not null default now(),
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
