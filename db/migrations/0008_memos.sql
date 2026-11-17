-- Voice memos: a recording (or pasted text) becomes a transcript, the transcript becomes ideas, the ideas become drafts.
-- Only the transcript is kept, never the audio. One memo per Drive file, so a file is never transcribed twice.
create table social_memos (
  id             uuid primary key default gen_random_uuid(),
  source         text not null check (source in ('drive', 'cli')),
  drive_file_id  text unique,
  name           text not null,
  transcript     text,
  status         text not null default 'transcribed' check (status in ('transcribed', 'planning', 'planned', 'failed')),
  error          text,
  attempts       int not null default 0,
  idea_count     int not null default 0,
  claimed_at     timestamptz,
  created_at     timestamptz not null default now()
);
create index social_memos_open on social_memos (created_at) where status in ('transcribed', 'planning');

alter table social_memos enable row level security;
create policy admin_read on social_memos for select to authenticated using (social_is_admin());
grant select on social_memos to authenticated;

-- Which memo an idea came from.
alter table social_briefs add column memo_id uuid references social_memos (id) on delete set null;
