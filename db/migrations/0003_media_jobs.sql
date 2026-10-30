-- Paid, asynchronous media generation (video). A row is written *before* the provider is called, and the
-- provider's job id is saved right after submitting, so a finished (and paid-for) result can always be collected.

create table social_media_jobs (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null check (kind in ('video')),
  provider            text not null,
  model               text not null,
  prompt              text not null,
  source_image_uri    text,
  provider_job_id     text,
  status              text not null default 'queued' check (status in ('queued', 'in_progress', 'completed', 'failed')),
  estimated_cost_usd  numeric(10, 4) not null,
  actual_cost_usd     numeric(10, 4),
  asset_id            uuid references social_assets (id) on delete set null,
  error               text,
  created_at          timestamptz not null default now(),
  finished_at         timestamptz
);
create index social_media_jobs_active on social_media_jobs (created_at) where status in ('queued', 'in_progress');
create index social_media_jobs_created on social_media_jobs (created_at);

alter table social_media_jobs enable row level security;
create policy admin_read on social_media_jobs for select to authenticated using (social_is_admin());
grant select on social_media_jobs to authenticated;
