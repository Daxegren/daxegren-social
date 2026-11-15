-- Carousels: a brief can ask for swipeable pages of text instead of an ordinary post.
--   * format: 'post' (default) or 'carousel'
--   * cta_keyword: the word readers are asked to comment on the last page
alter table social_briefs
  add column format text not null default 'post' check (format in ('post', 'carousel')),
  add column cta_keyword text,
  add constraint social_briefs_cta_keyword check (cta_keyword is null or cta_keyword ~ '^[A-Za-z0-9ÅÄÖåäö]{1,30}$');

-- The review app may set both when it creates a request (the existing insert policy still forces status = 'requested').
grant insert (format, cta_keyword) on social_briefs to authenticated;
