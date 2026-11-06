-- Work that was claimed by a worker that then died must not stay invisible.
--   * claimed_at records when a variant moved to 'publishing' or a brief to 'processing'
--   * social_retry_variant lets a reviewer put a failed post back in the queue from the app
alter table social_variants add column claimed_at timestamptz;
alter table social_briefs add column claimed_at timestamptz;

-- A reviewer retries a failed post. This is a function (not an UPDATE grant) because it must also reset the attempt
-- counter and the error, which the app is deliberately not allowed to write directly.
create function social_retry_variant(p_id uuid) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not social_is_admin() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  update social_variants
     set status = 'scheduled', attempts = 0, scheduled_at = now(), last_error = null, claimed_at = null
   where id = p_id and status = 'failed';
  if not found then
    raise exception 'variant % is not a failed variant', p_id using errcode = 'P0002';
  end if;
end
$$;
revoke all on function social_retry_variant(uuid) from public;
grant execute on function social_retry_variant(uuid) to authenticated;
