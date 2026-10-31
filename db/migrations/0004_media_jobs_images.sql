-- Image generation is recorded as a media job too, so it counts against the same monthly cap.
alter table social_media_jobs drop constraint social_media_jobs_kind_check;
alter table social_media_jobs add constraint social_media_jobs_kind_check check (kind in ('video', 'image'));
