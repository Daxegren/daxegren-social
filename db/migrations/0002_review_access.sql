-- Access for the David OS review queue (browser, authenticated Supabase users).
--
-- Only users listed in social_admins can read the social_* tables, and the only
-- write they get is reviewing a draft: edit its text/time and move it to
-- 'scheduled' or 'rejected'. Everything else (creating briefs, publishing,
-- retries, metrics) runs with the service role and bypasses RLS.
--
-- Add yourself after your first sign-in:
--   insert into social_admins (user_id) values ('<your auth.users id>');

create table social_admins (
  user_id uuid primary key references auth.users (id) on delete cascade
);
alter table social_admins enable row level security;
-- no policies: only the service role / SQL editor manages this table

create function social_is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from social_admins where user_id = auth.uid())
$$;
revoke all on function social_is_admin() from public;
grant execute on function social_is_admin() to authenticated;

create policy admin_read on social_assets   for select to authenticated using (social_is_admin());
create policy admin_read on social_posts    for select to authenticated using (social_is_admin());
create policy admin_read on social_briefs   for select to authenticated using (social_is_admin());
create policy admin_read on social_variants for select to authenticated using (social_is_admin());

-- Review: only drafts can be changed, and only into scheduled / rejected (or left as draft while editing).
create policy admin_review on social_variants for update to authenticated
  using (social_is_admin() and status = 'draft')
  with check (social_is_admin() and status in ('draft', 'scheduled', 'rejected'));

grant select on social_assets, social_posts, social_briefs, social_variants to authenticated;
revoke update on social_variants from authenticated;
grant update (body, scheduled_at, status) on social_variants to authenticated;
