-- Schema for the Postgres/Supabase-backed Store. Mirrors src/domain.ts.
-- Row level security is enabled with no policies: only the service role (the
-- scheduler / edge functions) can touch these tables. Add per-user policies
-- when David OS exposes them to the browser.

create table social_assets (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('image', 'video')),
  origin      text not null check (origin in ('captured', 'generated')),
  uri         text not null,
  meta        jsonb,
  created_at  timestamptz not null default now()
);

create table social_posts (
  id            uuid primary key default gen_random_uuid(),
  channel       text not null,
  external_id   text not null,
  url           text,
  body          text not null,
  media_kinds   text[] not null default '{}',
  published_at  timestamptz not null,
  metrics       jsonb,
  variant_id    uuid,
  unique (channel, external_id)
);
create index social_posts_channel_published on social_posts (channel, published_at desc);

create table social_briefs (
  id               uuid primary key default gen_random_uuid(),
  idea             text not null,
  angle            text,
  goal             text,
  source_post_ids  uuid[] not null default '{}',
  asset_ids        uuid[] not null default '{}',
  created_at       timestamptz not null default now()
);

create table social_variants (
  id            uuid primary key default gen_random_uuid(),
  brief_id      uuid not null references social_briefs (id) on delete cascade,
  channel       text not null,
  body          text not null,
  asset_ids     uuid[] not null default '{}',
  status        text not null default 'draft'
                check (status in ('draft', 'scheduled', 'publishing', 'published', 'failed', 'rejected')),
  rationale     text,
  scheduled_at  timestamptz,
  attempts      int not null default 0,
  last_error    text,
  external_id   text,
  url           text,
  published_at  timestamptz,
  created_at    timestamptz not null default now()
);
create index social_variants_due on social_variants (scheduled_at) where status = 'scheduled';

alter table social_posts
  add constraint social_posts_variant_fk foreign key (variant_id) references social_variants (id) on delete set null;

alter table social_assets   enable row level security;
alter table social_posts    enable row level security;
alter table social_briefs   enable row level security;
alter table social_variants enable row level security;

-- Claim used by the Postgres Store's transitionVariant(): a single atomic UPDATE,
-- so two workers can never both move the same variant to 'publishing'.
--   update social_variants set status = $3 where id = $1 and status = $2 returning *;
