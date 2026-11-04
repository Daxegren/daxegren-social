-- Create content from the review app (works from a phone):
--   * upload your own photo/video straight to Supabase Storage and register it as an asset
--   * request drafts for an idea; the worker's `tick` turns the request into drafts
-- Everything the browser can do here is deliberately narrow; the worker keeps using the service role.

-- ── briefs: requests ────────────────────────────────────────────────────────
alter table social_briefs
  add column channels text[],
  add column status text not null default 'ready' check (status in ('requested', 'processing', 'ready', 'failed')),
  add column error text,
  add constraint social_briefs_idea_length check (char_length(idea) between 1 and 2000),
  add constraint social_briefs_angle_goal_length check (char_length(coalesce(angle, '')) <= 500 and char_length(coalesce(goal, '')) <= 500),
  add constraint social_briefs_asset_count check (cardinality(asset_ids) <= 20),
  add constraint social_briefs_requested_valid check (
    status <> 'requested' or (
      channels is not null
      and cardinality(channels) between 1 and 8
      and channels <@ array['instagram', 'tiktok', 'facebook', 'linkedin', 'pinterest', 'youtube', 'snapchat', 'x']::text[]
    )
  );
create index social_briefs_requested on social_briefs (created_at) where status = 'requested';

-- A reviewer may create a brief only as a request. Processing and results are written by the worker.
create policy admin_request on social_briefs for insert to authenticated
  with check (social_is_admin() and status = 'requested');
grant insert (idea, angle, goal, asset_ids, channels, status) on social_briefs to authenticated;

-- ── assets: own uploads ─────────────────────────────────────────────────────
-- A reviewer may register a file as "captured" only if it lives in this project's public media folder.
create policy admin_add_capture on social_assets for insert to authenticated
  with check (
    social_is_admin()
    and origin = 'captured'
    and kind in ('image', 'video')
    and uri ~ '^https://[A-Za-z0-9.-]+/storage/v1/object/public/social-media/uploads/[A-Za-z0-9._/-]+$'
  );
grant insert (kind, origin, uri, meta) on social_assets to authenticated;

-- ── storage ─────────────────────────────────────────────────────────────────
-- Public bucket: Instagram, LinkedIn etc. fetch media from a public URL. Paths are unguessable.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('social-media', 'social-media', true, 52428800, array['image/*', 'video/*'])
on conflict (id) do update set public = true;

-- Reviewers can upload only into uploads/<their own user id>/.
create policy social_media_upload on storage.objects for insert to authenticated
  with check (
    bucket_id = 'social-media'
    and social_is_admin()
    and (storage.foldername(name))[1] = 'uploads'
    and (storage.foldername(name))[2] = auth.uid()::text
  );
